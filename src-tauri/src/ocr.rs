use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
};

use image::{imageops::FilterType, DynamicImage, ImageDecoder};

pub(crate) const OCR_PNG_MAX_BYTES: usize = 64 * 1024 * 1024;
const OCR_DIMENSION_MAX: u32 = 8_192;
const OCR_PIXEL_MAX: u64 = 40_000_000;
const OCR_DECODER_MAX_BYTES: u64 = 192 * 1024 * 1024;
pub(crate) const OCR_TEXT_MAX_BYTES: usize = 256 * 1024;
const OCR_RUNTIME_CAPACITY: usize = 8;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OcrFailure {
    Oversized,
    Decode,
    Winrt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OcrOutcome {
    Completed(String),
    Unavailable,
    Oversized,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreparedImage {
    width: u32,
    height: u32,
    gray8: Vec<u8>,
}

fn validate_image_dimensions(width: u32, height: u32) -> Result<(), OcrFailure> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(OcrFailure::Oversized)?;
    let rgba_bytes = pixels.checked_mul(4).ok_or(OcrFailure::Oversized)?;
    if width == 0
        || height == 0
        || width > OCR_DIMENSION_MAX
        || height > OCR_DIMENSION_MAX
        || pixels > OCR_PIXEL_MAX
        || rgba_bytes > OCR_DECODER_MAX_BYTES
    {
        return Err(OcrFailure::Oversized);
    }
    Ok(())
}

fn decode_png_gray8(png: &[u8]) -> Result<PreparedImage, OcrFailure> {
    if png.len() > OCR_PNG_MAX_BYTES {
        return Err(OcrFailure::Oversized);
    }
    if !png.starts_with(PNG_SIGNATURE) {
        return Err(OcrFailure::Decode);
    }
    let decoder =
        image::codecs::png::PngDecoder::new(Cursor::new(png)).map_err(|_| OcrFailure::Decode)?;
    let (width, height) = decoder.dimensions();
    validate_image_dimensions(width, height)?;
    if decoder.total_bytes() > OCR_DECODER_MAX_BYTES {
        return Err(OcrFailure::Oversized);
    }
    let gray = DynamicImage::from_decoder(decoder)
        .map_err(|_| OcrFailure::Decode)?
        .into_luma8();
    Ok(PreparedImage {
        width,
        height,
        gray8: gray.into_raw(),
    })
}

fn resize_for_engine(
    image: PreparedImage,
    max_dimension: u32,
) -> Result<PreparedImage, OcrFailure> {
    if max_dimension == 0 {
        return Err(OcrFailure::Winrt);
    }
    let longest = image.width.max(image.height);
    if longest <= max_dimension {
        return Ok(image);
    }
    let width =
        ((u64::from(image.width) * u64::from(max_dimension)) / u64::from(longest)).max(1) as u32;
    let height =
        ((u64::from(image.height) * u64::from(max_dimension)) / u64::from(longest)).max(1) as u32;
    let source = image::GrayImage::from_raw(image.width, image.height, image.gray8)
        .ok_or(OcrFailure::Decode)?;
    let resized = image::imageops::resize(&source, width, height, FilterType::Triangle);
    Ok(PreparedImage {
        width,
        height,
        gray8: resized.into_raw(),
    })
}

#[cfg(test)]
fn preprocess_png(png: &[u8], max_dimension: u32) -> Result<PreparedImage, OcrFailure> {
    resize_for_engine(decode_png_gray8(png)?, max_dimension)
}

pub(crate) fn normalize_ocr_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len().min(OCR_TEXT_MAX_BYTES));
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\0' => {}
            '\r' => {
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                normalized.push_str("\r\n");
            }
            '\n' => normalized.push_str("\r\n"),
            other => normalized.push(other),
        }
    }
    if normalized.len() > OCR_TEXT_MAX_BYTES {
        let mut end = OCR_TEXT_MAX_BYTES;
        while !normalized.is_char_boundary(end) {
            end -= 1;
        }
        normalized.truncate(end);
    }
    if normalized.ends_with('\r') {
        normalized.pop();
    }
    normalized
}

pub(crate) fn ocr_text_is_canonical(value: &str) -> bool {
    if value.len() > OCR_TEXT_MAX_BYTES || value.as_bytes().contains(&0) {
        return false;
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => index += 2,
            b'\r' | b'\n' => return false,
            _ => index += 1,
        }
    }
    true
}

