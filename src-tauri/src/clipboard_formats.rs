use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

pub(crate) const MAX_FORMAT_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_FILES: usize = 256;
pub(crate) const MAX_RTF_BASE64_INPUT_BYTES: usize = MAX_FORMAT_BYTES.div_ceil(3) * 4;
pub(crate) const MAX_CLIPBOARD_IMAGE_SOURCE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_CLIPBOARD_IMAGE_DIMENSION: usize = 8_192;
pub(crate) const MAX_CLIPBOARD_IMAGE_PIXELS: usize = 40_000_000;
const MAX_FILE_PATH_UTF16_UNITS: usize = 32_766;
const MAX_FILE_LIST_BYTES: usize = 8 * 1024 * 1024;
const DROPFILES_HEADER_BYTES: usize = 20;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ClipboardFormatKind {
    Text,
    Html,
    Rtf,
    Image,
    Files,
}

impl ClipboardFormatKind {
    fn rank(self) -> u8 {
        match self {
            Self::Text => 0,
            Self::Html => 1,
            Self::Rtf => 2,
            Self::Image => 3,
            Self::Files => 4,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturedFile {
    pub(crate) path: String,
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) modified_at: Option<String>,
    pub(crate) directory: bool,
    pub(crate) exists: bool,
}

impl CapturedFile {
    fn missing(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref();
        Self {
            path: path.to_string_lossy().into_owned(),
            name: file_name(path),
            extension: file_extension(path),
            size: None,
            modified_at: None,
            directory: false,
            exists: false,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct FormatPackage {
    pub(crate) plain_text: Option<String>,
    pub(crate) html: Option<String>,
    pub(crate) rtf: Option<Vec<u8>>,
    pub(crate) files: Vec<CapturedFile>,
    pub(crate) omitted_formats: Vec<ClipboardFormatKind>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagePayload {
    pub(crate) kind: &'static str,
    pub(crate) content: String,
    pub(crate) formats: Vec<ClipboardFormatKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rtf_base64: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) files: Vec<CapturedFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PackageReadOutcome {
    Captured {
        package: FormatPackage,
        sequence: Option<u64>,
    },
    Ignored {
        package: FormatPackage,
        sequence: Option<u64>,
    },
    Retryable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClipboardFormatProbe<T> {
    Absent,
    Present(T),
    Failed,
}

pub(crate) trait ClipboardFormatReader {
    fn probe_plain_text(&self) -> ClipboardFormatProbe<usize>;
    fn read_plain_text(&self) -> Result<Option<String>, ()>;
    fn probe_html(&self) -> ClipboardFormatProbe<usize>;
    fn read_html(&self) -> Result<Option<String>, ()>;
    fn probe_rtf(&self) -> ClipboardFormatProbe<usize>;
    fn read_rtf(&self) -> Result<Option<Vec<u8>>, ()>;
    fn probe_image(&self) -> ClipboardFormatProbe<usize>;
    fn probe_files(&self) -> ClipboardFormatProbe<usize>;
    fn read_files(&self) -> Result<Option<Vec<String>>, ()>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileMetadataSnapshot {
    pub(crate) directory: bool,
    pub(crate) size: Option<u64>,
    pub(crate) modified_at: Option<String>,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn file_extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|extension| extension.to_string_lossy().into_owned())
        .filter(|extension| !extension.is_empty())
}

pub(crate) fn capture_file_metadata(
    paths: &[PathBuf],
    metadata: impl Fn(&Path) -> Option<FileMetadataSnapshot>,
) -> Vec<CapturedFile> {
    paths
        .iter()
        .map(|path| match metadata(path) {
            Some(metadata) => CapturedFile {
                path: path.to_string_lossy().into_owned(),
                name: file_name(path),
                extension: file_extension(path),
                size: metadata.size,
                modified_at: metadata.modified_at,
                directory: metadata.directory,
                exists: true,
            },
            None => CapturedFile::missing(path),
        })
        .collect()
}

fn system_metadata(path: &Path) -> Option<FileMetadataSnapshot> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileMetadataSnapshot {
        directory: metadata.is_dir(),
        size: metadata.is_file().then_some(metadata.len()),
        modified_at: metadata.modified().ok().map(|modified| {
            chrono::DateTime::<chrono::Utc>::from(modified)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        }),
    })
}

fn push_omitted(package: &mut FormatPackage, format: ClipboardFormatKind) {
    if !package.omitted_formats.contains(&format) {
        package.omitted_formats.push(format);
        package
            .omitted_formats
            .sort_by_key(|candidate| candidate.rank());
    }
}

pub(crate) fn capture_package_from(
    reader: &impl ClipboardFormatReader,
) -> Result<FormatPackage, ()> {
    let mut package = FormatPackage::default();
    let plain_retryable = match reader.probe_plain_text() {
        ClipboardFormatProbe::Absent => false,
        ClipboardFormatProbe::Failed => {
            push_omitted(&mut package, ClipboardFormatKind::Text);
            true
        }
        ClipboardFormatProbe::Present(size) if size > MAX_FORMAT_BYTES => {
            push_omitted(&mut package, ClipboardFormatKind::Text);
            false
        }
        ClipboardFormatProbe::Present(_) => match reader.read_plain_text() {
            Ok(Some(text)) if !text.is_empty() && text.len() <= MAX_FORMAT_BYTES => {
                package.plain_text = Some(text);
                false
            }
            Ok(None) | Ok(Some(_)) => {
                push_omitted(&mut package, ClipboardFormatKind::Text);
                false
            }
            Err(()) => {
                push_omitted(&mut package, ClipboardFormatKind::Text);
                true
            }
        },
    };

    match reader.probe_html() {
        ClipboardFormatProbe::Absent => {}
        ClipboardFormatProbe::Failed => push_omitted(&mut package, ClipboardFormatKind::Html),
        ClipboardFormatProbe::Present(size) if size > MAX_FORMAT_BYTES => {
            push_omitted(&mut package, ClipboardFormatKind::Html)
        }
        ClipboardFormatProbe::Present(_) => match reader.read_html() {
            Ok(Some(html)) if !html.is_empty() => package.html = Some(html),
            Ok(_) | Err(()) => push_omitted(&mut package, ClipboardFormatKind::Html),
        },
    }

    match reader.probe_rtf() {
        ClipboardFormatProbe::Absent => {}
        ClipboardFormatProbe::Failed => push_omitted(&mut package, ClipboardFormatKind::Rtf),
        ClipboardFormatProbe::Present(size) if size > MAX_FORMAT_BYTES => {
            push_omitted(&mut package, ClipboardFormatKind::Rtf)
        }
        ClipboardFormatProbe::Present(_) => match reader.read_rtf() {
            Ok(Some(rtf)) if !rtf.is_empty() => package.rtf = Some(rtf),
            Ok(_) | Err(()) => push_omitted(&mut package, ClipboardFormatKind::Rtf),
        },
    }

    match reader.probe_image() {
        ClipboardFormatProbe::Absent
        | ClipboardFormatProbe::Present(0..=MAX_CLIPBOARD_IMAGE_SOURCE_BYTES) => {}
        ClipboardFormatProbe::Failed | ClipboardFormatProbe::Present(_) => {
            push_omitted(&mut package, ClipboardFormatKind::Image)
        }
    }

    match reader.probe_files() {
        ClipboardFormatProbe::Absent => {}
        ClipboardFormatProbe::Failed | ClipboardFormatProbe::Present(0) => return Err(()),
        ClipboardFormatProbe::Present(count) if count > MAX_FILES => {
            push_omitted(&mut package, ClipboardFormatKind::Files)
        }
        ClipboardFormatProbe::Present(count) => match reader.read_files() {
            Ok(Some(paths)) if paths.len() == count && paths.len() <= MAX_FILES => {
                let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
                package.files = paths.iter().map(CapturedFile::missing).collect();
            }
            Ok(_) | Err(()) => return Err(()),
        },
    }

    if !package.files.is_empty() {
        package.plain_text = None;
        package.html = None;
        package.rtf = None;
    } else if plain_retryable {
        return Err(());
    } else if package.plain_text.is_none() {
        if package.html.take().is_some() {
            push_omitted(&mut package, ClipboardFormatKind::Html);
        }
        if package.rtf.take().is_some() {
            push_omitted(&mut package, ClipboardFormatKind::Rtf);
        }
    }

    Ok(package)
}

pub(crate) fn clipboard_rgba_layout_is_safe(width: usize, height: usize, byte_len: usize) -> bool {
    if width == 0
        || height == 0
        || width > MAX_CLIPBOARD_IMAGE_DIMENSION
        || height > MAX_CLIPBOARD_IMAGE_DIMENSION
    {
        return false;
    }
    let Some(pixels) = width.checked_mul(height) else {
        return false;
    };
    let Some(expected_bytes) = pixels.checked_mul(4) else {
        return false;
    };
    pixels <= MAX_CLIPBOARD_IMAGE_PIXELS
        && expected_bytes <= MAX_CLIPBOARD_IMAGE_SOURCE_BYTES
        && byte_len == expected_bytes
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
enum WindowsImageEncoding {
    Png,
    DibV5,
}

#[cfg(target_os = "windows")]
fn encoded_windows_image_dimensions_are_safe(encoding: WindowsImageEncoding, bytes: &[u8]) -> bool {
    let (width, height) = match encoding {
        WindowsImageEncoding::Png => {
            if bytes.len() < 24
                || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
                || u32::from_be_bytes(bytes[8..12].try_into().unwrap_or_default()) != 13
                || &bytes[12..16] != b"IHDR"
            {
                return false;
            }
            (
                u32::from_be_bytes(bytes[16..20].try_into().unwrap_or_default()) as usize,
                u32::from_be_bytes(bytes[20..24].try_into().unwrap_or_default()) as usize,
            )
        }
        WindowsImageEncoding::DibV5 => {
            if bytes.len() < 124 {
                return false;
            }
            let header_size =
                u32::from_le_bytes(bytes[..4].try_into().unwrap_or_default()) as usize;
            if !(40..=bytes.len()).contains(&header_size) {
                return false;
            }
            let width = i32::from_le_bytes(bytes[4..8].try_into().unwrap_or_default());
            let height = i32::from_le_bytes(bytes[8..12].try_into().unwrap_or_default());
            if width <= 0 || height == 0 {
                return false;
            }
            (width as usize, height.unsigned_abs() as usize)
        }
    };
    let Some(byte_len) = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
    else {
        return false;
    };
    clipboard_rgba_layout_is_safe(width, height, byte_len)
}

#[cfg(target_os = "windows")]
fn probe_windows_image_format(
    format: u32,
    encoding: WindowsImageEncoding,
) -> ClipboardFormatProbe<usize> {
    if !clipboard_win::raw::is_format_avail(format) {
        return ClipboardFormatProbe::Absent;
    }
    let Some(size) = clipboard_win::raw::size(format).map(|size| size.get()) else {
        return ClipboardFormatProbe::Failed;
    };
    if size == 0 || size > MAX_CLIPBOARD_IMAGE_SOURCE_BYTES {
        return ClipboardFormatProbe::Present(MAX_CLIPBOARD_IMAGE_SOURCE_BYTES + 1);
    }
    let mut bytes = Vec::new();
    if clipboard_win::raw::get_vec(format, &mut bytes).is_err() {
        return ClipboardFormatProbe::Failed;
    }
    if bytes.len() > MAX_CLIPBOARD_IMAGE_SOURCE_BYTES
        || !encoded_windows_image_dimensions_are_safe(encoding, &bytes)
    {
        return ClipboardFormatProbe::Present(MAX_CLIPBOARD_IMAGE_SOURCE_BYTES + 1);
    }
    ClipboardFormatProbe::Present(size.max(bytes.len()))
}

fn enrich_file_metadata(
    package: &mut FormatPackage,
    metadata: impl Fn(&Path) -> Option<FileMetadataSnapshot>,
) {
    if package.files.is_empty() {
        return;
    }
    let paths = package
        .files
        .iter()
        .map(|file| PathBuf::from(&file.path))
        .collect::<Vec<_>>();
    package.files = capture_file_metadata(&paths, metadata);
}

fn read_package_with_guard<G>(
    guard: G,
    reader: &impl ClipboardFormatReader,
    before: Option<u64>,
    observe_after: impl FnOnce() -> Option<u64>,
    metadata: impl Fn(&Path) -> Option<FileMetadataSnapshot>,
) -> PackageReadOutcome {
    let result = capture_package_from(reader).map_err(|()| "系统剪贴板必需格式读取失败".to_owned());
    drop(guard);
    let after = observe_after();
    let mut outcome = classify_package_read(before, after, result);
    if let PackageReadOutcome::Captured { package, .. } = &mut outcome {
        enrich_file_metadata(package, metadata);
    }
    outcome
}

pub(crate) fn package_payload(package: &FormatPackage) -> Option<PackagePayload> {
    if !package.files.is_empty() {
        return Some(PackagePayload {
            kind: "file",
            content: package
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            formats: vec![ClipboardFormatKind::Files],
            html: None,
            rtf_base64: None,
            files: package.files.clone(),
        });
    }

    let plain_text = package.plain_text.as_ref()?.clone();
    let mut formats = vec![ClipboardFormatKind::Text];
    if package.html.is_some() {
        formats.push(ClipboardFormatKind::Html);
    }
    if package.rtf.is_some() {
        formats.push(ClipboardFormatKind::Rtf);
    }
    Some(PackagePayload {
        kind: "text",
        content: plain_text,
        formats,
        html: package.html.clone(),
        rtf_base64: package.rtf.as_ref().map(|rtf| STANDARD.encode(rtf)),
        files: Vec::new(),
    })
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in (bytes.len() as u64).to_le_bytes().iter().chain(bytes) {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn hash_optional(hash: &mut u64, value: Option<&[u8]>) {
    match value {
        Some(value) => {
            hash_bytes(hash, &[1]);
            hash_bytes(hash, value);
        }
        None => hash_bytes(hash, &[0]),
    }
}

fn formats_signature(plain_text: Option<&[u8]>, html: Option<&[u8]>, rtf: Option<&[u8]>) -> u64 {
    let mut hash = 0xcbf29ce484222325;
    hash_bytes(&mut hash, b"formats");
    hash_optional(&mut hash, plain_text);
    hash_optional(&mut hash, html);
    hash_optional(&mut hash, rtf);
    hash
}

pub(crate) fn plain_text_signature(plain_text: &str) -> u64 {
    formats_signature(Some(plain_text.as_bytes()), None, None)
}

pub(crate) fn package_signature(package: &FormatPackage) -> u64 {
    if !package.files.is_empty() {
        let mut hash = 0xcbf29ce484222325;
        hash_bytes(&mut hash, b"files");
        for file in &package.files {
            hash_bytes(&mut hash, file.path.as_bytes());
        }
        return hash;
    }

    formats_signature(
        package.plain_text.as_ref().map(|text| text.as_bytes()),
        package.html.as_ref().map(|html| html.as_bytes()),
        package.rtf.as_deref(),
    )
}

pub(crate) fn classify_package_read(
    before: Option<u64>,
    after: Option<u64>,
    result: Result<FormatPackage, String>,
) -> PackageReadOutcome {
    if before != after {
        return PackageReadOutcome::Retryable;
    }
    match result {
        Ok(package) if package_payload(&package).is_some() => PackageReadOutcome::Captured {
            package,
            sequence: after,
        },
        Ok(package) => PackageReadOutcome::Ignored {
            package,
            sequence: after,
        },
        Err(_) => PackageReadOutcome::Retryable,
    }
}

pub(crate) fn package_matches_requested(expected: &FormatPackage, actual: &FormatPackage) -> bool {
    if !expected.files.is_empty() {
        return expected.files.len() == actual.files.len()
            && expected
                .files
                .iter()
                .zip(&actual.files)
                .all(|(expected, actual)| expected.path == actual.path);
    }

    expected.plain_text == actual.plain_text
        && expected
            .html
            .as_ref()
            .is_none_or(|html| actual.html.as_ref() == Some(html))
        && expected
            .rtf
            .as_ref()
            .is_none_or(|rtf| actual.rtf.as_ref() == Some(rtf))
}

pub(crate) fn verified_package_sequence(
    before: Option<u64>,
    expected: &FormatPackage,
    actual: Option<&FormatPackage>,
    after: Option<u64>,
) -> Option<u64> {
    match (before, actual, after) {
        (Some(before), Some(actual), Some(after))
            if before == after && package_matches_requested(expected, actual) =>
        {
            Some(after)
        }
        _ => None,
    }
}

pub(crate) fn prepare_format_package(
    plain_text: &str,
    html: Option<&str>,
    rtf_base64: Option<&str>,
) -> Result<FormatPackage, String> {
    if plain_text.is_empty() || plain_text.contains('\0') {
        return Err("纯文本不能为空或包含 NUL".into());
    }
    let html = match html {
        Some("") => None,
        Some(html) if html.len() > MAX_FORMAT_BYTES || html.contains('\0') => {
            return Err("HTML 格式超过 8 MiB 或包含 NUL".into())
        }
        Some(html) => Some(html.to_owned()),
        None => None,
    };
    let rtf = match rtf_base64 {
        Some("") => None,
        Some(encoded) if encoded.len() > MAX_RTF_BASE64_INPUT_BYTES => {
            return Err("RTF 格式超过 8 MiB".into())
        }
        Some(encoded) => {
            let decoded = STANDARD
                .decode(encoded)
                .map_err(|_| "RTF base64 无效".to_owned())?;
            if decoded.len() > MAX_FORMAT_BYTES || decoded.is_empty() {
                return Err("RTF 格式为空或超过 8 MiB".into());
            }
            Some(decoded)
        }
        None => None,
    };
    Ok(FormatPackage {
        plain_text: Some(plain_text.to_owned()),
        html,
        rtf,
        ..FormatPackage::default()
    })
}

pub(crate) fn prepare_file_package(paths: &[String]) -> Result<FormatPackage, String> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err("文件列表必须包含 1 到 256 个路径".into());
    }
    if paths
        .iter()
        .any(|path| path.trim().is_empty() || path.contains('\0'))
    {
        return Err("文件路径不能为空或包含 NUL".into());
    }
    if paths.iter().any(|path| {
        !is_fully_qualified_windows_path(path)
            || path.encode_utf16().count() > MAX_FILE_PATH_UTF16_UNITS
    }) {
        return Err("文件路径必须是受限长度的 Windows 完全限定路径".into());
    }
    let total_bytes = checked_hdrop_bytes(paths).ok_or_else(|| "文件列表大小溢出".to_owned())?;
    if total_bytes > MAX_FILE_LIST_BYTES {
        return Err("文件列表超过 8 MiB".into());
    }
    let paths = paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    Ok(FormatPackage {
        files: paths.iter().map(CapturedFile::missing).collect(),
        ..FormatPackage::default()
    })
}

fn is_fully_qualified_windows_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\");
    if normalized.starts_with("\\\\?\\")
        || normalized.starts_with("\\\\.\\")
        || normalized.starts_with("\\\\??\\")
    {
        return false;
    }

    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return true;
    }
    let Some(remainder) = normalized.strip_prefix("\\\\") else {
        return false;
    };
    let mut components = remainder.split('\\');
    matches!(
        (components.next(), components.next()),
        (Some(server), Some(share))
            if !server.is_empty()
                && !share.is_empty()
                && server != "."
                && server != "?"
                && server != "??"
    )
}

fn checked_hdrop_bytes(paths: &[String]) -> Option<usize> {
    paths
        .iter()
        .try_fold(DROPFILES_HEADER_BYTES.checked_add(2)?, |total, path| {
            let path_bytes = path.encode_utf16().count().checked_add(1)?.checked_mul(2)?;
            total.checked_add(path_bytes)
        })
}

#[cfg(target_os = "windows")]
struct WindowsClipboardReader {
    html_format: Option<clipboard_win::formats::Html>,
    rtf_format: Option<u32>,
    png_format: Option<u32>,
}

#[cfg(target_os = "windows")]
impl ClipboardFormatReader for WindowsClipboardReader {
    fn probe_plain_text(&self) -> ClipboardFormatProbe<usize> {
        use clipboard_win::formats;

        if !clipboard_win::raw::is_format_avail(formats::CF_UNICODETEXT) {
            return ClipboardFormatProbe::Absent;
        }
        clipboard_win::raw::size(formats::CF_UNICODETEXT)
            .map(|size| ClipboardFormatProbe::Present(size.get()))
            .unwrap_or(ClipboardFormatProbe::Failed)
    }

    fn read_plain_text(&self) -> Result<Option<String>, ()> {
        use clipboard_win::{formats, raw, Getter as _};

        if !raw::is_format_avail(formats::CF_UNICODETEXT) {
            return Ok(None);
        }
        let mut text = String::new();
        formats::Unicode.read_clipboard(&mut text).map_err(|_| ())?;
        Ok(Some(text.trim_end_matches('\0').to_owned()))
    }

    fn probe_html(&self) -> ClipboardFormatProbe<usize> {
        use clipboard_win::formats::Format as _;

        let Some(html) = self.html_format.as_ref() else {
            return ClipboardFormatProbe::Failed;
        };
        if !html.is_format_avail() {
            return ClipboardFormatProbe::Absent;
        }
        clipboard_win::raw::size(html.code())
            .map(|size| ClipboardFormatProbe::Present(size.get()))
            .unwrap_or(ClipboardFormatProbe::Failed)
    }

    fn read_html(&self) -> Result<Option<String>, ()> {
        use clipboard_win::{formats::Format as _, Getter as _};

        let Some(html_format) = &self.html_format else {
            return Ok(None);
        };
        if !html_format.is_format_avail() {
            return Ok(None);
        }
        let mut html = String::new();
        html_format.read_clipboard(&mut html).map_err(|_| ())?;
        Ok(Some(html.trim_end_matches('\0').to_owned()))
    }

    fn probe_rtf(&self) -> ClipboardFormatProbe<usize> {
        let Some(format) = self.rtf_format else {
            return ClipboardFormatProbe::Failed;
        };
        if !clipboard_win::raw::is_format_avail(format) {
            return ClipboardFormatProbe::Absent;
        }
        clipboard_win::raw::size(format)
            .map(|size| ClipboardFormatProbe::Present(size.get()))
            .unwrap_or(ClipboardFormatProbe::Failed)
    }

    fn read_rtf(&self) -> Result<Option<Vec<u8>>, ()> {
        let Some(format) = self.rtf_format else {
            return Ok(None);
        };
        if !clipboard_win::raw::is_format_avail(format) {
            return Ok(None);
        }
        let mut rtf = Vec::new();
        clipboard_win::raw::get_vec(format, &mut rtf).map_err(|_| ())?;
        Ok(Some(rtf))
    }

    fn probe_image(&self) -> ClipboardFormatProbe<usize> {
        // arboard 3.6 在 Windows 上先读注册的 PNG，再读 CF_DIBV5；探针保持同样顺序。
        const CF_DIBV5: u32 = 17;
        let Some(png_format) = self.png_format else {
            return ClipboardFormatProbe::Failed;
        };
        match probe_windows_image_format(png_format, WindowsImageEncoding::Png) {
            ClipboardFormatProbe::Absent => {
                probe_windows_image_format(CF_DIBV5, WindowsImageEncoding::DibV5)
            }
            outcome => outcome,
        }
    }

    fn probe_files(&self) -> ClipboardFormatProbe<usize> {
        use clipboard_win::formats::CF_HDROP;

        if !clipboard_win::raw::is_format_avail(CF_HDROP) {
            return ClipboardFormatProbe::Absent;
        }
        clipboard_file_count()
            .map(ClipboardFormatProbe::Present)
            .unwrap_or(ClipboardFormatProbe::Failed)
    }

    fn read_files(&self) -> Result<Option<Vec<String>>, ()> {
        use clipboard_win::{formats::FileList, formats::Format as _};

        if !FileList.is_format_avail() {
            return Ok(None);
        }
        let mut files = Vec::new();
        clipboard_win::raw::get_file_list(&mut files).map_err(|_| ())?;
        Ok(Some(files))
    }
}

#[cfg(target_os = "windows")]
fn clipboard_file_count() -> Result<usize, ()> {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetClipboardData(format: u32) -> *mut core::ffi::c_void;
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn DragQueryFileW(
            drop: *mut core::ffi::c_void,
            file: u32,
            output: *mut u16,
            characters: u32,
        ) -> u32;
    }

    let drop = unsafe { GetClipboardData(clipboard_win::formats::CF_HDROP) };
    if drop.is_null() {
        return Err(());
    }
    Ok(unsafe { DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0) as usize })
}

#[cfg(target_os = "windows")]
pub(crate) fn read_format_package() -> PackageReadOutcome {
    let html_format = clipboard_win::formats::Html::new();
    let rtf_format = clipboard_win::raw::register_format("Rich Text Format").map(|code| code.get());
    let png_format = clipboard_win::raw::register_format("PNG").map(|code| code.get());
    let before = clipboard_win::raw::seq_num().map(|sequence| u64::from(sequence.get()));
    let guard = match clipboard_win::Clipboard::new() {
        Ok(guard) => guard,
        Err(_) => return PackageReadOutcome::Retryable,
    };
    read_package_with_guard(
        guard,
        &WindowsClipboardReader {
            html_format,
            rtf_format,
            png_format,
        },
        before,
        || clipboard_win::raw::seq_num().map(|sequence| u64::from(sequence.get())),
        system_metadata,
    )
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_format_package() -> PackageReadOutcome {
    PackageReadOutcome::Retryable
}

#[cfg(target_os = "windows")]
pub(crate) fn write_format_package(package: &FormatPackage) -> Result<(), String> {
    use clipboard_win::options::NoClear;

    let html_format = package
        .html
        .as_ref()
        .map(|_| clipboard_win::formats::Html::new().ok_or("无法注册 HTML Format"))
        .transpose()?;
    let rtf_format = package
        .rtf
        .as_ref()
        .map(|_| {
            clipboard_win::raw::register_format("Rich Text Format")
                .map(|format| format.get())
                .ok_or("无法注册 Rich Text Format")
        })
        .transpose()?;
    let _guard = clipboard_win::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard_win::raw::empty().map_err(|error| error.to_string())?;

    if !package.files.is_empty() {
        let paths = package
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        return clipboard_win::raw::set_file_list(&paths).map_err(|error| error.to_string());
    }

    let plain_text = package.plain_text.as_deref().ok_or("格式包缺少纯文本")?;
    clipboard_win::raw::set_string_with(plain_text, NoClear).map_err(|error| error.to_string())?;
    if let (Some(format), Some(html)) = (html_format, package.html.as_deref()) {
        clipboard_win::raw::set_html(format.code(), html).map_err(|error| error.to_string())?;
    }
    if let (Some(format), Some(rtf)) = (rtf_format, package.rtf.as_deref()) {
        clipboard_win::raw::set_without_clear(format, rtf).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn write_format_package(_package: &FormatPackage) -> Result<(), String> {
    Err("当前平台不支持 Windows 剪贴板格式包".into())
}

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        path::PathBuf,
    };

    use base64::{engine::general_purpose::STANDARD, Engine as _};

    use super::*;

    struct FakeReader {
        plain: Result<Option<String>, ()>,
        plain_probe: Option<ClipboardFormatProbe<usize>>,
        html_probe: ClipboardFormatProbe<usize>,
        html: Result<Option<String>, ()>,
        rtf_probe: ClipboardFormatProbe<usize>,
        rtf: Result<Option<Vec<u8>>, ()>,
        image_probe: ClipboardFormatProbe<usize>,
        file_probe: ClipboardFormatProbe<usize>,
        files: Result<Option<Vec<String>>, ()>,
        plain_reads: Cell<usize>,
        html_reads: Cell<usize>,
        rtf_reads: Cell<usize>,
        file_reads: Cell<usize>,
    }

    impl Default for FakeReader {
        fn default() -> Self {
            Self {
                plain: Ok(None),
                plain_probe: None,
                html_probe: ClipboardFormatProbe::Absent,
                html: Ok(None),
                rtf_probe: ClipboardFormatProbe::Absent,
                rtf: Ok(None),
                image_probe: ClipboardFormatProbe::Absent,
                file_probe: ClipboardFormatProbe::Absent,
                files: Ok(None),
                plain_reads: Cell::new(0),
                html_reads: Cell::new(0),
                rtf_reads: Cell::new(0),
                file_reads: Cell::new(0),
            }
        }
    }

    impl ClipboardFormatReader for FakeReader {
        fn probe_plain_text(&self) -> ClipboardFormatProbe<usize> {
            self.plain_probe.unwrap_or_else(|| match &self.plain {
                Ok(Some(text)) => ClipboardFormatProbe::Present(
                    text.encode_utf16()
                        .count()
                        .saturating_add(1)
                        .saturating_mul(2),
                ),
                Ok(None) => ClipboardFormatProbe::Absent,
                Err(()) => ClipboardFormatProbe::Failed,
            })
        }

        fn read_plain_text(&self) -> Result<Option<String>, ()> {
            self.plain_reads.set(self.plain_reads.get() + 1);
            self.plain.clone()
        }

        fn probe_html(&self) -> ClipboardFormatProbe<usize> {
            self.html_probe
        }

        fn read_html(&self) -> Result<Option<String>, ()> {
            self.html_reads.set(self.html_reads.get() + 1);
            self.html.clone()
        }

        fn probe_rtf(&self) -> ClipboardFormatProbe<usize> {
            self.rtf_probe
        }

        fn read_rtf(&self) -> Result<Option<Vec<u8>>, ()> {
            self.rtf_reads.set(self.rtf_reads.get() + 1);
            self.rtf.clone()
        }

        fn probe_image(&self) -> ClipboardFormatProbe<usize> {
            self.image_probe
        }

        fn probe_files(&self) -> ClipboardFormatProbe<usize> {
            self.file_probe
        }

        fn read_files(&self) -> Result<Option<Vec<String>>, ()> {
            self.file_reads.set(self.file_reads.get() + 1);
            self.files.clone()
        }
    }

    fn rich_package() -> FormatPackage {
        FormatPackage {
            plain_text: Some("QuickPaste".into()),
            html: Some("<b>QuickPaste</b>".into()),
            rtf: Some(br"{\rtf1 QuickPaste}".to_vec()),
            ..FormatPackage::default()
        }
    }

    #[test]
    fn package_signatures_are_stable_and_distinguish_every_format_and_file_order() {
        let baseline = rich_package();
        assert_eq!(package_signature(&baseline), package_signature(&baseline));

        let mut changed_plain = baseline.clone();
        changed_plain.plain_text = Some("quickpaste".into());
        let mut changed_html = baseline.clone();
        changed_html.html = Some("<i>QuickPaste</i>".into());
        let mut changed_rtf = baseline.clone();
        changed_rtf.rtf = Some(br"{\rtf1\b QuickPaste}".to_vec());
        let first = CapturedFile::missing("C:\\Fixtures\\first.txt");
        let second = CapturedFile::missing("C:\\Fixtures\\second.txt");
        let files_forward = FormatPackage {
            files: vec![first.clone(), second.clone()],
            ..FormatPackage::default()
        };
        let files_reverse = FormatPackage {
            files: vec![second, first],
            ..FormatPackage::default()
        };

        for changed in [
            changed_plain,
            changed_html,
            changed_rtf,
            files_forward.clone(),
        ] {
            assert_ne!(package_signature(&baseline), package_signature(&changed));
        }
        assert_ne!(
            package_signature(&files_forward),
            package_signature(&files_reverse)
        );
    }

    #[test]
    fn plain_html_and_rtf_map_to_one_searchable_payload_with_fixed_format_order() {
        let package = rich_package();
        let payload = package_payload(&package).expect("plain text makes the record searchable");

        assert_eq!(payload.kind, "text");
        assert_eq!(payload.content, "QuickPaste");
        assert_eq!(
            payload.formats,
            vec![
                ClipboardFormatKind::Text,
                ClipboardFormatKind::Html,
                ClipboardFormatKind::Rtf,
            ]
        );
        assert_eq!(payload.html.as_deref(), Some("<b>QuickPaste</b>"));
        assert_eq!(
            STANDARD
                .decode(payload.rtf_base64.expect("RTF base64"))
                .unwrap(),
            br"{\rtf1 QuickPaste}"
        );
    }

    #[test]
    fn file_metadata_preserves_order_and_distinguishes_directory_file_and_missing() {
        let paths = vec![
            PathBuf::from("C:\\Fixtures\\first.txt"),
            PathBuf::from("C:\\Fixtures\\folder"),
            PathBuf::from("C:\\Fixtures\\missing.bin"),
        ];
        let probed = Cell::new(0);

        let files = capture_file_metadata(&paths, |path| {
            probed.set(probed.get() + 1);
            match path.file_name().and_then(|name| name.to_str()) {
                Some("first.txt") => Some(FileMetadataSnapshot {
                    directory: false,
                    size: Some(12),
                    modified_at: Some("2026-07-19T02:00:00.000Z".into()),
                }),
                Some("folder") => Some(FileMetadataSnapshot {
                    directory: true,
                    size: None,
                    modified_at: None,
                }),
                _ => None,
            }
        });

        assert_eq!(probed.get(), 3);
        assert_eq!(
            files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            ["first.txt", "folder", "missing.bin",]
        );
        assert_eq!(
            (files[0].directory, files[0].exists, files[0].size),
            (false, true, Some(12))
        );
        assert_eq!(
            (files[1].directory, files[1].exists, files[1].size),
            (true, true, None)
        );
        assert_eq!(
            (files[2].directory, files[2].exists, files[2].size),
            (false, false, None)
        );
    }

    #[test]
    fn limits_are_checked_before_optional_format_or_file_allocation() {
        let reader = FakeReader {
            plain: Ok(Some("仍保留纯文本".into())),
            html_probe: ClipboardFormatProbe::Present(MAX_FORMAT_BYTES + 1),
            html: Ok(Some("不应读取".into())),
            rtf_probe: ClipboardFormatProbe::Present(MAX_FORMAT_BYTES + 1),
            rtf: Ok(Some(vec![1])),
            file_probe: ClipboardFormatProbe::Present(MAX_FILES + 1),
            files: Ok(Some(vec!["C:\\Fixtures\\not-read.txt".into()])),
            ..FakeReader::default()
        };

        let package = capture_package_from(&reader).expect("oversized optional formats degrade");

        assert_eq!(package.plain_text.as_deref(), Some("仍保留纯文本"));
        assert_eq!(reader.html_reads.get(), 0);
        assert_eq!(reader.rtf_reads.get(), 0);
        assert_eq!(reader.file_reads.get(), 0);
        assert_eq!(
            package.omitted_formats,
            vec![
                ClipboardFormatKind::Html,
                ClipboardFormatKind::Rtf,
                ClipboardFormatKind::Files,
            ]
        );
    }

    #[test]
    fn unicode_text_is_rejected_before_reading_when_cf_allocation_exceeds_eight_mib() {
        let reader = FakeReader {
            plain: Ok(Some("不应分配或读取".into())),
            plain_probe: Some(ClipboardFormatProbe::Present(MAX_FORMAT_BYTES + 1)),
            ..FakeReader::default()
        };

        let package = capture_package_from(&reader).expect("oversized text is a terminal omission");
        assert_eq!(reader.plain_reads.get(), 0);
        assert_eq!(package.omitted_formats, vec![ClipboardFormatKind::Text]);
        assert_eq!(MAX_FORMAT_BYTES, 8 * 1024 * 1024);
    }

    #[test]
    fn unicode_text_expanding_past_utf8_limit_is_omitted_without_retry() {
        let reader = FakeReader {
            plain: Ok(Some("界".repeat((MAX_FORMAT_BYTES / 3) + 1))),
            plain_probe: Some(ClipboardFormatProbe::Present(
                (MAX_FORMAT_BYTES / 3 + 2) * 2,
            )),
            ..FakeReader::default()
        };

        let package = capture_package_from(&reader).expect("decoded UTF-8 overflow is terminal");

        assert_eq!(reader.plain_reads.get(), 1);
        assert_eq!(package.omitted_formats, vec![ClipboardFormatKind::Text]);
    }

    #[test]
    fn oversized_windows_image_allocation_is_omitted_before_arboard_fallback() {
        let reader = FakeReader {
            image_probe: ClipboardFormatProbe::Present(MAX_CLIPBOARD_IMAGE_SOURCE_BYTES + 1),
            ..FakeReader::default()
        };

        let package = capture_package_from(&reader).expect("oversized DIB degrades to omission");

        assert_eq!(package.omitted_formats, vec![ClipboardFormatKind::Image]);
        assert_eq!(MAX_CLIPBOARD_IMAGE_SOURCE_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn decoded_rgba_layout_is_checked_by_dimension_pixels_bytes_and_exact_length() {
        assert!(clipboard_rgba_layout_is_safe(
            4_096,
            4_096,
            64 * 1024 * 1024
        ));
        assert!(!clipboard_rgba_layout_is_safe(8_193, 1, 8_193 * 4));
        assert!(!clipboard_rgba_layout_is_safe(
            4_097,
            4_096,
            4_097 * 4_096 * 4
        ));
        assert!(!clipboard_rgba_layout_is_safe(usize::MAX, 2, 0));
        assert!(!clipboard_rgba_layout_is_safe(1, 1, 3));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn encoded_windows_image_headers_are_bounded_before_arboard_decode() {
        let mut png = vec![0_u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[8..12].copy_from_slice(&13_u32.to_be_bytes());
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&4_096_u32.to_be_bytes());
        png[20..24].copy_from_slice(&4_096_u32.to_be_bytes());
        assert!(encoded_windows_image_dimensions_are_safe(
            WindowsImageEncoding::Png,
            &png
        ));
        png[16..20].copy_from_slice(&8_193_u32.to_be_bytes());
        assert!(!encoded_windows_image_dimensions_are_safe(
            WindowsImageEncoding::Png,
            &png
        ));

        let mut dibv5 = vec![0_u8; 124];
        dibv5[..4].copy_from_slice(&124_u32.to_le_bytes());
        dibv5[4..8].copy_from_slice(&4_096_i32.to_le_bytes());
        dibv5[8..12].copy_from_slice(&(-4_096_i32).to_le_bytes());
        assert!(encoded_windows_image_dimensions_are_safe(
            WindowsImageEncoding::DibV5,
            &dibv5
        ));
        dibv5[8..12].copy_from_slice(&i32::MIN.to_le_bytes());
        assert!(!encoded_windows_image_dimensions_are_safe(
            WindowsImageEncoding::DibV5,
            &dibv5
        ));
    }

    #[test]
    fn optional_html_and_rtf_failures_keep_plain_text() {
        let reader = FakeReader {
            plain: Ok(Some("可用纯文本".into())),
            html_probe: ClipboardFormatProbe::Present(32),
            html: Err(()),
            rtf_probe: ClipboardFormatProbe::Present(32),
            rtf: Err(()),
            file_probe: ClipboardFormatProbe::Absent,
            ..FakeReader::default()
        };
        let package = capture_package_from(&reader).expect("optional formats may be omitted");

        assert_eq!(package.plain_text.as_deref(), Some("可用纯文本"));
        assert_eq!(
            package.omitted_formats,
            vec![ClipboardFormatKind::Html, ClipboardFormatKind::Rtf]
        );
    }

    #[test]
    fn optional_probes_distinguish_absence_from_advertised_failure() {
        let failed = FakeReader {
            plain: Ok(Some("可用纯文本".into())),
            html_probe: ClipboardFormatProbe::Failed,
            rtf_probe: ClipboardFormatProbe::Failed,
            file_probe: ClipboardFormatProbe::Absent,
            ..FakeReader::default()
        };
        let absent = FakeReader {
            plain: Ok(Some("可用纯文本".into())),
            html_probe: ClipboardFormatProbe::Absent,
            rtf_probe: ClipboardFormatProbe::Absent,
            file_probe: ClipboardFormatProbe::Absent,
            ..FakeReader::default()
        };

        let failed_package =
            capture_package_from(&failed).expect("optional probe failures degrade");
        let absent_package =
            capture_package_from(&absent).expect("absent formats are not failures");

        assert_eq!(
            failed_package.omitted_formats,
            vec![ClipboardFormatKind::Html, ClipboardFormatKind::Rtf]
        );
        assert!(absent_package.omitted_formats.is_empty());
        assert_eq!(failed.html_reads.get(), 0);
        assert_eq!(failed.rtf_reads.get(), 0);
    }

    #[test]
    fn advertised_optional_read_returning_none_is_omitted() {
        let reader = FakeReader {
            plain: Ok(Some("可用纯文本".into())),
            html_probe: ClipboardFormatProbe::Present(32),
            html: Ok(None),
            rtf_probe: ClipboardFormatProbe::Present(32),
            rtf: Ok(None),
            file_probe: ClipboardFormatProbe::Absent,
            ..FakeReader::default()
        };

        let package = capture_package_from(&reader).expect("optional reads degrade");
        assert_eq!(
            package.omitted_formats,
            vec![ClipboardFormatKind::Html, ClipboardFormatKind::Rtf]
        );
    }

    #[test]
    fn mandatory_plain_or_file_read_failures_are_retryable() {
        let plain_failure = FakeReader {
            plain: Err(()),
            file_probe: ClipboardFormatProbe::Absent,
            ..FakeReader::default()
        };
        let file_count_failure = FakeReader {
            plain: Ok(Some("plain".into())),
            file_probe: ClipboardFormatProbe::Failed,
            ..FakeReader::default()
        };
        let file_read_failure = FakeReader {
            plain: Ok(Some("plain".into())),
            file_probe: ClipboardFormatProbe::Present(1),
            files: Err(()),
            ..FakeReader::default()
        };

        for reader in [plain_failure, file_count_failure, file_read_failure] {
            assert!(capture_package_from(&reader).is_err());
            assert!(matches!(
                classify_package_read(
                    Some(41),
                    Some(41),
                    capture_package_from(&reader).map_err(|()| "retry".into())
                ),
                PackageReadOutcome::Retryable
            ));
        }
    }

    #[test]
    fn advertised_failed_or_zero_file_count_is_retryable() {
        for file_probe in [
            ClipboardFormatProbe::Failed,
            ClipboardFormatProbe::Present(0),
        ] {
            let reader = FakeReader {
                plain: Ok(Some("plain".into())),
                file_probe,
                ..FakeReader::default()
            };

            assert!(capture_package_from(&reader).is_err());
        }
    }

    #[test]
    fn advertised_file_read_returning_none_is_retryable() {
        let reader = FakeReader {
            plain: Ok(Some("plain".into())),
            file_probe: ClipboardFormatProbe::Present(1),
            files: Ok(None),
            ..FakeReader::default()
        };

        assert!(capture_package_from(&reader).is_err());
    }

    #[test]
    fn a_successful_file_read_ignores_an_unrelated_plain_read_failure() {
        let reader = FakeReader {
            plain: Err(()),
            file_probe: ClipboardFormatProbe::Present(1),
            files: Ok(Some(vec!["C:\\Fixtures\\first.txt".into()])),
            ..FakeReader::default()
        };
        let package = capture_package_from(&reader).expect("files take precedence over plain text");

        assert_eq!(package.files.len(), 1);
        assert!(package.plain_text.is_none());
        assert_eq!(package.omitted_formats, vec![ClipboardFormatKind::Text]);
    }

    #[test]
    fn sequence_changes_are_retryable() {
        let package = rich_package();
        assert!(matches!(
            classify_package_read(Some(41), Some(42), Ok(package.clone())),
            PackageReadOutcome::Retryable
        ));
        assert!(matches!(
            classify_package_read(Some(41), Some(41), Ok(package)),
            PackageReadOutcome::Captured {
                sequence: Some(41),
                ..
            }
        ));
    }

    #[test]
    fn rich_content_without_plain_text_is_omitted_and_allows_image_fallback() {
        let reader = FakeReader {
            plain: Ok(None),
            html_probe: ClipboardFormatProbe::Present(12),
            html: Ok(Some("<b>orphan</b>".into())),
            rtf_probe: ClipboardFormatProbe::Present(12),
            rtf: Ok(Some(br"{\rtf1 orphan}".to_vec())),
            file_probe: ClipboardFormatProbe::Absent,
            ..FakeReader::default()
        };

        let package =
            capture_package_from(&reader).expect("orphan rich formats are safely omitted");

        assert!(package_payload(&package).is_none());
        assert_eq!(
            package.omitted_formats,
            vec![ClipboardFormatKind::Html, ClipboardFormatKind::Rtf,]
        );
        assert!(matches!(
            classify_package_read(Some(55), Some(55), Ok(package)),
            PackageReadOutcome::Ignored {
                package: FormatPackage { ref omitted_formats, .. },
                sequence: Some(55),
            } if omitted_formats == &[ClipboardFormatKind::Html, ClipboardFormatKind::Rtf]
        ));
    }

    #[test]
    fn verification_requires_every_requested_format_and_a_stable_sequence() {
        let expected = rich_package();
        let mut missing_rtf = expected.clone();
        missing_rtf.rtf = None;

        assert_eq!(
            verified_package_sequence(Some(71), &expected, Some(&expected), Some(71)),
            Some(71)
        );
        assert_eq!(
            verified_package_sequence(Some(71), &expected, Some(&missing_rtf), Some(71)),
            None
        );
        assert_eq!(
            verified_package_sequence(Some(71), &expected, Some(&expected), Some(72)),
            None
        );
    }

    #[test]
    fn write_requests_reject_invalid_data_before_decoding_or_opening_the_clipboard() {
        let oversized_base64 = "A".repeat(MAX_RTF_BASE64_INPUT_BYTES + 1);
        assert!(prepare_format_package("", None, None).is_err());
        assert!(prepare_format_package("plain", None, Some(&oversized_base64)).is_err());
        assert!(prepare_format_package("plain", None, Some("%%%invalid%%%")).is_err());
        assert!(prepare_file_package(&[]).is_err());
        assert!(prepare_file_package(&["C:\\bad\0path".into()]).is_err());
        assert!(prepare_file_package(&vec!["C:\\ok".into(); MAX_FILES + 1]).is_err());
    }

    #[test]
    fn file_write_requests_require_bounded_fully_qualified_windows_paths() {
        for invalid in [
            "relative\\file.txt".to_owned(),
            "C:drive-relative.txt".to_owned(),
            "\\root-relative.txt".to_owned(),
            "\\\\?\\C:\\device.txt".to_owned(),
            "\\\\.\\C:\\device.txt".to_owned(),
            format!("C:\\{}", "a".repeat(32_767)),
        ] {
            assert!(prepare_file_package(&[invalid]).is_err());
        }

        let aggregate = vec![format!("C:\\{}", "a".repeat(32_760)); 129];
        assert!(prepare_file_package(&aggregate).is_err());
        assert!(prepare_file_package(&[
            "C:\\Fixtures\\file.txt".into(),
            "\\\\server\\share\\folder".into(),
        ])
        .is_ok());
    }

    #[test]
    fn file_metadata_runs_only_after_guard_drop_and_stable_sequence_observation() {
        struct GuardProbe<'a> {
            open: &'a Cell<bool>,
            events: &'a RefCell<Vec<&'static str>>,
        }
        impl Drop for GuardProbe<'_> {
            fn drop(&mut self) {
                self.open.set(false);
                self.events.borrow_mut().push("guard-drop");
            }
        }

        let open = Cell::new(true);
        let events = RefCell::new(Vec::new());
        let reader = FakeReader {
            plain: Ok(None),
            file_probe: ClipboardFormatProbe::Present(1),
            files: Ok(Some(vec!["C:\\Fixtures\\file.txt".into()])),
            ..FakeReader::default()
        };
        let outcome = read_package_with_guard(
            GuardProbe {
                open: &open,
                events: &events,
            },
            &reader,
            Some(77),
            || {
                assert!(!open.get());
                events.borrow_mut().push("sequence");
                Some(77)
            },
            |_| {
                assert!(!open.get());
                events.borrow_mut().push("metadata");
                Some(FileMetadataSnapshot {
                    directory: false,
                    size: Some(12),
                    modified_at: None,
                })
            },
        );

        assert_eq!(&*events.borrow(), &["guard-drop", "sequence", "metadata"]);
        assert!(matches!(
            outcome,
            PackageReadOutcome::Captured {
                package: FormatPackage { ref files, .. },
                sequence: Some(77),
            } if files[0].exists && files[0].size == Some(12)
        ));
    }
}