trait OcrEngineAdapter: Send + 'static {
    fn initialize_mta(&mut self) -> Result<(), OcrFailure>;
    fn uninitialize_mta(&mut self);
    fn max_image_dimension(&mut self) -> Result<u32, OcrFailure>;
    fn recognize_gray8(&mut self, image: &PreparedImage) -> Result<Option<String>, OcrFailure>;
}

struct OcrJob {
    png: Vec<u8>,
    reply: mpsc::Sender<Result<OcrOutcome, OcrFailure>>,
}

#[derive(Clone)]
pub(crate) struct OcrRuntime {
    sender: SyncSender<OcrJob>,
    outstanding: Arc<AtomicUsize>,
    gate: Arc<Mutex<OcrGate>>,
}

#[derive(Clone, Copy, Debug)]
struct OcrGate {
    enabled: bool,
    generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OcrSubmitError {
    Disabled,
    QueueFull,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OcrReceiveError {
    Disabled,
    Disconnected,
}

pub(crate) struct OcrPermit {
    outstanding: Arc<AtomicUsize>,
    gate: Arc<Mutex<OcrGate>>,
    generation: u64,
}

impl OcrPermit {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    fn is_current(&self) -> bool {
        self.gate
            .lock()
            .map(|gate| gate.enabled && gate.generation == self.generation)
            .unwrap_or(false)
    }
}

impl Drop for OcrPermit {
    fn drop(&mut self) {
        self.outstanding.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) struct OcrTicket {
    receiver: Receiver<Result<OcrOutcome, OcrFailure>>,
    gate: Arc<Mutex<OcrGate>>,
    submitted_generation: u64,
    permit: OcrPermit,
}

impl OcrTicket {
    pub(crate) fn wait(
        self,
    ) -> (
        Result<Result<OcrOutcome, OcrFailure>, OcrReceiveError>,
        OcrPermit,
    ) {
        let Self {
            receiver,
            gate,
            submitted_generation,
            permit,
        } = self;
        let result = receiver
            .recv()
            .map_err(|_| OcrReceiveError::Disconnected)
            .and_then(|result| {
                let current = gate.lock().map_err(|_| OcrReceiveError::Disabled)?;
                if !current.enabled || current.generation != submitted_generation {
                    return Err(OcrReceiveError::Disabled);
                }
                Ok(result)
            });
        (result, permit)
    }
}

impl OcrRuntime {
    pub(crate) fn new() -> Result<Self, OcrFailure> {
        Self::with_adapter(default_adapter())
    }

    fn with_adapter(adapter: Box<dyn OcrEngineAdapter>) -> Result<Self, OcrFailure> {
        let (sender, receiver) = mpsc::sync_channel(OCR_RUNTIME_CAPACITY);
        let outstanding = Arc::new(AtomicUsize::new(0));
        thread::Builder::new()
            .name("quickpaste-ocr-mta".to_owned())
            .spawn(move || run_worker(receiver, adapter))
            .map_err(|_| OcrFailure::Winrt)?;
        Ok(Self {
            sender,
            outstanding,
            gate: Arc::new(Mutex::new(OcrGate {
                enabled: true,
                generation: 0,
            })),
        })
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        if let Ok(mut gate) = self.gate.lock() {
            if gate.enabled != enabled {
                gate.enabled = enabled;
                gate.generation = gate.generation.wrapping_add(1);
            }
        }
    }

    pub(crate) fn invalidate(&self) -> bool {
        let Ok(mut gate) = self.gate.lock() else {
            return false;
        };
        gate.generation = gate.generation.wrapping_add(1);
        true
    }

    pub(crate) fn enabled_generation(&self) -> Option<u64> {
        let gate = self.gate.lock().ok()?;
        gate.enabled.then_some(gate.generation)
    }

    /// Holds the same gate used by `set_enabled` until the final mutation returns.
    /// This makes disable and the database compare-and-set linearisable.
    pub(crate) fn commit_if_current<T>(
        &self,
        expected_generation: u64,
        commit: impl FnOnce() -> T,
    ) -> Option<T> {
        let gate = self.gate.lock().ok()?;
        if !gate.enabled || gate.generation != expected_generation {
            return None;
        }
        Some(commit())
    }

    pub(crate) fn try_reserve(&self) -> Result<OcrPermit, OcrSubmitError> {
        let generation = self.enabled_generation().ok_or(OcrSubmitError::Disabled)?;
        self.outstanding
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < OCR_RUNTIME_CAPACITY).then_some(count + 1)
            })
            .map_err(|_| OcrSubmitError::QueueFull)?;
        let permit = OcrPermit {
            outstanding: self.outstanding.clone(),
            gate: self.gate.clone(),
            generation,
        };
        if !permit.is_current() {
            return Err(OcrSubmitError::Disabled);
        }
        Ok(permit)
    }

    pub(crate) fn submit_reserved(
        &self,
        permit: OcrPermit,
        png: Vec<u8>,
    ) -> Result<OcrTicket, OcrSubmitError> {
        if !Arc::ptr_eq(&permit.outstanding, &self.outstanding)
            || !Arc::ptr_eq(&permit.gate, &self.gate)
            || !permit.is_current()
        {
            return Err(OcrSubmitError::Disabled);
        }
        let (reply, receiver) = mpsc::channel();
        match self.sender.try_send(OcrJob { png, reply }) {
            Ok(()) => Ok(OcrTicket {
                receiver,
                gate: self.gate.clone(),
                submitted_generation: permit.generation,
                permit,
            }),
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                Err(OcrSubmitError::QueueFull)
            }
        }
    }
}

fn run_worker(receiver: Receiver<OcrJob>, mut adapter: Box<dyn OcrEngineAdapter>) {
    let initialized = adapter.initialize_mta().is_ok();
    for job in receiver {
        let outcome = if initialized {
            recognize_one(job.png, adapter.as_mut())
        } else {
            Err(OcrFailure::Winrt)
        };
        let _ = job.reply.send(outcome);
    }
    if initialized {
        adapter.uninitialize_mta();
    }
}

fn recognize_one(
    png: Vec<u8>,
    adapter: &mut dyn OcrEngineAdapter,
) -> Result<OcrOutcome, OcrFailure> {
    let decoded = match decode_png_gray8(&png) {
        Ok(image) => image,
        Err(OcrFailure::Oversized) => return Ok(OcrOutcome::Oversized),
        Err(error) => return Err(error),
    };
    let max_dimension = adapter.max_image_dimension()?;
    let prepared = resize_for_engine(decoded, max_dimension)?;
    match adapter.recognize_gray8(&prepared)? {
        Some(text) => Ok(OcrOutcome::Completed(normalize_ocr_text(&text))),
        None => Ok(OcrOutcome::Unavailable),
    }
}

#[cfg(not(target_os = "windows"))]
struct PlatformAdapter;

#[cfg(not(target_os = "windows"))]
impl OcrEngineAdapter for PlatformAdapter {
    fn initialize_mta(&mut self) -> Result<(), OcrFailure> {
        Ok(())
    }
    fn uninitialize_mta(&mut self) {}
    fn max_image_dimension(&mut self) -> Result<u32, OcrFailure> {
        Ok(OCR_DIMENSION_MAX)
    }
    fn recognize_gray8(&mut self, _image: &PreparedImage) -> Result<Option<String>, OcrFailure> {
        Ok(None)
    }
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct PlatformAdapter {
    initialized: bool,
}

#[cfg(target_os = "windows")]
impl OcrEngineAdapter for PlatformAdapter {
    fn initialize_mta(&mut self) -> Result<(), OcrFailure> {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| OcrFailure::Winrt)?;
        self.initialized = true;
        Ok(())
    }

    fn uninitialize_mta(&mut self) {
        if self.initialized {
            unsafe { windows::Win32::System::WinRT::RoUninitialize() };
            self.initialized = false;
        }
    }

    fn max_image_dimension(&mut self) -> Result<u32, OcrFailure> {
        windows::Media::Ocr::OcrEngine::MaxImageDimension().map_err(|_| OcrFailure::Winrt)
    }

    fn recognize_gray8(&mut self, image: &PreparedImage) -> Result<Option<String>, OcrFailure> {
        use windows::{
            core::Interface,
            Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
            Media::Ocr::OcrEngine,
            Storage::Streams::DataWriter,
        };

        let engine = match OcrEngine::TryCreateFromUserProfileLanguages() {
            Ok(engine) => engine,
            // The projection represents WinRT's null "no compatible language"
            // result as E_POINTER. This is an expected local-unavailable state.
            Err(error) if error.code().0 == 0x8000_4003_u32 as i32 => return Ok(None),
            Err(_) => return Err(OcrFailure::Winrt),
        };
        if Interface::as_raw(&engine).is_null() {
            return Ok(None);
        }
        let writer = DataWriter::new().map_err(|_| OcrFailure::Winrt)?;
        writer
            .WriteBytes(&image.gray8)
            .map_err(|_| OcrFailure::Winrt)?;
        let buffer = writer.DetachBuffer().map_err(|_| OcrFailure::Winrt)?;
        let width = i32::try_from(image.width).map_err(|_| OcrFailure::Oversized)?;
        let height = i32::try_from(image.height).map_err(|_| OcrFailure::Oversized)?;
        let bitmap =
            SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Gray8, width, height)
                .map_err(|_| OcrFailure::Winrt)?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .and_then(|operation| operation.get())
            .map_err(|_| OcrFailure::Winrt)?;
        let text = result.Text().map_err(|_| OcrFailure::Winrt)?;
        Ok(Some(text.to_string()))
    }
}

#[cfg(not(target_os = "windows"))]
fn default_adapter() -> Box<dyn OcrEngineAdapter> {
    Box::new(PlatformAdapter)
}

#[cfg(target_os = "windows")]
fn default_adapter() -> Box<dyn OcrEngineAdapter> {
    Box::new(PlatformAdapter::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GrayImage, ImageFormat, Luma};
    use std::{
        io::Cursor,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
        time::Duration,
    };

    fn gray_png(width: u32, height: u32) -> Vec<u8> {
        let image = GrayImage::from_pixel(width, height, Luma([127]));
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageLuma8(image)
            .write_to(&mut output, ImageFormat::Png)
            .expect("encode PNG fixture");
        output.into_inner()
    }

    #[test]
    fn output_normalization_uses_crlf_strips_nul_and_caps_on_a_utf8_boundary() {
        assert_eq!(normalize_ocr_text("a\rb\nc\r\nd\0e"), "a\r\nb\r\nc\r\nde");
        let oversized = "界".repeat((OCR_TEXT_MAX_BYTES / 3) + 10);
        let normalized = normalize_ocr_text(&oversized);
        assert!(normalized.len() <= OCR_TEXT_MAX_BYTES);
        assert!(normalized.is_char_boundary(normalized.len()));
        let cr_at_limit = format!("{}\nx", "a".repeat(OCR_TEXT_MAX_BYTES - 1));
        let normalized = normalize_ocr_text(&cr_at_limit);
        assert!(!normalized.ends_with('\r'));
    }

    #[test]
    fn png_preprocessing_is_gray8_and_resizes_only_the_ocr_copy() {
        let source = gray_png(8, 4);
        let prepared = preprocess_png(&source, 4).expect("prepare OCR image");
        assert_eq!((prepared.width, prepared.height), (4, 2));
        assert_eq!(prepared.gray8.len(), 8);
        assert_eq!(source, gray_png(8, 4), "stored bytes remain untouched");
    }

    #[test]
    fn hard_limits_reject_before_unsafe_allocations() {
        assert_eq!(
            validate_image_dimensions(8_193, 1),
            Err(OcrFailure::Oversized)
        );
        assert_eq!(
            validate_image_dimensions(8_000, 8_000),
            Err(OcrFailure::Oversized)
        );
        assert_eq!(
            preprocess_png(&vec![0; OCR_PNG_MAX_BYTES + 1], 4),
            Err(OcrFailure::Oversized)
        );
        assert_eq!(preprocess_png(b"not png", 4), Err(OcrFailure::Decode));
    }

    #[derive(Clone)]
    enum FakeBehavior {
        Text(&'static str),
        Unavailable,
        Failure,
        Blocking(Arc<Mutex<mpsc::Receiver<()>>>),
    }

    #[derive(Default)]
    struct FakeCounters {
        initialized: AtomicUsize,
        uninitialized: AtomicUsize,
        max_dimension: AtomicUsize,
        recognize: AtomicUsize,
        active: AtomicUsize,
        maximum_active: AtomicUsize,
    }

    struct FakeAdapter {
        behavior: FakeBehavior,
        counters: Arc<FakeCounters>,
        fail_initialization: bool,
        uninitialized: Option<mpsc::Sender<()>>,
    }

    impl FakeAdapter {
        fn new(behavior: FakeBehavior, counters: Arc<FakeCounters>) -> Self {
            Self {
                behavior,
                counters,
                fail_initialization: false,
                uninitialized: None,
            }
        }
    }

    impl OcrEngineAdapter for FakeAdapter {
        fn initialize_mta(&mut self) -> Result<(), OcrFailure> {
            self.counters.initialized.fetch_add(1, Ordering::SeqCst);
            if self.fail_initialization {
                Err(OcrFailure::Winrt)
            } else {
                Ok(())
            }
        }

        fn uninitialize_mta(&mut self) {
            self.counters.uninitialized.fetch_add(1, Ordering::SeqCst);
            if let Some(notify) = self.uninitialized.take() {
                let _ = notify.send(());
            }
        }

        fn max_image_dimension(&mut self) -> Result<u32, OcrFailure> {
            self.counters.max_dimension.fetch_add(1, Ordering::SeqCst);
            Ok(4_096)
        }

        fn recognize_gray8(
            &mut self,
            _image: &PreparedImage,
        ) -> Result<Option<String>, OcrFailure> {
            self.counters.recognize.fetch_add(1, Ordering::SeqCst);
            let active = self.counters.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.counters
                .maximum_active
                .fetch_max(active, Ordering::SeqCst);
            let result = match &self.behavior {
                FakeBehavior::Text(text) => Ok(Some((*text).to_owned())),
                FakeBehavior::Unavailable => Ok(None),
                FakeBehavior::Failure => Err(OcrFailure::Winrt),
                FakeBehavior::Blocking(release) => {
                    release
                        .lock()
                        .expect("release lock")
                        .recv()
                        .expect("release worker");
                    Ok(Some("serial".to_owned()))
                }
            };
            self.counters.active.fetch_sub(1, Ordering::SeqCst);
            result
        }
    }

    #[test]
    fn fake_adapter_covers_available_unavailable_failed_empty_and_skips_oversized() {
        let png = gray_png(2, 2);
        for (behavior, expected) in [
            (
                FakeBehavior::Text("hello\nworld"),
                Ok(OcrOutcome::Completed("hello\r\nworld".into())),
            ),
            (FakeBehavior::Unavailable, Ok(OcrOutcome::Unavailable)),
            (FakeBehavior::Failure, Err(OcrFailure::Winrt)),
            (
                FakeBehavior::Text(""),
                Ok(OcrOutcome::Completed(String::new())),
            ),
        ] {
            let counters = Arc::new(FakeCounters::default());
            let mut adapter = FakeAdapter::new(behavior, counters);
            assert_eq!(recognize_one(png.clone(), &mut adapter), expected);
        }

        let counters = Arc::new(FakeCounters::default());
        let mut adapter = FakeAdapter::new(FakeBehavior::Text("must not run"), counters.clone());
        assert_eq!(
            recognize_one(gray_png(OCR_DIMENSION_MAX + 1, 1), &mut adapter),
            Ok(OcrOutcome::Oversized)
        );
        assert_eq!(counters.max_dimension.load(Ordering::SeqCst), 0);
        assert_eq!(counters.recognize.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn worker_is_single_concurrency_bounds_total_outstanding_at_eight_and_balances_mta() {
        let counters = Arc::new(FakeCounters::default());
        let (release_tx, release_rx) = mpsc::channel();
        let (uninitialized_tx, uninitialized_rx) = mpsc::channel();
        let mut adapter = FakeAdapter::new(
            FakeBehavior::Blocking(Arc::new(Mutex::new(release_rx))),
            counters.clone(),
        );
        adapter.uninitialized = Some(uninitialized_tx);
        let runtime = OcrRuntime::with_adapter(Box::new(adapter)).expect("start fake worker");
        let png = gray_png(2, 2);
        let jobs = (0..OCR_RUNTIME_CAPACITY)
            .map(|_| {
                let permit = runtime.try_reserve().expect("within total capacity");
                runtime
                    .submit_reserved(permit, png.clone())
                    .expect("submit reserved work")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            runtime.try_reserve().err(),
            Some(OcrSubmitError::QueueFull),
            "ninth outstanding job is rejected"
        );
        for _ in 0..OCR_RUNTIME_CAPACITY {
            release_tx.send(()).expect("release serial worker");
        }
        for ticket in jobs {
            let (result, _permit) = ticket.wait();
            assert_eq!(
                result.expect("enabled worker reply"),
                Ok(OcrOutcome::Completed("serial".into()))
            );
        }
        assert_eq!(counters.maximum_active.load(Ordering::SeqCst), 1);
        assert_eq!(
            counters.recognize.load(Ordering::SeqCst),
            OCR_RUNTIME_CAPACITY
        );
        drop(runtime);
        uninitialized_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker uninitializes after sender closes");
        assert_eq!(counters.initialized.load(Ordering::SeqCst), 1);
        assert_eq!(counters.uninitialized.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn command_permits_bound_preload_work_before_any_worker_submission() {
        let counters = Arc::new(FakeCounters::default());
        let runtime = OcrRuntime::with_adapter(Box::new(FakeAdapter::new(
            FakeBehavior::Text("must not run"),
            counters.clone(),
        )))
        .expect("start fake worker");

        let mut permits = (0..OCR_RUNTIME_CAPACITY)
            .map(|_| runtime.try_reserve().expect("reserve bounded command"))
            .collect::<Vec<_>>();
        assert_eq!(
            runtime.try_reserve().err(),
            Some(OcrSubmitError::QueueFull),
            "the ninth command must fail before loading or submitting an image"
        );
        assert_eq!(counters.recognize.load(Ordering::SeqCst), 0);

        permits.pop();
        permits.push(runtime.try_reserve().expect("RAII drop releases capacity"));
        assert_eq!(counters.recognize.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn failed_mta_initialization_never_uninitializes_and_returns_content_free_failure() {
        let counters = Arc::new(FakeCounters::default());
        let mut adapter = FakeAdapter::new(FakeBehavior::Text("unused"), counters.clone());
        adapter.fail_initialization = true;
        let runtime = OcrRuntime::with_adapter(Box::new(adapter)).expect("start fake worker");
        let permit = runtime.try_reserve().expect("reserve worker request");
        let ticket = runtime
            .submit_reserved(permit, gray_png(1, 1))
            .expect("queue worker request");
        let (result, _permit) = ticket.wait();
        assert_eq!(
            result.expect("enabled worker failure"),
            Err(OcrFailure::Winrt)
        );
        drop(runtime);
        assert_eq!(counters.initialized.load(Ordering::SeqCst), 1);
        assert_eq!(counters.uninitialized.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn disabling_mid_flight_invalidates_the_ticket_before_any_database_patch() {
        let counters = Arc::new(FakeCounters::default());
        let (release_tx, release_rx) = mpsc::channel();
        let adapter = FakeAdapter::new(
            FakeBehavior::Blocking(Arc::new(Mutex::new(release_rx))),
            counters,
        );
        let runtime = OcrRuntime::with_adapter(Box::new(adapter)).expect("start fake worker");
        let permit = runtime.try_reserve().expect("reserve enabled job");
        let ticket = runtime
            .submit_reserved(permit, gray_png(2, 2))
            .expect("submit enabled job");
        runtime.set_enabled(false);
        release_tx.send(()).expect("release in-flight worker");
        let (result, _permit) = ticket.wait();
        assert_eq!(result, Err(OcrReceiveError::Disabled));
        assert_eq!(runtime.try_reserve().err(), Some(OcrSubmitError::Disabled));
    }

    #[test]
    fn commit_gate_closes_the_final_check_to_database_patch_race() {
        let counters = Arc::new(FakeCounters::default());
        let runtime = OcrRuntime::with_adapter(Box::new(FakeAdapter::new(
            FakeBehavior::Text("unused"),
            counters,
        )))
        .expect("start fake worker");
        let original_generation = runtime.enabled_generation().expect("OCR starts enabled");

        runtime.set_enabled(false);
        let mut committed = false;
        assert_eq!(
            runtime.commit_if_current(original_generation, || {
                committed = true;
                1
            }),
            None
        );
        assert!(!committed, "disable before the final commit must skip SQL");

        runtime.set_enabled(true);
        let current_generation = runtime.enabled_generation().expect("OCR is enabled again");
        assert_ne!(current_generation, original_generation);
        assert_eq!(
            runtime.commit_if_current(original_generation, || 2),
            None,
            "re-enabling must not revive an older command generation"
        );
        assert_eq!(runtime.commit_if_current(current_generation, || 3), Some(3));
    }

    #[test]
    fn lifecycle_invalidation_preserves_enabled_state_but_rejects_every_old_commit() {
        let counters = Arc::new(FakeCounters::default());
        let runtime = OcrRuntime::with_adapter(Box::new(FakeAdapter::new(
            FakeBehavior::Text("unused"),
            counters,
        )))
        .expect("start fake worker");
        let before_restore = runtime.enabled_generation().expect("OCR starts enabled");

        assert!(runtime.invalidate());
        let after_restore = runtime
            .enabled_generation()
            .expect("lifecycle invalidation must not disable OCR");
        assert_ne!(after_restore, before_restore);
        assert_eq!(
            runtime.commit_if_current(before_restore, || "old database"),
            None
        );
        assert_eq!(
            runtime.commit_if_current(after_restore, || "restored database"),
            Some("restored database")
        );
    }
}
