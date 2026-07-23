mod clipboard_formats;
mod history;
mod metrics;
mod ocr;
mod qr;
mod system_actions;
mod updater;

/// 仅供仓库内 release 基准复用生产数据库路径；不会注册为 Tauri IPC。
#[doc(hidden)]
pub mod history_benchmark {
    use rusqlite::Connection;

    pub use crate::history::{
        CapacityPolicy, ClipboardFile, ClipboardFormat, CollectionScope, HistoryItem,
        HistoryMutation, HistoryPage, HistoryQuery,
    };

    pub fn initialize(connection: &mut Connection) -> Result<(), String> {
        crate::history::initialize_history_database(connection)
    }

    pub fn apply(connection: &mut Connection, mutation: HistoryMutation) -> Result<(), String> {
        crate::history::apply_history_mutation(connection, mutation).map(|_| ())
    }

    pub fn query(connection: &Connection, query: HistoryQuery) -> Result<HistoryPage, String> {
        crate::history::query_history(connection, query)
    }
}

use std::{
    borrow::Cow,
    collections::{hash_map::DefaultHasher, HashMap, VecDeque},
    fs,
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, RwLock, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{DynamicImage, ImageFormat, ImageReader, RgbaImage};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const CLIPBOARD_EVENT: &str = "clipboard://changed";
const PASTE_TARGET_EVENT: &str = "paste-target://changed";
const QUICK_PANEL_INVOKED_EVENT: &str = "quick-panel://invoked";
const CAPTURE_STATE_EVENT: &str = "capture://state-changed";
const CAPTURE_AVAILABILITY_EVENT: &str = "capture://availability-changed";
const QUIT_REQUESTED_EVENT: &str = "app://quit-requested";
const UPDATE_CHECK_REQUESTED_EVENT: &str = "update://check-requested";
const APP_ICON_SIZE: u32 = 64;
const APP_ICON_CACHE_CAPACITY: usize = 96;
const DEFAULT_GLOBAL_SHORTCUT: &str = "Ctrl+Shift+V";
const PASTE_TARGET_TTL: Duration = Duration::from_secs(5 * 60);
const ELEVATED_HELPER_REQUEST_TTL_MS: u64 = 30_000;
const ELEVATED_HELPER_WAIT_TIMEOUT_MS: u32 = 32_000;
const ELEVATED_PIPE_BUFFER_BYTES: u32 = 512;
const ELEVATED_REQUEST_MAX_BYTES: usize = 256;
// 已发布给一次性 helper 的安全协议标识保持稳定；它们不属于用户可见品牌。
const ELEVATED_HELPER_PROTOCOL_FLAG: &str = "--mypaste-elevated-paste";
const ELEVATED_PIPE_NAMESPACE: &str = "MyPaste.ElevatedPaste";
const MODIFIER_RELEASE_TIMEOUT: Duration = Duration::from_millis(800);
const FOREGROUND_ACTIVATION_ATTEMPTS: usize = 50;
const FOREGROUND_ACTIVATION_RETRY_DELAY: Duration = Duration::from_millis(10);
const TARGET_ACTIVATION_SETTLE_DELAY: Duration = Duration::from_millis(100);
const CLIPBOARD_INITIALIZATION_ATTEMPTS: usize = 4;
const CLIPBOARD_INITIALIZATION_RETRY_DELAY: Duration = Duration::from_millis(250);
const CLIPBOARD_READ_ATTEMPTS: usize = 4;
const CLIPBOARD_READ_RETRY_DELAY: Duration = Duration::from_millis(40);
const CLIPBOARD_EXHAUSTED_RETRY_DELAY: Duration = Duration::from_millis(800);
const CARET_ACCESSIBILITY_TIMEOUT: Duration = Duration::from_millis(60);
const QUICK_PANEL_SHELL_INSET_DIP: f64 = 16.0;
const QUICK_PANEL_VISIBLE_GAP_DIP: f64 = 12.0;
const QUICK_PANEL_COMPACT_SIZE_DIP: ScreenSize = ScreenSize::new(640, 440);
const LIBRARY_MIN_SIZE_DIP: ScreenSize = ScreenSize::new(640, 440);
const QUIT_FALLBACK_TIMEOUT: Duration = Duration::from_secs(4);
static QUIT_REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "windows")]
static CARET_ACCESSIBILITY_BUSY: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static ELEVATED_HELPER_BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScreenPoint {
    x: i32,
    y: i32,
}

impl ScreenPoint {
    const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScreenSize {
    width: i32,
    height: i32,
}

impl ScreenSize {
    const fn new(width: i32, height: i32) -> Self {
        Self { width, height }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl ScreenRect {
    const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    const fn from_point(point: ScreenPoint) -> Self {
        Self::new(point.x, point.y, point.x, point.y)
    }

    fn is_valid_caret(self) -> bool {
        let width = i64::from(self.right) - i64::from(self.left);
        let height = i64::from(self.bottom) - i64::from(self.top);
        (0..=512).contains(&width)
            && (1..=1_024).contains(&height)
            && (-999_999..=999_999).contains(&self.left)
            && (-999_999..=999_999).contains(&self.top)
            && (-999_999..=999_999).contains(&self.right)
            && (-999_999..=999_999).contains(&self.bottom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowMode {
    Quick,
    Library,
}

impl WindowMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "quick" => Ok(Self::Quick),
            "library" => Ok(Self::Library),
            _ => Err(format!("未知窗口模式: {value}")),
        }
    }
}

#[derive(Clone)]
struct CurrentWindowMode(Arc<RwLock<WindowMode>>);

impl Default for CurrentWindowMode {
    fn default() -> Self {
        Self(Arc::new(RwLock::new(WindowMode::Quick)))
    }
}

impl CurrentWindowMode {
    fn get(&self) -> WindowMode {
        self.0.read().map(|mode| *mode).unwrap_or(WindowMode::Quick)
    }

    fn replace(&self, mode: WindowMode) {
        if let Ok(mut current) = self.0.write() {
            *current = mode;
        }
    }
}

#[derive(Clone, Default)]
struct CurrentQuickPanelSession(Arc<AtomicU64>);

impl CurrentQuickPanelSession {
    fn begin(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Default)]
struct QuickPanelPinned(Arc<AtomicBool>);

#[derive(Clone, Default)]
struct QrRuntimeState(Arc<AtomicBool>);

struct QrRuntimePermit(Arc<AtomicBool>);

impl QrRuntimeState {
    fn try_reserve(&self) -> Result<QrRuntimePermit, String> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| QrRuntimePermit(self.0.clone()))
            .map_err(|_| "二维码识别正在进行".to_owned())
    }
}

impl Drop for QrRuntimePermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone, Default)]
struct OnboardingWindowActive(Arc<AtomicBool>);

impl OnboardingWindowActive {
    fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    fn set(&self, active: bool) {
        self.0.store(active, Ordering::Relaxed);
    }
}

fn should_auto_hide_quick_panel(
    mode: WindowMode,
    focused: bool,
    pinned: bool,
    onboarding_active: bool,
    native_window_foreground: bool,
) -> bool {
    mode == WindowMode::Quick
        && !focused
        && !pinned
        && !onboarding_active
        && !native_window_foreground
}

#[cfg(target_os = "windows")]
fn native_window_is_foreground<R: tauri::Runtime>(window: &tauri::Window<R>) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    window
        .hwnd()
        .is_ok_and(|handle| unsafe { GetForegroundWindow() } == handle)
}

#[cfg(not(target_os = "windows"))]
fn native_window_is_foreground<R: tauri::Runtime>(_window: &tauri::Window<R>) -> bool {
    false
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QuickPanelHotkeyAction {
    Hide,
    ShowAndSample,
}

fn quick_panel_hotkey_action(
    mode: WindowMode,
    visible: bool,
    minimized: bool,
) -> QuickPanelHotkeyAction {
    if mode == WindowMode::Quick && visible && !minimized {
        QuickPanelHotkeyAction::Hide
    } else {
        QuickPanelHotkeyAction::ShowAndSample
    }
}

fn should_toggle_quick_panel_on_hotkey(mode: WindowMode, visible: bool, minimized: bool) -> bool {
    quick_panel_hotkey_action(mode, visible, minimized) == QuickPanelHotkeyAction::Hide
}

fn window_size_dip(mode: WindowMode) -> ScreenSize {
    match mode {
        WindowMode::Quick => ScreenSize::new(800, 580),
        WindowMode::Library => ScreenSize::new(1080, 720),
    }
}

fn fit_window_size_to_work_area(
    desired_dip: ScreenSize,
    work_area: ScreenRect,
    scale: f64,
) -> ScreenSize {
    let available_width = (work_area.right - work_area.left).max(1);
    let available_height = (work_area.bottom - work_area.top).max(1);
    ScreenSize::new(
        ((desired_dip.width as f64 * scale).round() as i32).min(available_width),
        ((desired_dip.height as f64 * scale).round() as i32).min(available_height),
    )
}

fn window_min_size_native(
    mode: WindowMode,
    work_area: ScreenRect,
    scale: f64,
) -> Option<ScreenSize> {
    match mode {
        WindowMode::Quick => None,
        WindowMode::Library => Some(fit_window_size_to_work_area(
            LIBRARY_MIN_SIZE_DIP,
            work_area,
            scale,
        )),
    }
}

fn quick_panel_can_clear_anchor(
    anchor: ScreenRect,
    native_size: ScreenSize,
    native_work_area: ScreenRect,
    scale: f64,
) -> bool {
    let requested_inset = (QUICK_PANEL_SHELL_INSET_DIP * scale).round() as i32;
    let inset_x = requested_inset.clamp(0, ((native_size.width - 1) / 2).max(0));
    let inset_y = requested_inset.clamp(0, ((native_size.height - 1) / 2).max(0));
    let visible_width = (native_size.width - inset_x * 2).max(1);
    let visible_height = (native_size.height - inset_y * 2).max(1);
    let visible_work_area = ScreenRect::new(
        native_work_area.left.saturating_add(inset_x),
        native_work_area.top.saturating_add(inset_y),
        native_work_area.right.saturating_sub(inset_x),
        native_work_area.bottom.saturating_sub(inset_y),
    );
    let gap = (QUICK_PANEL_VISIBLE_GAP_DIP * scale).round() as i64;
    let visible_width = i64::from(visible_width);
    let visible_height = i64::from(visible_height);

    i64::from(anchor.right) + gap + visible_width <= i64::from(visible_work_area.right)
        || i64::from(anchor.left) - gap - visible_width >= i64::from(visible_work_area.left)
        || i64::from(anchor.bottom) + gap + visible_height <= i64::from(visible_work_area.bottom)
        || i64::from(anchor.top) - gap - visible_height >= i64::from(visible_work_area.top)
}

fn choose_quick_panel_size_dip(
    anchor: ScreenRect,
    work_area: ScreenRect,
    scale: f64,
) -> ScreenSize {
    let standard = window_size_dip(WindowMode::Quick);
    let standard_native = fit_window_size_to_work_area(standard, work_area, scale);
    if quick_panel_can_clear_anchor(anchor, standard_native, work_area, scale) {
        return standard;
    }

    let compact_native =
        fit_window_size_to_work_area(QUICK_PANEL_COMPACT_SIZE_DIP, work_area, scale);
    if quick_panel_can_clear_anchor(anchor, compact_native, work_area, scale) {
        return QUICK_PANEL_COMPACT_SIZE_DIP;
    }

    // 极小工作区或高缩放下，固定紧凑尺寸仍可能压住光标。分别尝试只收窄或
    // 只降低窗口，保留信息量更多且能避开锚点的方案；最终判定复用真实 DPI
    // 换算和可见 shell 边距，避免逻辑尺寸与实际位置不一致。
    [true, false]
        .into_iter()
        .filter_map(|shrink_width| {
            let maximum = if shrink_width {
                QUICK_PANEL_COMPACT_SIZE_DIP.width - 1
            } else {
                QUICK_PANEL_COMPACT_SIZE_DIP.height - 1
            };

            (1..=maximum).rev().find_map(|dimension| {
                let candidate = if shrink_width {
                    ScreenSize::new(dimension, QUICK_PANEL_COMPACT_SIZE_DIP.height)
                } else {
                    ScreenSize::new(QUICK_PANEL_COMPACT_SIZE_DIP.width, dimension)
                };
                let native_size = fit_window_size_to_work_area(candidate, work_area, scale);
                quick_panel_can_clear_anchor(anchor, native_size, work_area, scale)
                    .then_some(candidate)
            })
        })
        .max_by_key(|size| i64::from(size.width) * i64::from(size.height))
        .unwrap_or(QUICK_PANEL_COMPACT_SIZE_DIP)
}

fn place_window_near_anchor(
    anchor: ScreenRect,
    size: ScreenSize,
    work_area: ScreenRect,
    gap: i32,
) -> ScreenPoint {
    let max_x = (work_area.right - size.width).max(work_area.left);
    let max_y = (work_area.bottom - size.height).max(work_area.top);
    let right = anchor.right.saturating_add(gap);
    let left = anchor.left.saturating_sub(size.width).saturating_sub(gap);
    let below = anchor.bottom.saturating_add(gap);
    let above = anchor.top.saturating_sub(size.height).saturating_sub(gap);
    let x = if right.saturating_add(size.width) <= work_area.right {
        right
    } else if left >= work_area.left {
        left
    } else {
        right.clamp(work_area.left, max_x)
    }
    .clamp(work_area.left, max_x);
    let y = if below.saturating_add(size.height) <= work_area.bottom {
        below
    } else if above >= work_area.top {
        above
    } else {
        below.clamp(work_area.top, max_y)
    }
    .clamp(work_area.top, max_y);

    ScreenPoint::new(x, y)
}

fn anchor_monitor_point(
    anchor: ScreenRect,
    target_window_hint: Option<ScreenPoint>,
) -> ScreenPoint {
    fn axis(start: i32, end: i32, hint: Option<i32>) -> i32 {
        if end > start {
            let extent = i64::from(end) - i64::from(start);
            (i64::from(start) + extent / 2) as i32
        } else if hint.is_some_and(|hint| hint < start) {
            start.saturating_sub(1)
        } else {
            start
        }
    }

    ScreenPoint::new(
        axis(
            anchor.left,
            anchor.right,
            target_window_hint.map(|point| point.x),
        ),
        axis(
            anchor.top,
            anchor.bottom,
            target_window_hint.map(|point| point.y),
        ),
    )
}

fn place_quick_panel_window(
    anchor: ScreenRect,
    native_size: ScreenSize,
    native_work_area: ScreenRect,
    scale: f64,
) -> ScreenPoint {
    // WebView 的透明窗口比实际可见 shell 四边各大 16 DIP。先定位可见边框，再反推
    // 原生窗口左上角，避免视觉间距被透明区域额外放大。
    let requested_inset = (QUICK_PANEL_SHELL_INSET_DIP * scale).round() as i32;
    let inset_x = requested_inset.clamp(0, ((native_size.width - 1) / 2).max(0));
    let inset_y = requested_inset.clamp(0, ((native_size.height - 1) / 2).max(0));
    let visible_size = ScreenSize::new(
        (native_size.width - inset_x * 2).max(1),
        (native_size.height - inset_y * 2).max(1),
    );
    let visible_work_area = ScreenRect::new(
        native_work_area.left.saturating_add(inset_x),
        native_work_area.top.saturating_add(inset_y),
        native_work_area.right.saturating_sub(inset_x),
        native_work_area.bottom.saturating_sub(inset_y),
    );
    let visible_position = place_window_near_anchor(
        anchor,
        visible_size,
        visible_work_area,
        (QUICK_PANEL_VISIBLE_GAP_DIP * scale).round() as i32,
    );
    ScreenPoint::new(
        visible_position.x.saturating_sub(inset_x),
        visible_position.y.saturating_sub(inset_y),
    )
}

fn choose_caret_rect(
    accessibility: Option<ScreenRect>,
    gui_thread: Option<ScreenRect>,
    attached_thread: Option<ScreenRect>,
) -> Option<ScreenRect> {
    accessibility
        .filter(|rect| rect.is_valid_caret())
        .or_else(|| gui_thread.filter(|rect| rect.is_valid_caret()))
        .or_else(|| attached_thread.filter(|rect| rect.is_valid_caret()))
}

fn choose_popup_anchor(
    caret: Option<ScreenRect>,
    pointer: Option<ScreenPoint>,
) -> Option<ScreenRect> {
    caret
        .filter(|rect| rect.is_valid_caret())
        .or_else(|| pointer.map(ScreenRect::from_point))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PasteStrategy {
    Direct,
    ElevatedHelper,
    CopyOnly,
}

fn choose_paste_strategy(
    current_process_elevated: bool,
    target_process_elevated: bool,
    elevated_helper_enabled: bool,
) -> PasteStrategy {
    if current_process_elevated {
        // 常驻主进程不应持有高完整性令牌；即使启动门禁被绕过，也不执行自动注入。
        PasteStrategy::CopyOnly
    } else if !target_process_elevated {
        PasteStrategy::Direct
    } else if elevated_helper_enabled {
        PasteStrategy::ElevatedHelper
    } else {
        PasteStrategy::CopyOnly
    }
}

fn paste_strategy_terminal_outcome(
    strategy: PasteStrategy,
    pasted: bool,
) -> metrics::PasteTerminalOutcome {
    match (strategy, pasted) {
        (PasteStrategy::Direct, true) => metrics::PasteTerminalOutcome::DirectSucceeded,
        (PasteStrategy::Direct, false) => metrics::PasteTerminalOutcome::DirectFailed,
        (PasteStrategy::ElevatedHelper, true) => metrics::PasteTerminalOutcome::ElevatedSucceeded,
        (PasteStrategy::ElevatedHelper, false) => metrics::PasteTerminalOutcome::ElevatedFailed,
        (PasteStrategy::CopyOnly, _) => metrics::PasteTerminalOutcome::ElevationDisabled,
    }
}

fn captured_snapshot_terminal_outcome(
    internal_write: bool,
    should_capture: bool,
    paused: bool,
    excluded: bool,
    payload_supported: bool,
    event_delivered: Option<bool>,
) -> metrics::CaptureTerminalOutcome {
    if internal_write {
        metrics::CaptureTerminalOutcome::InternalWrite
    } else if !should_capture {
        metrics::CaptureTerminalOutcome::Duplicate
    } else if paused {
        metrics::CaptureTerminalOutcome::Paused
    } else if excluded {
        metrics::CaptureTerminalOutcome::Excluded
    } else if !payload_supported {
        metrics::CaptureTerminalOutcome::ExternalFailed
    } else if event_delivered == Some(true) {
        metrics::CaptureTerminalOutcome::ExternalDelivered
    } else {
        metrics::CaptureTerminalOutcome::ExternalFailed
    }
}

const ACCEPTANCE_METRICS_FLUSH_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct AcceptanceMetricsState {
    metrics: Arc<Mutex<metrics::AcceptanceMetrics>>,
    flush_scheduled: Arc<AtomicBool>,
    next_paste_operation_id: Arc<AtomicU64>,
    next_capture_operation_id: Arc<AtomicU64>,
}

impl Default for AcceptanceMetricsState {
    fn default() -> Self {
        Self::new(metrics::AcceptanceMetrics::disabled())
    }
}

impl AcceptanceMetricsState {
    fn new(metrics: metrics::AcceptanceMetrics) -> Self {
        Self {
            metrics: Arc::new(Mutex::new(metrics)),
            flush_scheduled: Arc::new(AtomicBool::new(false)),
            next_paste_operation_id: Arc::new(AtomicU64::new(0)),
            next_capture_operation_id: Arc::new(AtomicU64::new(0)),
        }
    }

    fn enabled(app_data_root: impl AsRef<Path>) -> Self {
        Self::new(metrics::AcceptanceMetrics::enabled(app_data_root))
    }

    fn is_enabled(&self) -> bool {
        self.metrics
            .lock()
            .is_ok_and(|metrics| metrics.is_enabled())
    }

    fn start_quick_panel_session(&self, session_id: u64, started_at: Instant) -> bool {
        self.metrics
            .lock()
            .is_ok_and(|mut metrics| metrics.start_quick_panel_session(session_id, started_at))
    }

    fn acknowledge_quick_panel_first_frame(&self, session_id: u64) -> bool {
        let recorded = self.metrics.lock().is_ok_and(|mut metrics| {
            metrics.acknowledge_quick_panel_first_frame(session_id, Instant::now())
        });
        if recorded {
            self.schedule_flush();
        }
        recorded
    }

    fn record_paste_terminal(&self, outcome: metrics::PasteTerminalOutcome) -> bool {
        let Some(operation_id) = next_metrics_operation_id(&self.next_paste_operation_id) else {
            return false;
        };
        let recorded = self
            .metrics
            .lock()
            .is_ok_and(|mut metrics| metrics.record_paste_terminal(operation_id, outcome));
        if recorded {
            self.schedule_flush();
        }
        recorded
    }

    fn record_capture_terminal(&self, outcome: metrics::CaptureTerminalOutcome) -> bool {
        let Some(operation_id) = next_metrics_operation_id(&self.next_capture_operation_id) else {
            return false;
        };
        let recorded = self
            .metrics
            .lock()
            .is_ok_and(|mut metrics| metrics.record_capture_terminal(operation_id, outcome));
        if recorded {
            self.schedule_flush();
        }
        recorded
    }

    fn schedule_flush(&self) {
        if !self.is_enabled()
            || self
                .flush_scheduled
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }

        let state = self.clone();
        thread::spawn(move || loop {
            thread::sleep(ACCEPTANCE_METRICS_FLUSH_DELAY);
            let flush_succeeded = state.flush_now();
            state.flush_scheduled.store(false, Ordering::Release);
            if !flush_succeeded {
                log::warn!("验收指标写入失败；业务流程继续运行");
                return;
            }

            let pending = state
                .metrics
                .lock()
                .is_ok_and(|metrics| metrics.has_pending_changes());
            if !pending
                || state
                    .flush_scheduled
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
            {
                return;
            }
        });
    }

    fn flush_now(&self) -> bool {
        self.metrics
            .lock()
            .is_ok_and(|mut metrics| metrics.flush(SystemTime::now()).is_ok())
    }
}

fn next_metrics_operation_id(counter: &AtomicU64) -> Option<u64> {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < metrics::JS_MAX_SAFE_INTEGER).then_some(current + 1)
        })
        .ok()
        .map(|previous| previous + 1)
}

#[derive(Clone)]
struct CaptureControl(Arc<AtomicBool>);

#[derive(Clone, Default)]
struct CaptureHealth {
    available: Arc<AtomicBool>,
    initialized: Arc<AtomicBool>,
}

impl CaptureHealth {
    fn finish(&self, available: bool) {
        self.available.store(available, Ordering::Relaxed);
        self.initialized.store(true, Ordering::Relaxed);
    }

    fn snapshot(&self) -> CaptureAvailabilityPayload {
        CaptureAvailabilityPayload {
            available: self.available.load(Ordering::Relaxed),
            initialized: self.initialized.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Default)]
struct CaptureMenuItem(Arc<Mutex<Option<MenuItem<tauri::Wry>>>>);

impl CaptureMenuItem {
    fn replace(&self, item: MenuItem<tauri::Wry>) {
        if let Ok(mut current) = self.0.lock() {
            *current = Some(item);
        }
    }

    fn update(&self, paused: bool) {
        if let Ok(current) = self.0.lock() {
            if let Some(item) = current.as_ref() {
                let _ = item.set_text(capture_menu_text(paused));
            }
        }
    }
}

#[derive(Clone, Default)]
struct QuitRequested(Arc<AtomicU64>);

#[derive(Clone)]
struct ElevatedPasteEnabled(Arc<AtomicBool>);

#[derive(Clone, Default)]
struct CaptureExclusions(Arc<RwLock<Vec<String>>>);

#[derive(Clone)]
struct CurrentGlobalShortcut(Arc<Mutex<String>>);

impl Default for CurrentGlobalShortcut {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(DEFAULT_GLOBAL_SHORTCUT.into())))
    }
}

impl CurrentGlobalShortcut {
    fn get(&self) -> String {
        self.0
            .lock()
            .map(|shortcut| shortcut.clone())
            .unwrap_or_else(|_| DEFAULT_GLOBAL_SHORTCUT.into())
    }

    fn replace(&self, shortcut: String) {
        if let Ok(mut current) = self.0.lock() {
            *current = shortcut;
        }
    }
}

impl CaptureExclusions {
    fn replace(&self, apps: Vec<String>) {
        let normalized = apps
            .into_iter()
            .map(|app| app.trim().to_lowercase())
            .filter(|app| !app.is_empty())
            .collect();
        if let Ok(mut current) = self.0.write() {
            *current = normalized;
        }
    }

    fn contains(&self, app: &str) -> bool {
        let normalized = app.trim().to_lowercase();
        self.0
            .read()
            .is_ok_and(|apps| apps.iter().any(|excluded| excluded == &normalized))
    }
}

fn parse_configured_shortcut(value: &str) -> Result<Shortcut, String> {
    let parts = value
        .split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    let has_ctrl = parts.iter().any(|part| part == "ctrl");
    let has_alt = parts.iter().any(|part| part == "alt");
    let has_shift = parts.iter().any(|part| part == "shift");
    let has_primary_modifier = has_ctrl || has_alt;
    if !has_primary_modifier {
        return Err("快捷键至少需要包含 Ctrl 或 Alt".into());
    }
    if [has_ctrl, has_alt, has_shift]
        .into_iter()
        .filter(|enabled| *enabled)
        .count()
        < 2
    {
        return Err("为避免占用常用编辑操作，快捷键至少需要两个修饰键".into());
    }
    let key = parts
        .iter()
        .rev()
        .find(|part| !matches!(part.as_str(), "ctrl" | "alt" | "shift" | "super" | "meta"))
        .map(String::as_str)
        .unwrap_or_default();
    let conflicts_with_windows = (has_alt && matches!(key, "space" | "tab" | "escape" | "f4"))
        || (has_ctrl && key == "escape")
        || (has_ctrl && has_alt && key == "delete");
    if conflicts_with_windows {
        return Err("该快捷键由 Windows 保留".into());
    }
    value.parse::<Shortcut>().map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShortcutUpdatePlan {
    AlreadyRegistered,
    RegisterOnly,
    Replace,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShortcutUpdateStep {
    RegisterNext,
    UnregisterPrevious,
    CommitNext,
}

fn shortcut_update_steps(plan: ShortcutUpdatePlan) -> &'static [ShortcutUpdateStep] {
    match plan {
        ShortcutUpdatePlan::AlreadyRegistered => &[],
        ShortcutUpdatePlan::RegisterOnly => &[
            ShortcutUpdateStep::RegisterNext,
            ShortcutUpdateStep::CommitNext,
        ],
        ShortcutUpdatePlan::Replace => &[
            ShortcutUpdateStep::RegisterNext,
            ShortcutUpdateStep::UnregisterPrevious,
            ShortcutUpdateStep::CommitNext,
        ],
    }
}

fn shortcut_update_plan(
    previous: &str,
    next: &str,
    current_is_registered: bool,
) -> ShortcutUpdatePlan {
    if previous == next && current_is_registered {
        ShortcutUpdatePlan::AlreadyRegistered
    } else if !current_is_registered {
        ShortcutUpdatePlan::RegisterOnly
    } else {
        ShortcutUpdatePlan::Replace
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureStatePayload {
    paused: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureAvailabilityPayload {
    available: bool,
    initialized: bool,
}

fn retry_with_delay<T>(
    attempts: usize,
    delay: Duration,
    mut operation: impl FnMut() -> Option<T>,
) -> Option<T> {
    for attempt in 0..attempts {
        if let Some(value) = operation() {
            return Some(value);
        }
        if attempt + 1 < attempts && !delay.is_zero() {
            thread::sleep(delay);
        }
    }
    None
}

fn capture_menu_text(paused: bool) -> &'static str {
    if paused {
        "恢复记录"
    } else {
        "暂停记录"
    }
}

fn initial_screen_capture_protection() -> bool {
    false
}

fn mark_quit_requested(requested: &AtomicU64, request_id: u64) -> bool {
    if request_id == 0 {
        return false;
    }
    requested
        .compare_exchange(0, request_id, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn cancel_quit_request(requested: &AtomicU64) {
    requested.store(0, Ordering::Release);
}

fn take_pending_quit(requested: &AtomicU64, request_id: u64) -> bool {
    requested
        .compare_exchange(request_id, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn next_quit_request_id() -> u64 {
    loop {
        let request_id = QUIT_REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        if request_id != 0 {
            return request_id;
        }
    }
}

fn run_with_timeout<T: Send + 'static>(
    timeout: Duration,
    operation: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(operation());
    });
    receiver.recv_timeout(timeout).ok()
}

#[derive(Clone, Debug)]
struct PasteTargetIdentity {
    window_handle: isize,
    focus_window_handle: Option<isize>,
    process_id: u32,
    captured_at: Instant,
}

#[derive(Clone, Debug)]
struct ForegroundPasteTargetSnapshot {
    identity: PasteTargetIdentity,
    source_app: Option<SourceAppIdentity>,
    elevated: bool,
}

fn foreground_target_is_eligible(
    window_handle: isize,
    process_id: u32,
    current_process_id: u32,
    own_window_handle: Option<isize>,
) -> bool {
    window_handle != 0
        && process_id != 0
        && process_id != current_process_id
        && own_window_handle != Some(window_handle)
}

#[derive(Clone, Default)]
struct PasteTarget(Arc<Mutex<Option<PasteTargetIdentity>>>);

impl PasteTarget {
    #[cfg(test)]
    fn remember(&self, window_handle: isize) {
        if window_handle == 0 {
            self.clear();
            return;
        }

        self.remember_with_pid_and_focus(
            window_handle,
            window_process_id(window_handle).unwrap_or_default(),
            None,
        );
    }

    #[cfg(test)]
    fn take(&self) -> Option<isize> {
        self.take_identity().map(|identity| identity.window_handle)
    }

    fn remember_with_pid_and_focus(
        &self,
        window_handle: isize,
        process_id: u32,
        focus_window_handle: Option<isize>,
    ) {
        if let Ok(mut current) = self.0.lock() {
            *current = Some(PasteTargetIdentity {
                window_handle,
                focus_window_handle,
                process_id,
                captured_at: Instant::now(),
            });
        }
    }

    #[cfg(test)]
    fn take_identity(&self) -> Option<PasteTargetIdentity> {
        self.0.lock().ok()?.take()
    }

    fn identity_for_activation(
        &self,
        keep_for_continuous_paste: bool,
    ) -> Option<PasteTargetIdentity> {
        let mut current = self.0.lock().ok()?;
        if keep_for_continuous_paste {
            current.clone()
        } else {
            current.take()
        }
    }

    fn complete_activation(
        &self,
        identity: &PasteTargetIdentity,
        keep_for_continuous_paste: bool,
        pasted: bool,
    ) -> bool {
        if keep_for_continuous_paste && pasted {
            return false;
        }

        let Ok(mut current) = self.0.lock() else {
            return false;
        };
        let matches_activation = current.as_ref().is_some_and(|candidate| {
            candidate.window_handle == identity.window_handle
                && candidate.focus_window_handle == identity.focus_window_handle
                && candidate.process_id == identity.process_id
                && candidate.captured_at == identity.captured_at
        });
        if matches_activation {
            current.take();
        }
        matches_activation
    }

    fn clear(&self) {
        if let Ok(mut current) = self.0.lock() {
            *current = None;
        }
    }
}

fn friendly_app_name(executable_path: &str) -> String {
    let file_name = executable_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(executable_path);
    let process_name = file_name
        .strip_suffix(".exe")
        .or_else(|| file_name.strip_suffix(".EXE"))
        .unwrap_or(file_name);

    match process_name.to_ascii_lowercase().as_str() {
        "winword" => "Microsoft Word".into(),
        "excel" => "Microsoft Excel".into(),
        "powerpnt" => "Microsoft PowerPoint".into(),
        "outlook" => "Microsoft Outlook".into(),
        "msedge" => "Microsoft Edge".into(),
        "chrome" => "Google Chrome".into(),
        "code" => "Visual Studio Code".into(),
        "windowsterminal" => "Windows Terminal".into(),
        "wechat" => "微信".into(),
        "feishu" => "飞书".into(),
        "dingtalk" => "钉钉".into(),
        "wps" | "wpscloudsvr" => "WPS Office".into(),
        "notepad" => "Notepad".into(),
        "quickpaste" => "QuickPaste".into(),
        _ => process_name.into(),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceAppIdentity {
    name: String,
    icon: Option<String>,
}

struct AppIconCache {
    capacity: usize,
    entries: HashMap<String, Option<String>>,
    insertion_order: VecDeque<String>,
}

impl AppIconCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::with_capacity(capacity),
            insertion_order: VecDeque::with_capacity(capacity),
        }
    }

    fn get(&self, key: &str) -> Option<Option<String>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: String, icon: Option<String>) {
        if self.capacity == 0 {
            return;
        }
        if let Some(existing) = self.entries.get_mut(&key) {
            if existing.is_none() || icon.is_some() {
                *existing = icon;
            }
            return;
        }

        while self.entries.len() >= self.capacity {
            let Some(oldest) = self.insertion_order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.insertion_order.push_back(key.clone());
        self.entries.insert(key, icon);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

fn paste_target_label(source_app: Option<String>) -> String {
    source_app
        .filter(|source| {
            !source.eq_ignore_ascii_case("quickpaste") && !source.eq_ignore_ascii_case("mypaste")
        })
        .unwrap_or_default()
}

fn paste_target_presentation(source_app: Option<SourceAppIdentity>) -> (String, Option<String>) {
    let Some(source_app) = source_app else {
        return (String::new(), None);
    };
    let label = paste_target_label(Some(source_app.name));
    let icon = if label.is_empty() {
        None
    } else {
        source_app.icon
    };
    (label, icon)
}

#[derive(Debug, Eq, PartialEq)]
enum ClipboardSnapshot {
    Text(String),
    Package(clipboard_formats::FormatPackage),
    Image {
        width: usize,
        height: usize,
        bytes: Vec<u8>,
        omitted_formats: Vec<clipboard_formats::ClipboardFormatKind>,
    },
}

#[derive(Clone, Default)]
struct InternalClipboardWrites(Arc<Mutex<Option<InternalClipboardWrite>>>);

struct InternalClipboardWrite {
    signature: u64,
    sequence: Option<u64>,
    expires_at: Instant,
}

impl InternalClipboardWrites {
    fn begin(&self, snapshot: &ClipboardSnapshot) -> u64 {
        let signature = snapshot_signature(snapshot);
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(InternalClipboardWrite {
                signature,
                sequence: None,
                expires_at: Instant::now() + Duration::from_secs(2),
            });
        }
        signature
    }

    fn commit(&self, signature: u64, sequence: Option<u64>) {
        if let Ok(mut pending) = self.0.lock() {
            if let Some(change) = pending
                .as_mut()
                .filter(|change| change.signature == signature)
            {
                change.sequence = sequence;
            }
        }
    }

    fn cancel(&self, signature: u64) {
        if let Ok(mut pending) = self.0.lock() {
            if pending
                .as_ref()
                .is_some_and(|change| change.signature == signature)
            {
                *pending = None;
            }
        }
    }

    fn consume(&self, observed_sequence: Option<u64>, signature: u64) -> bool {
        let Ok(mut pending) = self.0.lock() else {
            return false;
        };
        let matches = pending.as_ref().is_some_and(|change| {
            change.signature == signature
                && Instant::now() <= change.expires_at
                && change
                    .sequence
                    .is_none_or(|sequence| observed_sequence == Some(sequence))
        });
        let expired = pending
            .as_ref()
            .is_some_and(|change| Instant::now() > change.expires_at);
        if matches || expired {
            *pending = None;
        }
        matches
    }
}

enum ClipboardReadAttempt<T> {
    Captured {
        snapshot: T,
        sequence: Option<u64>,
    },
    Ignored {
        package: clipboard_formats::FormatPackage,
        sequence: Option<u64>,
    },
    Retryable,
}

enum ClipboardReadOutcome<T> {
    Captured {
        snapshot: T,
        sequence: Option<u64>,
    },
    Ignored {
        package: clipboard_formats::FormatPackage,
        sequence: Option<u64>,
    },
    Exhausted,
}

struct ClipboardOmissionCandidate<'a> {
    package: &'a clipboard_formats::FormatPackage,
    sequence: Option<u64>,
}

fn monitor_omission_candidate<T>(
    outcome: &ClipboardReadOutcome<T>,
) -> Option<ClipboardOmissionCandidate<'_>> {
    match outcome {
        ClipboardReadOutcome::Ignored { package, sequence }
            if !package.omitted_formats.is_empty() =>
        {
            Some(ClipboardOmissionCandidate {
                package,
                sequence: *sequence,
            })
        }
        _ => None,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedClipboardPayload {
    kind: &'static str,
    content: String,
    captured_at: String,
    source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_app_icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_hash: Option<String>,
    formats: Vec<clipboard_formats::ClipboardFormatKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rtf_base64: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    files: Vec<clipboard_formats::CapturedFile>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    omitted_formats: Vec<clipboard_formats::ClipboardFormatKind>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteResult {
    copied: bool,
    pasted: bool,
    requires_elevation: bool,
}

struct PasteAttempt {
    result: PasteResult,
    terminal_outcome: metrics::PasteTerminalOutcome,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteTargetPayload {
    session_id: u64,
    source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_app_icon: Option<String>,
    elevated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickPanelInvocationPayload {
    session_id: u64,
    source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_app_icon: Option<String>,
    elevated: bool,
}

fn cleared_paste_target_payload(session_id: u64) -> PasteTargetPayload {
    PasteTargetPayload {
        session_id,
        source_app: String::new(),
        source_app_icon: None,
        elevated: false,
    }
}

fn snapshot_signature(snapshot: &ClipboardSnapshot) -> u64 {
    let mut hasher = DefaultHasher::new();
    match snapshot {
        ClipboardSnapshot::Text(text) => {
            0_u8.hash(&mut hasher);
            clipboard_formats::plain_text_signature(text).hash(&mut hasher);
        }
        ClipboardSnapshot::Package(package) => {
            0_u8.hash(&mut hasher);
            clipboard_formats::package_signature(package).hash(&mut hasher);
        }
        ClipboardSnapshot::Image {
            width,
            height,
            bytes,
            ..
        } => {
            1_u8.hash(&mut hasher);
            width.hash(&mut hasher);
            height.hash(&mut hasher);
            bytes.hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn clipboard_error_is_retryable(error: &ClipboardError) -> bool {
    match error {
        ClipboardError::ContentNotAvailable
        | ClipboardError::ClipboardNotSupported
        | ClipboardError::ConversionFailure => false,
        ClipboardError::ClipboardOccupied | ClipboardError::Unknown { .. } => true,
        _ => true,
    }
}

#[cfg(not(target_os = "windows"))]
fn read_clipboard_snapshot(clipboard: &mut Clipboard) -> ClipboardReadAttempt<ClipboardSnapshot> {
    let text_retryable = match clipboard.get_text() {
        Ok(text) if !text.is_empty() => {
            return ClipboardReadAttempt::Captured {
                snapshot: ClipboardSnapshot::Text(text),
                sequence: None,
            };
        }
        Ok(_) | Err(ClipboardError::ContentNotAvailable) => false,
        Err(error) => clipboard_error_is_retryable(&error),
    };

    match clipboard.get_image() {
        Ok(image)
            if image.width > 0
                && image.height > 0
                && image.bytes.len() == image.width * image.height * 4 =>
        {
            ClipboardReadAttempt::Captured {
                snapshot: ClipboardSnapshot::Image {
                    width: image.width,
                    height: image.height,
                    bytes: image.bytes.into_owned(),
                    omitted_formats: Vec::new(),
                },
                sequence: None,
            }
        }
        Ok(_) => ClipboardReadAttempt::Ignored {
            package: clipboard_formats::FormatPackage::default(),
            sequence: None,
        },
        Err(error) if text_retryable || clipboard_error_is_retryable(&error) => {
            ClipboardReadAttempt::Retryable
        }
        Err(_) => ClipboardReadAttempt::Ignored {
            package: clipboard_formats::FormatPackage::default(),
            sequence: None,
        },
    }
}

#[cfg(target_os = "windows")]
fn complete_windows_image_fallback(
    mut package: clipboard_formats::FormatPackage,
    image_before: Option<u64>,
    image: ClipboardReadAttempt<ClipboardSnapshot>,
    after_image: Option<u64>,
) -> ClipboardReadAttempt<ClipboardSnapshot> {
    if after_image != image_before {
        return ClipboardReadAttempt::Retryable;
    }
    match image {
        ClipboardReadAttempt::Captured {
            snapshot:
                ClipboardSnapshot::Image {
                    width,
                    height,
                    bytes,
                    ..
                },
            ..
        } => {
            if !clipboard_formats::clipboard_rgba_layout_is_safe(width, height, bytes.len()) {
                if !package
                    .omitted_formats
                    .contains(&clipboard_formats::ClipboardFormatKind::Image)
                {
                    package
                        .omitted_formats
                        .push(clipboard_formats::ClipboardFormatKind::Image);
                }
                ClipboardReadAttempt::Ignored {
                    package,
                    sequence: after_image,
                }
            } else {
                ClipboardReadAttempt::Captured {
                    snapshot: ClipboardSnapshot::Image {
                        width,
                        height,
                        bytes,
                        omitted_formats: package.omitted_formats,
                    },
                    sequence: after_image,
                }
            }
        }
        ClipboardReadAttempt::Captured { snapshot, .. } => ClipboardReadAttempt::Captured {
            snapshot,
            sequence: after_image,
        },
        ClipboardReadAttempt::Ignored { .. } => ClipboardReadAttempt::Ignored {
            package,
            sequence: after_image,
        },
        ClipboardReadAttempt::Retryable => ClipboardReadAttempt::Retryable,
    }
}

#[cfg(target_os = "windows")]
fn clipboard_package_allows_image_fallback(package: &clipboard_formats::FormatPackage) -> bool {
    !package
        .omitted_formats
        .contains(&clipboard_formats::ClipboardFormatKind::Image)
}

#[cfg(target_os = "windows")]
fn read_clipboard_snapshot(clipboard: &mut Clipboard) -> ClipboardReadAttempt<ClipboardSnapshot> {
    let (omitted_package, image_before) = match clipboard_formats::read_format_package() {
        clipboard_formats::PackageReadOutcome::Captured { package, sequence } => {
            return ClipboardReadAttempt::Captured {
                snapshot: ClipboardSnapshot::Package(package),
                sequence,
            };
        }
        clipboard_formats::PackageReadOutcome::Retryable => {
            return ClipboardReadAttempt::Retryable;
        }
        clipboard_formats::PackageReadOutcome::Ignored { package, sequence } => {
            if !clipboard_package_allows_image_fallback(&package) {
                return ClipboardReadAttempt::Ignored { package, sequence };
            }
            (package, sequence)
        }
    };

    // clipboard-win guard 已由 read_format_package 释放，此处才允许 arboard 图片 fallback。
    let image = match clipboard.get_image() {
        Ok(image)
            if clipboard_formats::clipboard_rgba_layout_is_safe(
                image.width,
                image.height,
                image.bytes.len(),
            ) =>
        {
            ClipboardReadAttempt::Captured {
                snapshot: ClipboardSnapshot::Image {
                    width: image.width,
                    height: image.height,
                    bytes: image.bytes.into_owned(),
                    omitted_formats: Vec::new(),
                },
                sequence: None,
            }
        }
        Ok(_) | Err(ClipboardError::ContentNotAvailable) => ClipboardReadAttempt::Ignored {
            package: clipboard_formats::FormatPackage::default(),
            sequence: None,
        },
        Err(error) if clipboard_error_is_retryable(&error) => ClipboardReadAttempt::Retryable,
        Err(_) => ClipboardReadAttempt::Ignored {
            package: clipboard_formats::FormatPackage::default(),
            sequence: None,
        },
    };
    let after_image = clipboard_sequence();
    complete_windows_image_fallback(omitted_package, image_before, image, after_image)
}

fn retry_clipboard_snapshot_read<T>(
    attempts: usize,
    delay: Duration,
    mut read: impl FnMut() -> ClipboardReadAttempt<T>,
) -> ClipboardReadOutcome<T> {
    for attempt in 0..attempts {
        match read() {
            ClipboardReadAttempt::Captured { snapshot, sequence } => {
                return ClipboardReadOutcome::Captured { snapshot, sequence };
            }
            ClipboardReadAttempt::Ignored { package, sequence } => {
                return ClipboardReadOutcome::Ignored { package, sequence };
            }
            ClipboardReadAttempt::Retryable => {
                if attempt + 1 < attempts && !delay.is_zero() {
                    thread::sleep(delay);
                }
            }
        }
    }
    ClipboardReadOutcome::Exhausted
}

fn committed_clipboard_sequence<T>(
    previous: Option<u64>,
    outcome: &ClipboardReadOutcome<T>,
) -> Option<u64> {
    match outcome {
        ClipboardReadOutcome::Captured { sequence, .. }
        | ClipboardReadOutcome::Ignored { sequence, .. } => sequence.or(previous),
        ClipboardReadOutcome::Exhausted => previous,
    }
}

fn exhausted_clipboard_sequence(observed: Option<u64>) -> Option<u64> {
    observed
}

fn exhausted_clipboard_retry_pending(
    observed: Option<u64>,
    exhausted: Option<u64>,
    retry_at: Option<Instant>,
    now: Instant,
) -> bool {
    observed.is_some() && observed == exhausted && retry_at.is_some_and(|deadline| now < deadline)
}

fn committed_capture_signature(
    previous: Option<u64>,
    candidate: u64,
    capture_enabled: bool,
    event_delivered: bool,
) -> Option<u64> {
    if capture_enabled && event_delivered {
        Some(candidate)
    } else {
        previous
    }
}

fn should_capture_snapshot(
    observed_sequence: Option<u64>,
    previous_signature: Option<u64>,
    candidate_signature: u64,
) -> bool {
    observed_sequence.is_some() || previous_signature != Some(candidate_signature)
}

fn png_data_url(image: RgbaImage) -> Option<String> {
    if !clipboard_formats::clipboard_rgba_layout_is_safe(
        image.width() as usize,
        image.height() as usize,
        image.as_raw().len(),
    ) {
        return None;
    }
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut cursor, ImageFormat::Png)
        .ok()?;
    if cursor.get_ref().len() > clipboard_formats::MAX_CLIPBOARD_IMAGE_SOURCE_BYTES {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(cursor.into_inner())
    ))
}

fn image_data_url(width: usize, height: usize, bytes: Vec<u8>) -> Option<String> {
    let width = u32::try_from(width).ok()?;
    let height = u32::try_from(height).ok()?;
    if !clipboard_formats::clipboard_rgba_layout_is_safe(
        width as usize,
        height as usize,
        bytes.len(),
    ) {
        return None;
    }
    let image = RgbaImage::from_raw(width, height, bytes)?;
    png_data_url(image)
}

/// Stable v1 identity for a decoded RGBA clipboard image. The version prefix and
/// little-endian u64 dimensions make this independent of Rust's process hasher
/// and of the machine word size.
fn image_capture_hash(width: usize, height: usize, bytes: &[u8]) -> Option<String> {
    let width_u32 = u32::try_from(width).ok()?;
    let height_u32 = u32::try_from(height).ok()?;
    if width_u32 == 0
        || height_u32 == 0
        || !clipboard_formats::clipboard_rgba_layout_is_safe(width, height, bytes.len())
    {
        return None;
    }
    let mut digest = Sha256::new();
    digest.update(b"QuickPaste:image-rgba:v1\0");
    digest.update((width as u64).to_le_bytes());
    digest.update((height as u64).to_le_bytes());
    digest.update(bytes);
    Some(format!("{:x}", digest.finalize()))
}

fn app_icon_png_data_url(width: u32, height: u32, bytes: Vec<u8>) -> Option<String> {
    if width == 0 || height == 0 {
        return None;
    }
    let expected_len = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if bytes.len() != expected_len || bytes.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        return None;
    }

    let image = RgbaImage::from_raw(width, height, bytes)?;
    let image = image::imageops::resize(
        &image,
        APP_ICON_SIZE,
        APP_ICON_SIZE,
        image::imageops::FilterType::Triangle,
    );
    png_data_url(image)
}

fn snapshot_payload(
    snapshot: ClipboardSnapshot,
    source_app: Option<SourceAppIdentity>,
) -> Option<CapturedClipboardPayload> {
    let captured_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let source_app = source_app.unwrap_or_else(|| SourceAppIdentity {
        name: "Windows 剪贴板".into(),
        icon: None,
    });
    match snapshot {
        ClipboardSnapshot::Text(content) => Some(CapturedClipboardPayload {
            kind: "text",
            content,
            captured_at,
            source_app: source_app.name,
            source_app_icon: source_app.icon,
            width: None,
            height: None,
            image_hash: None,
            formats: vec![clipboard_formats::ClipboardFormatKind::Text],
            html: None,
            rtf_base64: None,
            files: Vec::new(),
            omitted_formats: Vec::new(),
        }),
        ClipboardSnapshot::Package(package) => {
            let omitted_formats = package.omitted_formats.clone();
            let payload = clipboard_formats::package_payload(&package)?;
            Some(CapturedClipboardPayload {
                kind: payload.kind,
                content: payload.content,
                captured_at,
                source_app: source_app.name,
                source_app_icon: source_app.icon,
                width: None,
                height: None,
                image_hash: None,
                formats: payload.formats,
                html: payload.html,
                rtf_base64: payload.rtf_base64,
                files: payload.files,
                omitted_formats,
            })
        }
        ClipboardSnapshot::Image {
            width,
            height,
            bytes,
            omitted_formats,
        } => {
            let image_hash = image_capture_hash(width, height, &bytes)?;
            Some(CapturedClipboardPayload {
                kind: "image",
                content: image_data_url(width, height, bytes)?,
                captured_at,
                source_app: source_app.name,
                source_app_icon: source_app.icon,
                width: Some(width),
                height: Some(height),
                image_hash: Some(image_hash),
                formats: vec![clipboard_formats::ClipboardFormatKind::Image],
                html: None,
                rtf_base64: None,
                files: Vec::new(),
                omitted_formats,
            })
        }
    }
}

#[cfg(target_os = "windows")]
fn foreground_window_handle() -> Option<isize> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let window = unsafe { GetForegroundWindow() };
    (!window.0.is_null()).then_some(window.0 as isize)
}

#[cfg(not(target_os = "windows"))]
fn foreground_window_handle() -> Option<isize> {
    None
}

#[cfg(target_os = "windows")]
fn window_process_id(window_handle: isize) -> Option<u32> {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::GetWindowThreadProcessId};

    let window = HWND(window_handle as *mut core::ffi::c_void);
    let mut process_id = 0_u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    (process_id != 0).then_some(process_id)
}

#[cfg(target_os = "windows")]
fn root_window_handle(window_handle: isize) -> Option<isize> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GetAncestor, IsWindow, GA_ROOT},
    };

    let window = HWND(window_handle as *mut core::ffi::c_void);
    if !unsafe { IsWindow(Some(window)) }.as_bool() {
        return None;
    }
    let root = unsafe { GetAncestor(window, GA_ROOT) };
    (!root.0.is_null()).then_some(root.0 as isize)
}

#[cfg(not(target_os = "windows"))]
fn window_process_id(_window_handle: isize) -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
fn window_center_point(window_handle: isize) -> Option<ScreenPoint> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        UI::WindowsAndMessaging::GetWindowRect,
    };

    let mut rect = RECT::default();
    unsafe { GetWindowRect(HWND(window_handle as *mut core::ffi::c_void), &mut rect) }.ok()?;
    Some(ScreenPoint::new(
        (i64::from(rect.left) + (i64::from(rect.right) - i64::from(rect.left)) / 2) as i32,
        (i64::from(rect.top) + (i64::from(rect.bottom) - i64::from(rect.top)) / 2) as i32,
    ))
}

#[cfg(not(target_os = "windows"))]
fn window_center_point(_window_handle: isize) -> Option<ScreenPoint> {
    None
}

#[cfg(target_os = "windows")]
fn gui_thread_info_for_window(
    window_handle: isize,
) -> Option<(u32, windows::Win32::UI::WindowsAndMessaging::GUITHREADINFO)> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO},
    };

    let window = HWND(window_handle as *mut core::ffi::c_void);
    let thread_id = unsafe { GetWindowThreadProcessId(window, None) };
    if thread_id == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetGUIThreadInfo(thread_id, &mut info) }.ok()?;
    Some((thread_id, info))
}

#[cfg(target_os = "windows")]
fn client_rect_to_screen(
    window: windows::Win32::Foundation::HWND,
    rect: windows::Win32::Foundation::RECT,
) -> Option<ScreenRect> {
    use windows::Win32::{Foundation::POINT, Graphics::Gdi::ClientToScreen};

    let mut top_left = POINT {
        x: rect.left,
        y: rect.top,
    };
    let mut bottom_right = POINT {
        x: rect.right,
        y: rect.bottom,
    };
    if !unsafe { ClientToScreen(window, &mut top_left) }.as_bool()
        || !unsafe { ClientToScreen(window, &mut bottom_right) }.as_bool()
    {
        return None;
    }

    Some(ScreenRect::new(
        top_left.x.min(bottom_right.x),
        top_left.y.min(bottom_right.y),
        top_left.x.max(bottom_right.x),
        top_left.y.max(bottom_right.y),
    ))
}

#[cfg(target_os = "windows")]
fn caret_rect_from_gui_thread(window_handle: isize) -> Option<ScreenRect> {
    let (_, info) = gui_thread_info_for_window(window_handle)?;
    let caret_window = if !info.hwndCaret.0.is_null() {
        info.hwndCaret
    } else {
        info.hwndFocus
    };
    if caret_window.0.is_null()
        || window_process_id(caret_window.0 as isize) != window_process_id(window_handle)
    {
        return None;
    }

    client_rect_to_screen(caret_window, info.rcCaret).filter(|rect| rect.is_valid_caret())
}

#[cfg(target_os = "windows")]
struct ThreadInputAttachment {
    current_thread_id: u32,
    target_thread_id: u32,
    attached: bool,
}

#[cfg(target_os = "windows")]
impl ThreadInputAttachment {
    fn new(target_thread_id: u32) -> Option<Self> {
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};

        let current_thread_id = unsafe { GetCurrentThreadId() };
        let attached = current_thread_id != target_thread_id;
        if attached
            && !unsafe { AttachThreadInput(current_thread_id, target_thread_id, true) }.as_bool()
        {
            return None;
        }
        Some(Self {
            current_thread_id,
            target_thread_id,
            attached,
        })
    }
}

#[cfg(target_os = "windows")]
impl Drop for ThreadInputAttachment {
    fn drop(&mut self) {
        if self.attached {
            use windows::Win32::System::Threading::AttachThreadInput;

            let _ =
                unsafe { AttachThreadInput(self.current_thread_id, self.target_thread_id, false) };
        }
    }
}

#[cfg(target_os = "windows")]
fn attach_to_foreground_thread() -> Option<ThreadInputAttachment> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() {
        return None;
    }
    let foreground_thread_id = unsafe { GetWindowThreadProcessId(foreground, None) };
    (foreground_thread_id != 0)
        .then(|| ThreadInputAttachment::new(foreground_thread_id))
        .flatten()
}

#[cfg(target_os = "windows")]
fn caret_rect_from_attached_thread(window_handle: isize) -> Option<ScreenRect> {
    use windows::Win32::{
        Foundation::{POINT, RECT},
        UI::{
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::GetFocus,
            WindowsAndMessaging::{GetCaretPos, GetWindowThreadProcessId},
        },
    };

    let window = windows::Win32::Foundation::HWND(window_handle as *mut core::ffi::c_void);
    let target_thread_id = unsafe { GetWindowThreadProcessId(window, None) };
    if target_thread_id == 0 {
        return None;
    }
    let _attachment = ThreadInputAttachment::new(target_thread_id)?;
    let focus_window = unsafe { GetFocus() };
    if focus_window.0.is_null()
        || window_process_id(focus_window.0 as isize) != window_process_id(window_handle)
    {
        return None;
    }
    let mut caret = POINT::default();
    unsafe { GetCaretPos(&mut caret) }.ok()?;

    // GetCaretPos 只返回左上点；20 DIP 是 Ditto 同类回退路径使用的保守行高近似值。
    let dpi = unsafe { GetDpiForWindow(focus_window) };
    let caret_height = ((20.0 * f64::from(dpi.max(96)) / 96.0).round() as i32).max(1);
    client_rect_to_screen(
        focus_window,
        RECT {
            left: caret.x,
            top: caret.y,
            right: caret.x,
            bottom: caret.y.saturating_add(caret_height),
        },
    )
    .filter(|rect| rect.is_valid_caret())
}

#[cfg(target_os = "windows")]
struct ComInitialization;

#[cfg(target_os = "windows")]
impl Drop for ComInitialization {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
struct AccessibilityQueryGuard;

#[cfg(target_os = "windows")]
impl Drop for AccessibilityQueryGuard {
    fn drop(&mut self) {
        CARET_ACCESSIBILITY_BUSY.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "windows")]
fn accessibility_caret_rect(
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    fallback_height: i32,
) -> Option<ScreenRect> {
    if width < 0 || height < 0 {
        return None;
    }
    // Chrome 等 MSAA 提供程序偶尔只返回光标点。沿用 Ditto 的固定行高回退，
    // 避免把有效光标误判为缺失后退回鼠标位置。
    let height = if height == 0 {
        fallback_height.max(1)
    } else {
        height
    };
    let rect = ScreenRect::new(
        left,
        top,
        left.saturating_add(width),
        top.saturating_add(height),
    );
    rect.is_valid_caret().then_some(rect)
}

#[cfg(target_os = "windows")]
fn caret_rect_from_msaa(window_handle: isize) -> Option<ScreenRect> {
    use std::mem::ManuallyDrop;
    use windows::{
        core::Interface,
        Win32::{
            Foundation::HWND,
            System::{
                Com::{CoInitializeEx, COINIT_MULTITHREADED},
                Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4},
            },
            UI::{
                Accessibility::{AccessibleObjectFromWindow, IAccessible},
                HiDpi::GetDpiForWindow,
                WindowsAndMessaging::{CHILDID_SELF, OBJID_CARET},
            },
        },
    };

    if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
        return None;
    }
    let _com = ComInitialization;
    let mut object: *mut core::ffi::c_void = core::ptr::null_mut();
    unsafe {
        AccessibleObjectFromWindow(
            HWND(window_handle as *mut core::ffi::c_void),
            OBJID_CARET.0 as u32,
            &IAccessible::IID,
            &mut object,
        )
    }
    .ok()?;
    if object.is_null() {
        return None;
    }
    let accessible = unsafe { IAccessible::from_raw(object) };
    let child = VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_I4,
                Anonymous: VARIANT_0_0_0 {
                    lVal: CHILDID_SELF as i32,
                },
                ..Default::default()
            }),
        },
    };
    let mut left = 0;
    let mut top = 0;
    let mut width = 0;
    let mut height = 0;
    unsafe { accessible.accLocation(&mut left, &mut top, &mut width, &mut height, &child) }.ok()?;
    let dpi = unsafe { GetDpiForWindow(HWND(window_handle as *mut core::ffi::c_void)) };
    let fallback_height = ((20.0 * f64::from(dpi.max(96)) / 96.0).round() as i32).max(1);
    accessibility_caret_rect(left, top, width, height, fallback_height)
}

#[cfg(target_os = "windows")]
fn caret_rect_is_near_window(rect: ScreenRect, window_handle: isize) -> bool {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        UI::WindowsAndMessaging::GetWindowRect,
    };

    if !rect.is_valid_caret() {
        return false;
    }
    let mut window_rect = RECT::default();
    if unsafe {
        GetWindowRect(
            HWND(window_handle as *mut core::ffi::c_void),
            &mut window_rect,
        )
    }
    .is_err()
    {
        return false;
    }
    let tolerance = 64;
    rect.left >= window_rect.left.saturating_sub(tolerance)
        && rect.right <= window_rect.right.saturating_add(tolerance)
        && rect.top >= window_rect.top.saturating_sub(tolerance)
        && rect.bottom <= window_rect.bottom.saturating_add(tolerance)
}

#[cfg(target_os = "windows")]
fn text_caret_rect_for_window(
    window_handle: isize,
    expected_process_id: u32,
) -> Option<ScreenRect> {
    if foreground_window_handle() != Some(window_handle)
        || window_process_id(window_handle) != Some(expected_process_id)
    {
        return None;
    }

    // 某些第三方可访问性提供程序可能卡住。只允许一个在途查询；超时后后续热键立即回退，
    // 避免高频使用时为同一个故障窗口不断堆积后台线程。
    let accessibility = if CARET_ACCESSIBILITY_BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        run_with_timeout(CARET_ACCESSIBILITY_TIMEOUT, move || {
            let _query = AccessibilityQueryGuard;
            caret_rect_from_msaa(window_handle)
        })
        .flatten()
        .filter(|rect| caret_rect_is_near_window(*rect, window_handle))
    } else {
        None
    };
    let gui_thread = if accessibility.is_none() {
        caret_rect_from_gui_thread(window_handle)
            .filter(|rect| caret_rect_is_near_window(*rect, window_handle))
    } else {
        None
    };
    let attached_thread = if accessibility.is_none() && gui_thread.is_none() {
        caret_rect_from_attached_thread(window_handle)
            .filter(|rect| caret_rect_is_near_window(*rect, window_handle))
    } else {
        None
    };

    if foreground_window_handle() != Some(window_handle)
        || window_process_id(window_handle) != Some(expected_process_id)
    {
        return None;
    }
    choose_caret_rect(accessibility, gui_thread, attached_thread)
}

#[cfg(not(target_os = "windows"))]
fn text_caret_rect_for_window(
    _window_handle: isize,
    _expected_process_id: u32,
) -> Option<ScreenRect> {
    None
}

fn window_operation_result<T, E: std::fmt::Display>(
    operation: &str,
    result: Result<T, E>,
) -> Result<T, String> {
    result.map_err(|error| format!("{operation}: {error}"))
}

fn set_window_mode_internal(
    app: &AppHandle,
    mode: WindowMode,
    preferred_anchor: Option<ScreenRect>,
    preferred_monitor_hint: Option<ScreenPoint>,
) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize, Position, Size};

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_owned())?;
    let pointer = if mode == WindowMode::Library || preferred_anchor.is_none() {
        let cursor = app
            .cursor_position()
            .or_else(|_| window.cursor_position())
            .map_err(|error| error.to_string())?;
        Some(ScreenPoint::new(
            cursor.x.round() as i32,
            cursor.y.round() as i32,
        ))
    } else {
        None
    };
    let anchor = preferred_anchor
        .or_else(|| pointer.map(ScreenRect::from_point))
        .ok_or_else(|| "无法读取快捷面板定位锚点".to_owned())?;
    let monitor_point = if mode == WindowMode::Quick {
        anchor_monitor_point(anchor, preferred_monitor_hint)
    } else {
        pointer.ok_or_else(|| "无法读取窗口所在显示器".to_owned())?
    };
    let monitor = app
        .monitor_from_point(monitor_point.x as f64, monitor_point.y as f64)
        .map_err(|error| error.to_string())?
        .or(app.primary_monitor().map_err(|error| error.to_string())?)
        .ok_or_else(|| "找不到可用显示器".to_owned())?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let margin = (16.0 * scale).round() as i32;
    let work_width = work.size.width as i32;
    let work_height = work.size.height as i32;
    let work_area = ScreenRect::new(
        work.position.x + margin,
        work.position.y + margin,
        work.position.x + work_width - margin,
        work.position.y + work_height - margin,
    );
    let desired = match mode {
        WindowMode::Quick => choose_quick_panel_size_dip(anchor, work_area, scale),
        WindowMode::Library => window_size_dip(mode),
    };
    let size = fit_window_size_to_work_area(desired, work_area, scale);
    let minimum_size = window_min_size_native(mode, work_area, scale);
    let width = size.width;
    let height = size.height;
    let position = match mode {
        WindowMode::Quick => place_quick_panel_window(anchor, size, work_area, scale),
        WindowMode::Library => ScreenPoint::new(
            work_area.left + ((work_area.right - work_area.left - width).max(0) / 2),
            work_area.top + ((work_area.bottom - work_area.top - height).max(0) / 2),
        ),
    };

    window_operation_result("退出最大化状态", window.unmaximize())?;
    window
        .set_min_size(minimum_size.map(|minimum| {
            Size::Physical(PhysicalSize::new(
                minimum.width as u32,
                minimum.height as u32,
            ))
        }))
        .map_err(|error| error.to_string())?;
    window
        .set_size(Size::Physical(PhysicalSize::new(
            width as u32,
            height as u32,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            position.x, position.y,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_resizable(mode == WindowMode::Library)
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(mode == WindowMode::Quick)
        .map_err(|error| error.to_string())?;
    window
        .set_skip_taskbar(mode == WindowMode::Quick)
        .map_err(|error| error.to_string())?;
    if let Some(current_mode) = app.try_state::<CurrentWindowMode>() {
        current_mode.replace(mode);
    }
    Ok(())
}

#[tauri::command]
fn set_window_mode(mode: String, app: AppHandle) -> Result<(), String> {
    set_window_mode_internal(&app, WindowMode::parse(&mode)?, None, None)
}

#[tauri::command]
fn set_quick_panel_pinned(enabled: bool, pinned: State<'_, QuickPanelPinned>) {
    pinned.0.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn set_onboarding_window_active(
    enabled: bool,
    app: AppHandle,
    onboarding: State<'_, OnboardingWindowActive>,
) -> Result<(), String> {
    onboarding.set(enabled);
    if enabled {
        present_onboarding_window(&app)?;
    }
    Ok(())
}

fn quick_panel_ack_matches_current_session(
    current_session: &CurrentQuickPanelSession,
    session_id: u64,
) -> bool {
    session_id != 0 && current_session.current() == session_id
}

#[tauri::command]
fn record_quick_panel_first_frame(
    session_id: u64,
    current_session: State<'_, CurrentQuickPanelSession>,
    metrics: State<'_, AcceptanceMetricsState>,
) -> bool {
    if !quick_panel_ack_matches_current_session(&current_session, session_id) {
        return false;
    }
    metrics.acknowledge_quick_panel_first_frame(session_id)
}

#[cfg(target_os = "windows")]
fn process_image_path(process_id: u32) -> Option<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };

    if process_id == 0 {
        return None;
    }

    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let mut path = vec![0_u16; 32_768];
    let mut path_length = path.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut path_length,
        )
    };
    let _ = unsafe { CloseHandle(process) };
    result.ok()?;
    path.truncate(path_length as usize);
    Some(PathBuf::from(OsString::from_wide(&path)))
}

#[cfg(target_os = "windows")]
fn executable_icon_cache_key(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path = path.to_string_lossy().replace('/', "\\");
    let path = if let Some(path) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{path}")
    } else {
        path.strip_prefix("\\\\?\\").unwrap_or(&path).to_owned()
    };
    path.to_lowercase()
}

#[cfg(target_os = "windows")]
fn shell_high_resolution_icon(
    path: &Path,
) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use std::{iter, os::windows::ffi::OsStrExt};
    use windows::{
        core::PCWSTR,
        Win32::{
            Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
            UI::{
                Controls::{IImageList, ILD_TRANSPARENT},
                Shell::{
                    SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX,
                    SHIL_EXTRALARGE, SHIL_JUMBO,
                },
            },
        },
    };

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let mut file_info = SHFILEINFOW::default();
    let image_list = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        )
    };
    if image_list == 0 || file_info.iIcon < 0 {
        return None;
    }

    for image_list_size in [SHIL_JUMBO, SHIL_EXTRALARGE] {
        let Ok(image_list) = (unsafe { SHGetImageList::<IImageList>(image_list_size as i32) })
        else {
            continue;
        };
        if let Ok(icon) = unsafe { image_list.GetIcon(file_info.iIcon, ILD_TRANSPARENT.0) } {
            return Some(icon);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn rgba_from_icon(
    icon: windows::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<(u32, u32, Vec<u8>)> {
    use windows::{
        core::IUnknown,
        Win32::{
            Graphics::Imaging::{
                CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory,
                IWICPalette, WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
            },
            System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
        },
    };

    let factory: IWICImagingFactory = unsafe {
        CoCreateInstance(
            &CLSID_WICImagingFactory,
            None::<&IUnknown>,
            CLSCTX_INPROC_SERVER,
        )
    }
    .ok()?;
    let bitmap = unsafe { factory.CreateBitmapFromHICON(icon) }.ok()?;
    let converter = unsafe { factory.CreateFormatConverter() }.ok()?;
    unsafe {
        converter.Initialize(
            &bitmap,
            &GUID_WICPixelFormat32bppRGBA,
            WICBitmapDitherTypeNone,
            None::<&IWICPalette>,
            0.0,
            WICBitmapPaletteTypeCustom,
        )
    }
    .ok()?;

    let mut width = 0_u32;
    let mut height = 0_u32;
    unsafe { converter.GetSize(&mut width, &mut height) }.ok()?;
    let stride = width.checked_mul(4)?;
    let buffer_len = (stride as usize).checked_mul(height as usize)?;
    let mut rgba = vec![0_u8; buffer_len];
    unsafe { converter.CopyPixels(std::ptr::null(), stride, &mut rgba) }.ok()?;
    Some((width, height, rgba))
}

#[cfg(target_os = "windows")]
fn extract_app_icon(path: &Path) -> Option<String> {
    use windows::Win32::{
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
        UI::WindowsAndMessaging::DestroyIcon,
    };

    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let icon = shell_high_resolution_icon(path);
    let result = icon.and_then(|icon| {
        let rgba = rgba_from_icon(icon);
        let _ = unsafe { DestroyIcon(icon) };
        rgba.and_then(|(width, height, bytes)| app_icon_png_data_url(width, height, bytes))
    });
    if com_initialized {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(target_os = "windows")]
fn app_icon_for_executable(path: &Path) -> Option<String> {
    static CACHE: OnceLock<Mutex<AppIconCache>> = OnceLock::new();

    let key = executable_icon_cache_key(path);
    let cache = CACHE.get_or_init(|| Mutex::new(AppIconCache::new(APP_ICON_CACHE_CAPACITY)));
    if let Some(icon) = cache.lock().ok().and_then(|cache| cache.get(&key)) {
        return icon;
    }

    let icon = extract_app_icon(path);
    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, icon.clone());
    }
    icon
}

#[cfg(target_os = "windows")]
fn source_app_identity_for_process_id(process_id: u32) -> Option<SourceAppIdentity> {
    let path = process_image_path(process_id)?;
    Some(SourceAppIdentity {
        name: friendly_app_name(path.to_string_lossy().as_ref()),
        icon: app_icon_for_executable(&path),
    })
}

#[cfg(not(target_os = "windows"))]
fn source_app_identity_for_process_id(_process_id: u32) -> Option<SourceAppIdentity> {
    None
}

fn source_app_identity_for_window(window_handle: isize) -> Option<SourceAppIdentity> {
    window_process_id(window_handle).and_then(source_app_identity_for_process_id)
}

fn foreground_source_app() -> Option<SourceAppIdentity> {
    foreground_window_handle().and_then(source_app_identity_for_window)
}

fn choose_clipboard_source(
    clipboard_owner: Option<SourceAppIdentity>,
    foreground_app: Option<SourceAppIdentity>,
) -> Option<SourceAppIdentity> {
    clipboard_owner.or(foreground_app)
}

#[cfg(target_os = "windows")]
fn clipboard_owner_source_app() -> Option<SourceAppIdentity> {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetClipboardOwner() -> *mut core::ffi::c_void;
    }

    let window = unsafe { GetClipboardOwner() };
    (!window.is_null())
        .then_some(window as isize)
        .and_then(source_app_identity_for_window)
}

#[cfg(not(target_os = "windows"))]
fn clipboard_owner_source_app() -> Option<SourceAppIdentity> {
    None
}

#[cfg(target_os = "windows")]
fn process_is_elevated(process: windows::Win32::Foundation::HANDLE) -> Option<bool> {
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::OpenProcessToken,
    };

    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned_length = 0_u32;
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned_length,
        )
    };
    let _ = unsafe { CloseHandle(token) };
    result.ok()?;
    Some(elevation.TokenIsElevated != 0)
}

#[cfg(target_os = "windows")]
fn current_process_is_elevated() -> Option<bool> {
    use windows::Win32::System::Threading::GetCurrentProcess;

    process_is_elevated(unsafe { GetCurrentProcess() })
}

#[cfg(not(target_os = "windows"))]
fn current_process_is_elevated() -> Option<bool> {
    Some(false)
}

fn main_process_startup_allowed(elevated: Option<bool>) -> bool {
    elevated == Some(false)
}

#[cfg(target_os = "windows")]
fn show_elevated_main_process_warning() {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{
        core::PCWSTR,
        Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK},
    };

    let title = OsStr::new("闪电剪贴板 QuickPaste")
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let message = OsStr::new(
        "闪电剪贴板主程序不能以管理员身份常驻运行。\n\n请关闭后正常启动；向管理员窗口粘贴时，闪电剪贴板只会为该次操作请求授权。",
    )
    .encode_wide()
    .chain(Some(0))
    .collect::<Vec<_>>();
    let _ = unsafe {
        MessageBoxW(
            None,
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONWARNING,
        )
    };
}

#[cfg(not(target_os = "windows"))]
fn show_elevated_main_process_warning() {}

#[cfg(target_os = "windows")]
fn process_id_is_elevated(process_id: u32) -> Option<bool> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let elevated = process_is_elevated(process);
    let _ = unsafe { CloseHandle(process) };
    elevated
}

#[cfg(not(target_os = "windows"))]
fn process_id_is_elevated(_process_id: u32) -> Option<bool> {
    Some(false)
}

#[cfg(target_os = "windows")]
fn window_is_elevated(window_handle: isize) -> Option<bool> {
    window_process_id(window_handle).and_then(process_id_is_elevated)
}

#[cfg(target_os = "windows")]
fn focused_child_window(window_handle: isize, process_id: u32) -> Option<isize> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            GetGUIThreadInfo, GetWindowThreadProcessId, IsWindow, GUITHREADINFO,
        },
    };

    let target = HWND(window_handle as *mut core::ffi::c_void);
    let thread_id = unsafe { GetWindowThreadProcessId(target, None) };
    if thread_id == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(thread_id, &mut info) }.is_err() {
        return None;
    }
    let focused = if info.hwndFocus.0.is_null() {
        target
    } else {
        info.hwndFocus
    };
    let focused_handle = focused.0 as isize;
    (unsafe { IsWindow(Some(focused)) }.as_bool()
        && window_process_id(focused_handle) == Some(process_id)
        && root_window_handle(focused_handle) == Some(window_handle))
    .then_some(focused_handle)
}

#[cfg(target_os = "windows")]
fn capture_foreground_paste_target(app: &AppHandle) -> Option<ForegroundPasteTargetSnapshot> {
    let window_handle = foreground_window_handle()?;
    let process_id = window_process_id(window_handle)?;
    let own_window_handle = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|window| window.0 as isize);
    if !foreground_target_is_eligible(
        window_handle,
        process_id,
        std::process::id(),
        own_window_handle,
    ) {
        return None;
    }

    Some(ForegroundPasteTargetSnapshot {
        identity: PasteTargetIdentity {
            window_handle,
            focus_window_handle: focused_child_window(window_handle, process_id),
            process_id,
            captured_at: Instant::now(),
        },
        source_app: source_app_identity_for_process_id(process_id),
        elevated: process_id_is_elevated(process_id).unwrap_or(true),
    })
}

#[cfg(not(target_os = "windows"))]
fn capture_foreground_paste_target(_app: &AppHandle) -> Option<ForegroundPasteTargetSnapshot> {
    None
}

#[cfg(not(target_os = "windows"))]
fn window_is_elevated(_window_handle: isize) -> Option<bool> {
    Some(false)
}

#[cfg(target_os = "windows")]
fn ctrl_v_inputs() -> [windows::Win32::UI::Input::KeyboardAndMouse::INPUT; 4] {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL, VK_V,
    };

    fn key_input(key: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        }
    }

    [
        key_input(VK_CONTROL, KEYBD_EVENT_FLAGS::default()),
        key_input(VK_V, KEYBD_EVENT_FLAGS::default()),
        key_input(VK_V, KEYEVENTF_KEYUP),
        key_input(VK_CONTROL, KEYEVENTF_KEYUP),
    ]
}

fn modifier_states_are_released(states: &[bool]) -> bool {
    states.iter().all(|pressed| !pressed)
}

fn ctrl_v_partial_cleanup_range(sent: u32) -> Option<(usize, usize)> {
    match sent {
        // Ctrl down 已进入输入流，只补 Ctrl up。
        1 | 3 => Some((3, 4)),
        // Ctrl down、V down 已进入输入流，按相反顺序补两次 key-up。
        2 => Some((2, 4)),
        _ => None,
    }
}

fn wait_for_target_activation_settle(activated_at: Instant) {
    let elapsed = activated_at.elapsed();
    if elapsed < TARGET_ACTIVATION_SETTLE_DELAY {
        thread::sleep(TARGET_ACTIVATION_SETTLE_DELAY - elapsed);
    }
}

fn helper_deadline_allows_injection(deadline_ms: u64, now_ms: u64) -> bool {
    deadline_ms > now_ms
}

fn elevated_helper_request_is_active(deadline_ms: u64, now_ms: u64, cancelled: bool) -> bool {
    !cancelled && helper_deadline_allows_injection(deadline_ms, now_ms)
}

fn try_acquire_elevated_helper_slot(busy: &AtomicBool) -> bool {
    busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn release_elevated_helper_slot(busy: &AtomicBool) {
    busy.store(false, Ordering::Release);
}

struct ElevatedHelperSlotGuard(&'static AtomicBool);

impl Drop for ElevatedHelperSlotGuard {
    fn drop(&mut self) {
        release_elevated_helper_slot(self.0);
    }
}

fn unix_time_millis() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(target_os = "windows")]
fn physical_modifier_states() -> [bool; 5] {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };

    [VK_MENU, VK_SHIFT, VK_CONTROL, VK_LWIN, VK_RWIN]
        .map(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0)
}

#[cfg(target_os = "windows")]
fn wait_for_physical_modifiers_released(deadline_ms: Option<u64>) -> bool {
    let started = Instant::now();
    loop {
        if deadline_ms.is_some_and(|deadline| {
            unix_time_millis().is_none_or(|now| !helper_deadline_allows_injection(deadline, now))
        }) {
            return false;
        }
        if modifier_states_are_released(&physical_modifier_states()) {
            return true;
        }
        if started.elapsed() >= MODIFIER_RELEASE_TIMEOUT {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "windows")]
fn target_identity_is_current(identity: &PasteTargetIdentity) -> bool {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::IsWindow};

    if identity.process_id == 0 || identity.captured_at.elapsed() > PASTE_TARGET_TTL {
        return false;
    }
    let target = HWND(identity.window_handle as *mut core::ffi::c_void);
    unsafe { IsWindow(Some(target)) }.as_bool()
        && window_process_id(identity.window_handle) == Some(identity.process_id)
}

fn focus_snapshot_matches_target(
    identity: &PasteTargetIdentity,
    focused_window_handle: isize,
    focused_root_window_handle: Option<isize>,
    focused_process_id: Option<u32>,
) -> bool {
    let expected_focus = identity
        .focus_window_handle
        .unwrap_or(identity.window_handle);
    focused_window_handle != 0
        && focused_window_handle == expected_focus
        && focused_root_window_handle == Some(identity.window_handle)
        && focused_process_id == Some(identity.process_id)
}

#[cfg(not(target_os = "windows"))]
fn target_identity_is_current(_identity: &PasteTargetIdentity) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn restore_target_focus(identity: &PasteTargetIdentity) -> bool {
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Input::KeyboardAndMouse::SetFocus,
            WindowsAndMessaging::{GetForegroundWindow, IsWindow},
        },
    };

    let focus_window_handle = identity
        .focus_window_handle
        .unwrap_or(identity.window_handle);
    let focus = HWND(focus_window_handle as *mut core::ffi::c_void);
    if !unsafe { IsWindow(Some(focus)) }.as_bool()
        || window_process_id(focus_window_handle) != Some(identity.process_id)
        || root_window_handle(focus_window_handle) != Some(identity.window_handle)
    {
        return false;
    }
    let target = HWND(identity.window_handle as *mut core::ffi::c_void);
    let Some((target_thread_id, _)) = gui_thread_info_for_window(identity.window_handle) else {
        return false;
    };
    let Some(_attachment) = ThreadInputAttachment::new(target_thread_id) else {
        return false;
    };
    if focus_window_handle != identity.window_handle {
        // SetFocus 返回的是“此前焦点窗口”；此前无焦点时成功也可能返回 NULL，
        // 因此不能用 windows-rs 的 Result 判断本次设置是否成功。
        let _ = unsafe { SetFocus(Some(focus)) };
    }

    let Some((_, info)) = gui_thread_info_for_window(identity.window_handle) else {
        return false;
    };
    let focused = if info.hwndFocus.0.is_null() {
        info.hwndActive
    } else {
        info.hwndFocus
    };
    let focused_window_handle = focused.0 as isize;
    (unsafe { GetForegroundWindow() }) == target
        && info.hwndActive == target
        && focus_snapshot_matches_target(
            identity,
            focused_window_handle,
            root_window_handle(focused_window_handle),
            window_process_id(focused_window_handle),
        )
}

#[cfg(target_os = "windows")]
fn focus_target_and_send_ctrl_v(
    identity: &PasteTargetIdentity,
    deadline_ms: Option<u64>,
    expected_clipboard_sequence: Option<u64>,
) -> bool {
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Input::KeyboardAndMouse::{SendInput, INPUT},
            WindowsAndMessaging::{
                BringWindowToTop, GetForegroundWindow, IsIconic, SetForegroundWindow, ShowWindow,
                SW_RESTORE,
            },
        },
    };

    if !target_identity_is_current(identity)
        || expected_clipboard_sequence
            .is_some_and(|expected| !clipboard_sequence_matches(expected, clipboard_sequence()))
    {
        return false;
    }
    let target = HWND(identity.window_handle as *mut core::ffi::c_void);
    if unsafe { IsIconic(target) }.as_bool() {
        let _ = unsafe { ShowWindow(target, SW_RESTORE) };
    }

    let focused = {
        // Ditto 在切换回原窗口前先共享当前前台线程的输入队列，避免后台 IPC
        // 线程直接调用 SetForegroundWindow 时丢失焦点交接资格。
        let _foreground_attachment = attach_to_foreground_thread();
        (0..FOREGROUND_ACTIVATION_ATTEMPTS).any(|_| {
            let _ = unsafe { BringWindowToTop(target) };
            let _ = unsafe { SetForegroundWindow(target) };
            if unsafe { GetForegroundWindow() } == target {
                true
            } else {
                thread::sleep(FOREGROUND_ACTIVATION_RETRY_DELAY);
                false
            }
        })
    };
    if !focused
        || !target_identity_is_current(identity)
        || unsafe { GetForegroundWindow() } != target
        || !restore_target_focus(identity)
        || expected_clipboard_sequence
            .is_some_and(|expected| !clipboard_sequence_matches(expected, clipboard_sequence()))
    {
        return false;
    }

    let activated_at = Instant::now();
    // 快捷键松开前不注入 Ctrl+V，避免与用户仍按住的 Alt/Shift/Ctrl/Win 混键。
    if !wait_for_physical_modifiers_released(deadline_ms)
        || !target_identity_is_current(identity)
        || unsafe { GetForegroundWindow() } != target
        || !restore_target_focus(identity)
        || deadline_ms.is_some_and(|deadline| {
            unix_time_millis().is_none_or(|now| !helper_deadline_allows_injection(deadline, now))
        })
        || expected_clipboard_sequence
            .is_some_and(|expected| !clipboard_sequence_matches(expected, clipboard_sequence()))
    {
        return false;
    }

    // Ditto 默认在激活目标后留出 100ms；Chrome 等多进程窗口会在顶层 HWND
    // 已成为前台后继续异步恢复编辑控件焦点，因此发送输入前保留同等稳定期。
    wait_for_target_activation_settle(activated_at);
    if !target_identity_is_current(identity)
        || unsafe { GetForegroundWindow() } != target
        || !restore_target_focus(identity)
        || deadline_ms.is_some_and(|deadline| {
            unix_time_millis().is_none_or(|now| !helper_deadline_allows_injection(deadline, now))
        })
        || expected_clipboard_sequence
            .is_some_and(|expected| !clipboard_sequence_matches(expected, clipboard_sequence()))
    {
        return false;
    }

    let inputs = ctrl_v_inputs();
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if let Some((start, end)) = ctrl_v_partial_cleanup_range(sent) {
        let cleanup = &inputs[start..end];
        let _ = unsafe { SendInput(cleanup, std::mem::size_of::<INPUT>() as i32) };
    }
    sent == inputs.len() as u32
}

#[cfg(target_os = "windows")]
fn paste_into_window(
    app: &AppHandle,
    identity: &PasteTargetIdentity,
    keep_quick_panel_visible: bool,
    expected_clipboard_sequence: u64,
) -> bool {
    if !target_identity_is_current(identity) {
        return false;
    }

    let quickpaste_window = app.get_webview_window("main");
    if !keep_quick_panel_visible {
        if let Some(window) = &quickpaste_window {
            let _ = window.hide();
        }
        thread::sleep(Duration::from_millis(55));
    }

    let pasted = focus_target_and_send_ctrl_v(identity, None, Some(expected_clipboard_sequence));
    if !pasted && !keep_quick_panel_visible {
        if let Some(window) = quickpaste_window {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    pasted
}

#[cfg(not(target_os = "windows"))]
fn paste_into_window(
    _app: &AppHandle,
    _identity: &PasteTargetIdentity,
    _keep_quick_panel_visible: bool,
    _expected_clipboard_sequence: u64,
) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn launch_elevated_paste_helper_blocking(
    identity: &PasteTargetIdentity,
    expected_clipboard_sequence: u64,
    cancelled: &AtomicBool,
) -> bool {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HWND, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{
                GetExitCodeProcess, GetProcessId, TerminateProcess, WaitForSingleObject,
            },
            UI::{
                Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
                WindowsAndMessaging::SW_HIDE,
            },
        },
    };

    if cancelled.load(Ordering::Acquire)
        || !target_identity_is_current(identity)
        || !clipboard_sequence_matches(expected_clipboard_sequence, clipboard_sequence())
    {
        return false;
    }
    let deadline_ms = match unix_time_millis() {
        Some(now) => now.saturating_add(ELEVATED_HELPER_REQUEST_TTL_MS),
        None => return false,
    };
    let nonce = match elevated_request_nonce() {
        Some(nonce) => nonce,
        None => return false,
    };
    let request = ElevatedPasteRequest {
        window_handle: identity.window_handle,
        focus_window_handle: identity.focus_window_handle,
        process_id: identity.process_id,
        deadline_ms,
        nonce: nonce.clone(),
        clipboard_sequence: expected_clipboard_sequence,
    };
    // 管道必须先于 UAC helper 创建，且首实例标记阻止同名服务端抢占。
    let request_pipe = match create_elevated_request_pipe(&nonce) {
        Some(pipe) => pipe,
        None => return false,
    };
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return false,
    };
    let executable_wide: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let verb_wide: Vec<u16> = OsStr::new("runas").encode_wide().chain(Some(0)).collect();
    let parameters = format!(
        "{ELEVATED_HELPER_PROTOCOL_FLAG} {} {} {}",
        std::process::id(),
        request.deadline_ms,
        request.nonce
    );
    let parameters_wide: Vec<u16> = OsStr::new(&parameters)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: HWND::default(),
        lpVerb: PCWSTR(verb_wide.as_ptr()),
        lpFile: PCWSTR(executable_wide.as_ptr()),
        lpParameters: PCWSTR(parameters_wide.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if unsafe { ShellExecuteExW(&mut execute) }.is_err() || execute.hProcess.is_invalid() {
        return false;
    }

    let request_still_valid = || {
        unix_time_millis().is_some_and(|now| {
            elevated_helper_request_is_active(
                request.deadline_ms,
                now,
                cancelled.load(Ordering::Acquire),
            )
        }) && target_identity_is_current(identity)
            && clipboard_sequence_matches(expected_clipboard_sequence, clipboard_sequence())
    };
    if !request_still_valid() {
        let _ = unsafe { TerminateProcess(execute.hProcess, 3) };
        let _ = unsafe { WaitForSingleObject(execute.hProcess, 2_000) };
        let _ = unsafe { CloseHandle(execute.hProcess) };
        return false;
    }

    let helper_process_id = unsafe { GetProcessId(execute.hProcess) };
    let authenticated = helper_process_id != 0
        && wait_for_elevated_helper_connection(
            &request_pipe,
            execute.hProcess,
            helper_process_id,
            request.deadline_ms,
            cancelled,
        )
        && request_still_valid()
        && write_elevated_request_to_pipe(&request_pipe, &request);
    if !authenticated {
        let _ = unsafe { TerminateProcess(execute.hProcess, 3) };
        let _ = unsafe { WaitForSingleObject(execute.hProcess, 2_000) };
        let _ = unsafe { CloseHandle(execute.hProcess) };
        return false;
    }

    let remaining_wait = unix_time_millis()
        .map(|now| {
            request
                .deadline_ms
                .saturating_sub(now)
                .saturating_add(2_000)
        })
        .unwrap_or_default()
        .min(u64::from(ELEVATED_HELPER_WAIT_TIMEOUT_MS)) as u32;
    let wait_result = unsafe { WaitForSingleObject(execute.hProcess, remaining_wait) };
    let completed = wait_result == WAIT_OBJECT_0;
    if wait_result == WAIT_TIMEOUT {
        let _ = unsafe { TerminateProcess(execute.hProcess, 3) };
        let _ = unsafe { WaitForSingleObject(execute.hProcess, 2_000) };
    }
    let mut exit_code = u32::MAX;
    let exit_code_read =
        completed && unsafe { GetExitCodeProcess(execute.hProcess, &mut exit_code) }.is_ok();
    let _ = unsafe { CloseHandle(execute.hProcess) };
    completed && exit_code_read && exit_code == 0
}

#[cfg(target_os = "windows")]
fn launch_elevated_paste_helper(
    identity: &PasteTargetIdentity,
    expected_clipboard_sequence: u64,
) -> bool {
    if !try_acquire_elevated_helper_slot(&ELEVATED_HELPER_BUSY) {
        return false;
    }
    let identity = identity.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let result = run_with_timeout(
        Duration::from_millis(ELEVATED_HELPER_WAIT_TIMEOUT_MS as u64),
        move || {
            let _slot = ElevatedHelperSlotGuard(&ELEVATED_HELPER_BUSY);
            launch_elevated_paste_helper_blocking(
                &identity,
                expected_clipboard_sequence,
                &worker_cancelled,
            )
        },
    );
    if result.is_none() {
        cancelled.store(true, Ordering::Release);
    }
    result.unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn launch_elevated_paste_helper(
    _identity: &PasteTargetIdentity,
    _expected_clipboard_sequence: u64,
) -> bool {
    false
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ElevatedPasteRequest {
    window_handle: isize,
    focus_window_handle: Option<isize>,
    process_id: u32,
    deadline_ms: u64,
    nonce: String,
    clipboard_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ElevatedHelperInvocation {
    parent_process_id: u32,
    deadline_ms: u64,
    nonce: String,
}

fn valid_request_nonce(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(target_os = "windows")]
fn elevated_request_nonce() -> Option<String> {
    use windows::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    let mut bytes = [0_u8; 16];
    let status = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    (status.0 >= 0).then(|| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn elevated_pipe_name(nonce: &str) -> Option<String> {
    valid_request_nonce(nonce).then(|| format!(r"\\.\pipe\{ELEVATED_PIPE_NAMESPACE}.{nonce}"))
}

fn elevated_request_message(request: &ElevatedPasteRequest) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n",
        request.window_handle,
        request.focus_window_handle.unwrap_or_default(),
        request.process_id,
        request.deadline_ms,
        request.clipboard_sequence,
        request.nonce
    )
}

fn parse_elevated_request_message(value: &str) -> Option<ElevatedPasteRequest> {
    if value.len() > ELEVATED_REQUEST_MAX_BYTES {
        return None;
    }
    let lines = value.lines().collect::<Vec<_>>();
    if lines.len() != 6 || !valid_request_nonce(lines[5]) {
        return None;
    }
    let focus_window_handle = lines[1].parse::<isize>().ok()?;
    let request = ElevatedPasteRequest {
        window_handle: lines[0].parse().ok()?,
        focus_window_handle: (focus_window_handle != 0).then_some(focus_window_handle),
        process_id: lines[2].parse().ok()?,
        deadline_ms: lines[3].parse().ok()?,
        clipboard_sequence: lines[4].parse().ok()?,
        nonce: lines[5].into(),
    };
    (request.window_handle != 0
        && request.process_id != 0
        && request.deadline_ms != 0
        && request.clipboard_sequence != 0)
        .then_some(request)
}

fn elevated_helper_client_is_trusted(client_process_id: u32, launched_process_id: u32) -> bool {
    launched_process_id != 0 && client_process_id == launched_process_id
}

fn elevated_helper_server_is_trusted(
    server_process_id: u32,
    expected_parent_process_id: u32,
    current_process_id: u32,
    server_elevated: Option<bool>,
    same_executable: bool,
) -> bool {
    server_process_id != 0
        && server_process_id == expected_parent_process_id
        && server_process_id != current_process_id
        && server_elevated == Some(false)
        && same_executable
}

#[cfg(target_os = "windows")]
struct OwnedWindowsHandle(windows::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Drop for OwnedWindowsHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(target_os = "windows")]
fn process_uses_current_executable(process_id: u32) -> bool {
    fn normalized(path: PathBuf) -> Option<String> {
        let path = fs::canonicalize(path).ok()?;
        let value = path.to_string_lossy().replace('/', "\\");
        Some(value.strip_prefix(r"\\?\").unwrap_or(&value).to_lowercase())
    }

    let Some(process_path) = process_image_path(process_id).and_then(normalized) else {
        return false;
    };
    std::env::current_exe()
        .ok()
        .and_then(normalized)
        .is_some_and(|current_path| current_path == process_path)
}

#[cfg(target_os = "windows")]
fn create_elevated_request_pipe(nonce: &str) -> Option<OwnedWindowsHandle> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{
        core::PCWSTR,
        Win32::{
            Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_OUTBOUND},
            System::Pipes::{
                CreateNamedPipeW, PIPE_NOWAIT, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_TYPE_MESSAGE,
            },
        },
    };

    let pipe_name = elevated_pipe_name(nonce)?;
    let pipe_name_wide = OsStr::new(&pipe_name)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(pipe_name_wide.as_ptr()),
            PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            ELEVATED_PIPE_BUFFER_BYTES,
            0,
            ELEVATED_HELPER_WAIT_TIMEOUT_MS,
            None,
        )
    };
    (!handle.is_invalid()).then_some(OwnedWindowsHandle(handle))
}

#[cfg(target_os = "windows")]
fn wait_for_elevated_helper_connection(
    pipe: &OwnedWindowsHandle,
    helper_process: windows::Win32::Foundation::HANDLE,
    helper_process_id: u32,
    deadline_ms: u64,
    cancelled: &AtomicBool,
) -> bool {
    use windows::{
        core::HRESULT,
        Win32::{
            Foundation::{ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, WAIT_OBJECT_0},
            System::{
                Pipes::{ConnectNamedPipe, DisconnectNamedPipe, GetNamedPipeClientProcessId},
                Threading::WaitForSingleObject,
            },
        },
    };

    let started = Instant::now();
    loop {
        if started.elapsed() >= Duration::from_millis(u64::from(ELEVATED_HELPER_WAIT_TIMEOUT_MS))
            || unix_time_millis().is_none_or(|now| {
                !elevated_helper_request_is_active(
                    deadline_ms,
                    now,
                    cancelled.load(Ordering::Acquire),
                )
            })
            || unsafe { WaitForSingleObject(helper_process, 0) } == WAIT_OBJECT_0
        {
            return false;
        }

        match unsafe { ConnectNamedPipe(pipe.0, None) } {
            Ok(()) => {}
            Err(error) if error.code() == HRESULT::from_win32(ERROR_PIPE_CONNECTED.0) => {
                let mut client_process_id = 0_u32;
                let authenticated =
                    unsafe { GetNamedPipeClientProcessId(pipe.0, &mut client_process_id) }.is_ok()
                        && elevated_helper_client_is_trusted(client_process_id, helper_process_id);
                if authenticated {
                    return true;
                }
                let _ = unsafe { DisconnectNamedPipe(pipe.0) };
            }
            Err(error) if error.code() == HRESULT::from_win32(ERROR_PIPE_LISTENING.0) => {}
            Err(_) => return false,
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "windows")]
fn write_elevated_request_to_pipe(
    pipe: &OwnedWindowsHandle,
    request: &ElevatedPasteRequest,
) -> bool {
    use windows::Win32::Storage::FileSystem::WriteFile;

    let message = elevated_request_message(request);
    if message.len() > ELEVATED_REQUEST_MAX_BYTES {
        return false;
    }
    let mut written = 0_u32;
    unsafe { WriteFile(pipe.0, Some(message.as_bytes()), Some(&mut written), None) }.is_ok()
        && written as usize == message.len()
}

#[cfg(target_os = "windows")]
fn read_authenticated_elevated_request(
    invocation: &ElevatedHelperInvocation,
) -> Option<ElevatedPasteRequest> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::GENERIC_READ,
            Storage::FileSystem::{
                CreateFileW, ReadFile, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING,
                SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
            },
            System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW},
        },
    };

    let now_ms = unix_time_millis()?;
    let remaining_ms = invocation.deadline_ms.checked_sub(now_ms)?;
    if remaining_ms == 0 {
        return None;
    }
    let pipe_name = elevated_pipe_name(&invocation.nonce)?;
    let pipe_name_wide = OsStr::new(&pipe_name)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if !unsafe {
        WaitNamedPipeW(
            PCWSTR(pipe_name_wide.as_ptr()),
            remaining_ms.min(u64::from(ELEVATED_HELPER_WAIT_TIMEOUT_MS)) as u32,
        )
    }
    .as_bool()
    {
        return None;
    }
    let pipe = OwnedWindowsHandle(
        unsafe {
            CreateFileW(
                PCWSTR(pipe_name_wide.as_ptr()),
                GENERIC_READ.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                None,
            )
        }
        .ok()?,
    );

    let mut server_process_id = 0_u32;
    unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server_process_id) }.ok()?;
    if !elevated_helper_server_is_trusted(
        server_process_id,
        invocation.parent_process_id,
        std::process::id(),
        process_id_is_elevated(server_process_id),
        process_uses_current_executable(server_process_id),
    ) {
        return None;
    }

    let mut bytes = [0_u8; ELEVATED_REQUEST_MAX_BYTES];
    let mut read = 0_u32;
    unsafe { ReadFile(pipe.0, Some(&mut bytes), Some(&mut read), None) }.ok()?;
    let message = std::str::from_utf8(&bytes[..read as usize]).ok()?;
    let request = parse_elevated_request_message(message)?;
    (request.nonce == invocation.nonce && request.deadline_ms == invocation.deadline_ms)
        .then_some(request)
}

#[cfg(target_os = "windows")]
fn parse_elevated_helper_arguments(
    arguments: &[String],
) -> Option<Result<ElevatedHelperInvocation, ()>> {
    if arguments.first().map(String::as_str) != Some(ELEVATED_HELPER_PROTOCOL_FLAG) {
        return None;
    }
    if arguments.len() != 4 {
        return Some(Err(()));
    }

    Some((|| {
        let invocation = ElevatedHelperInvocation {
            parent_process_id: arguments[1].parse().map_err(|_| ())?,
            deadline_ms: arguments[2].parse().map_err(|_| ())?,
            nonce: arguments[3].clone(),
        };
        (invocation.parent_process_id != 0
            && invocation.deadline_ms != 0
            && valid_request_nonce(&invocation.nonce))
        .then_some(invocation)
        .ok_or(())
    })())
}

#[cfg(target_os = "windows")]
fn maybe_run_elevated_paste_helper() -> Option<i32> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let invocation = match parse_elevated_helper_arguments(&arguments)? {
        Ok(invocation) => invocation,
        Err(()) => return Some(2),
    };
    let now_ms = match unix_time_millis() {
        Some(now) => now,
        None => return Some(2),
    };
    if current_process_is_elevated() != Some(true)
        || !helper_deadline_allows_injection(invocation.deadline_ms, now_ms)
    {
        return Some(2);
    }
    let request = match read_authenticated_elevated_request(&invocation) {
        Some(request) => request,
        None => return Some(2),
    };
    let identity = PasteTargetIdentity {
        window_handle: request.window_handle,
        focus_window_handle: request.focus_window_handle,
        process_id: request.process_id,
        captured_at: Instant::now(),
    };

    let allowed = window_is_elevated(request.window_handle) == Some(true)
        && target_identity_is_current(&identity)
        && clipboard_sequence_matches(request.clipboard_sequence, clipboard_sequence())
        && helper_deadline_allows_injection(
            request.deadline_ms,
            unix_time_millis().unwrap_or(u64::MAX),
        );
    Some(
        if allowed
            && focus_target_and_send_ctrl_v(
                &identity,
                Some(request.deadline_ms),
                Some(request.clipboard_sequence),
            )
        {
            0
        } else {
            2
        },
    )
}

#[cfg(not(target_os = "windows"))]
fn maybe_run_elevated_paste_helper() -> Option<i32> {
    None
}

#[cfg(target_os = "windows")]
fn clipboard_sequence() -> Option<u64> {
    clipboard_win::raw::seq_num().map(|value| value.get() as u64)
}

#[cfg(not(target_os = "windows"))]
fn clipboard_sequence() -> Option<u64> {
    None
}

fn clipboard_sequence_matches(expected: u64, observed: Option<u64>) -> bool {
    expected != 0 && observed == Some(expected)
}

fn stable_verified_clipboard_sequence(
    before: Option<u64>,
    content_matches: bool,
    after: Option<u64>,
) -> Option<u64> {
    match (before, after) {
        (Some(before), Some(after)) if before == after && content_matches => Some(after),
        _ => None,
    }
}

fn clipboard_matches_snapshot(expected: &ClipboardSnapshot) -> Option<bool> {
    match expected {
        ClipboardSnapshot::Text(expected) => {
            let mut clipboard = Clipboard::new().ok()?;
            Some(clipboard.get_text().ok()?.as_str() == expected.as_str())
        }
        ClipboardSnapshot::Package(expected) => match clipboard_formats::read_format_package() {
            clipboard_formats::PackageReadOutcome::Captured {
                package: actual, ..
            } => Some(clipboard_formats::package_matches_requested(
                expected, &actual,
            )),
            clipboard_formats::PackageReadOutcome::Ignored { .. } => Some(false),
            clipboard_formats::PackageReadOutcome::Retryable => None,
        },
        ClipboardSnapshot::Image {
            width,
            height,
            bytes,
            ..
        } => {
            let mut clipboard = Clipboard::new().ok()?;
            let actual = clipboard.get_image().ok()?;
            Some(
                actual.width == *width
                    && actual.height == *height
                    && actual.bytes.as_ref() == bytes.as_slice(),
            )
        }
    }
}

fn verified_clipboard_sequence(expected: &ClipboardSnapshot) -> Option<u64> {
    retry_with_delay(CLIPBOARD_READ_ATTEMPTS, CLIPBOARD_READ_RETRY_DELAY, || {
        let before = clipboard_sequence();
        let content_matches = clipboard_matches_snapshot(expected)?;
        let after = clipboard_sequence();
        stable_verified_clipboard_sequence(before, content_matches, after)
    })
}

fn verified_format_package_sequence(expected: &clipboard_formats::FormatPackage) -> Option<u64> {
    retry_with_delay(CLIPBOARD_READ_ATTEMPTS, CLIPBOARD_READ_RETRY_DELAY, || {
        match clipboard_formats::read_format_package() {
            clipboard_formats::PackageReadOutcome::Captured {
                package: actual,
                sequence,
            }
            | clipboard_formats::PackageReadOutcome::Ignored {
                package: actual,
                sequence,
            } => clipboard_formats::verified_package_sequence(
                sequence,
                expected,
                Some(&actual),
                sequence,
            ),
            _ => None,
        }
    })
}

fn write_and_verify_package(
    internal_writes: &InternalClipboardWrites,
    expected: &clipboard_formats::FormatPackage,
    write: impl FnOnce(&clipboard_formats::FormatPackage) -> Result<Option<u64>, String>,
    verify: impl FnOnce(&clipboard_formats::FormatPackage) -> Option<u64>,
) -> Result<Option<u64>, String> {
    let snapshot = ClipboardSnapshot::Package(expected.clone());
    let signature = internal_writes.begin(&snapshot);
    let written_sequence = match write(expected) {
        Ok(sequence) => sequence,
        Err(error) => {
            internal_writes.cancel(signature);
            return Err(error);
        }
    };
    let sequence = verify(expected).or(written_sequence);
    internal_writes.commit(signature, sequence);
    Ok(sequence)
}

fn start_clipboard_monitor(
    app: AppHandle,
    control: CaptureControl,
    exclusions: CaptureExclusions,
    health: CaptureHealth,
    internal_writes: InternalClipboardWrites,
    metrics: AcceptanceMetricsState,
) {
    thread::spawn(move || {
        let mut clipboard = match retry_with_delay(
            CLIPBOARD_INITIALIZATION_ATTEMPTS,
            CLIPBOARD_INITIALIZATION_RETRY_DELAY,
            || match Clipboard::new() {
                Ok(clipboard) => Some(clipboard),
                Err(error) => {
                    log::warn!("系统剪贴板初始化失败，将有限重试: {error}");
                    None
                }
            },
        ) {
            Some(clipboard) => clipboard,
            None => {
                health.finish(false);
                let _ = app.emit(CAPTURE_AVAILABILITY_EVENT, health.snapshot());
                log::error!("多次尝试后仍无法初始化系统剪贴板监听");
                return;
            }
        };
        health.finish(true);
        let _ = app.emit(CAPTURE_AVAILABILITY_EVENT, health.snapshot());
        let mut last_sequence = None;
        let mut exhausted_sequence = None;
        let mut exhausted_retry_at = None;
        let mut last_signature = None;

        loop {
            let sequence = clipboard_sequence();
            if sequence.is_some() && exhausted_sequence.is_some() && sequence != exhausted_sequence
            {
                let _ = metrics
                    .record_capture_terminal(metrics::CaptureTerminalOutcome::RetryExhausted);
                exhausted_sequence = None;
                exhausted_retry_at = None;
            }
            let sequence_is_committed = sequence.is_some() && sequence == last_sequence;
            let sequence_retry_pending = exhausted_clipboard_retry_pending(
                sequence,
                exhausted_sequence,
                exhausted_retry_at,
                Instant::now(),
            );
            if sequence_is_committed || sequence_retry_pending {
                thread::sleep(Duration::from_millis(220));
                continue;
            }

            exhausted_sequence = None;
            exhausted_retry_at = None;
            let outcome = retry_clipboard_snapshot_read(
                CLIPBOARD_READ_ATTEMPTS,
                CLIPBOARD_READ_RETRY_DELAY,
                || read_clipboard_snapshot(&mut clipboard),
            );
            if let Some(candidate) = monitor_omission_candidate(&outcome) {
                log::debug!(
                    "剪贴板变更仅包含无法捕获的格式: sequence={:?}, omitted={:?}",
                    candidate.sequence,
                    candidate.package.omitted_formats
                );
            }
            last_sequence = committed_clipboard_sequence(last_sequence, &outcome);

            match outcome {
                ClipboardReadOutcome::Captured {
                    snapshot,
                    sequence: stable_sequence,
                } => {
                    let signature = snapshot_signature(&snapshot);
                    let internal_write = internal_writes.consume(stable_sequence, signature);
                    if internal_write {
                        let outcome = captured_snapshot_terminal_outcome(
                            true, true, false, false, true, None,
                        );
                        let _ = metrics.record_capture_terminal(outcome);
                        last_signature = Some(signature);
                        thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    let should_capture =
                        should_capture_snapshot(stable_sequence, last_signature, signature);
                    if !should_capture {
                        let outcome = captured_snapshot_terminal_outcome(
                            false, false, false, false, true, None,
                        );
                        let _ = metrics.record_capture_terminal(outcome);
                    } else {
                        let mut capture_enabled = false;
                        let mut event_delivered = false;
                        let paused = control.0.load(Ordering::Relaxed);
                        if paused {
                            let outcome = captured_snapshot_terminal_outcome(
                                false, true, true, false, true, None,
                            );
                            let _ = metrics.record_capture_terminal(outcome);
                        } else {
                            let source_app = choose_clipboard_source(
                                clipboard_owner_source_app(),
                                foreground_source_app(),
                            );
                            let is_excluded = source_app
                                .as_ref()
                                .is_some_and(|source| exclusions.contains(&source.name));
                            if is_excluded {
                                let outcome = captured_snapshot_terminal_outcome(
                                    false, true, false, true, true, None,
                                );
                                let _ = metrics.record_capture_terminal(outcome);
                            } else {
                                capture_enabled = true;
                                if let Some(payload) = snapshot_payload(snapshot, source_app) {
                                    match app.emit(CLIPBOARD_EVENT, payload) {
                                        Ok(()) => event_delivered = true,
                                        Err(error) => {
                                            log::warn!("无法发送剪贴板捕获事件: {error}")
                                        }
                                    }
                                    let outcome = captured_snapshot_terminal_outcome(
                                        false,
                                        true,
                                        false,
                                        false,
                                        true,
                                        Some(event_delivered),
                                    );
                                    let _ = metrics.record_capture_terminal(outcome);
                                } else {
                                    let outcome = captured_snapshot_terminal_outcome(
                                        false, true, false, false, false, None,
                                    );
                                    let _ = metrics.record_capture_terminal(outcome);
                                }
                            }
                        }
                        last_signature = committed_capture_signature(
                            last_signature,
                            signature,
                            capture_enabled,
                            event_delivered,
                        );
                    }
                }
                ClipboardReadOutcome::Ignored { .. } => {
                    let _ = metrics
                        .record_capture_terminal(metrics::CaptureTerminalOutcome::Unsupported);
                }
                ClipboardReadOutcome::Exhausted => {
                    exhausted_sequence = exhausted_clipboard_sequence(sequence);
                    exhausted_retry_at = exhausted_sequence
                        .map(|_| Instant::now() + CLIPBOARD_EXHAUSTED_RETRY_DELAY);
                    log::warn!("系统剪贴板持续被占用，将在短暂退避后重试当前变更");
                }
            }

            thread::sleep(Duration::from_millis(if cfg!(target_os = "windows") {
                220
            } else {
                600
            }));
        }
    });
}

#[tauri::command]
fn set_capture_paused(
    paused: bool,
    app: AppHandle,
    control: State<'_, CaptureControl>,
    menu_item: State<'_, CaptureMenuItem>,
) {
    control.0.store(paused, Ordering::Relaxed);
    menu_item.update(paused);
    let _ = app.emit(CAPTURE_STATE_EVENT, CaptureStatePayload { paused });
}

#[tauri::command]
fn get_capture_availability(health: State<'_, CaptureHealth>) -> CaptureAvailabilityPayload {
    health.snapshot()
}

#[tauri::command]
fn set_capture_exclusions(apps: Vec<String>, exclusions: State<'_, CaptureExclusions>) {
    exclusions.replace(apps);
}

#[tauri::command]
fn set_elevated_paste_enabled(enabled: bool, state: State<'_, ElevatedPasteEnabled>) {
    state.0.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn set_global_shortcut(
    shortcut: String,
    app: AppHandle,
    current: State<'_, CurrentGlobalShortcut>,
) -> Result<(), String> {
    parse_configured_shortcut(&shortcut)?;
    let previous = current.get();
    let manager = app.global_shortcut();

    let plan = shortcut_update_plan(
        &previous,
        &shortcut,
        manager.is_registered(previous.as_str()),
    );
    if plan == ShortcutUpdatePlan::AlreadyRegistered {
        return Ok(());
    }

    let mut next_registered = false;
    for step in shortcut_update_steps(plan) {
        match step {
            ShortcutUpdateStep::RegisterNext => {
                // Windows 允许不同组合同时注册：先保住旧快捷键，再切换到新快捷键。
                manager
                    .register(shortcut.as_str())
                    .map_err(|error| error.to_string())?;
                next_registered = true;
            }
            ShortcutUpdateStep::UnregisterPrevious => {
                if let Err(error) = manager.unregister(previous.as_str()) {
                    if next_registered {
                        let _ = manager.unregister(shortcut.as_str());
                    }
                    return Err(error.to_string());
                }
            }
            ShortcutUpdateStep::CommitNext => current.replace(shortcut.clone()),
        }
    }
    Ok(())
}

#[tauri::command]
fn get_launch_at_startup(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_launch_at_startup(enabled: bool, app: AppHandle) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_screen_capture_protection(enabled: bool, app: AppHandle) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_owned())?;
    let window_handle = window.hwnd().map_err(|error| error.to_string())?;
    let affinity = if enabled {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    unsafe { SetWindowDisplayAffinity(window_handle, affinity) }.map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_screen_capture_protection(_enabled: bool, _app: AppHandle) -> Result<(), String> {
    Ok(())
}

fn present_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_owned())?;
    if window.is_minimized().map_err(|error| error.to_string())? {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn present_onboarding_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_owned())?;
    if let Err(error) = window.center() {
        log::warn!("首次引导窗口居中失败，将继续显示当前窗口: {error}");
    }
    present_main_window(app)
}

fn current_quick_panel_session_id(app: &AppHandle) -> u64 {
    app.try_state::<CurrentQuickPanelSession>()
        .map(|session| session.current())
        .unwrap_or_default()
}

fn clear_paste_target_and_notify(app: &AppHandle, target: &PasteTarget) {
    target.clear();
    let session_id = current_quick_panel_session_id(app);
    let _ = app.emit(PASTE_TARGET_EVENT, cleared_paste_target_payload(session_id));
}

fn activate_quick_panel_from_foreground(app: &AppHandle, sample_started_at: Option<Instant>) {
    if app
        .try_state::<OnboardingWindowActive>()
        .is_some_and(|active| active.get())
    {
        if let Err(error) = present_onboarding_window(app) {
            log::warn!("无法重新显示首次引导: {error}");
        }
        return;
    }

    let (visible, minimized) = app
        .get_webview_window("main")
        .map(|window| {
            (
                window.is_visible().unwrap_or(false),
                // 状态未知时按“可能已最小化”处理，避免误把窗口隐藏。
                window.is_minimized().unwrap_or(true),
            )
        })
        .unwrap_or((false, false));
    let mode = app.state::<CurrentWindowMode>().get();
    let paste_target = app.state::<PasteTarget>();
    if should_toggle_quick_panel_on_hotkey(mode, visible, minimized) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        clear_paste_target_and_notify(app, &paste_target);
        return;
    }

    let snapshot = capture_foreground_paste_target(app);
    let target_identity = snapshot.as_ref().map(|snapshot| snapshot.identity.clone());
    let (source_app, elevated) = match snapshot {
        Some(snapshot) => {
            paste_target.remember_with_pid_and_focus(
                snapshot.identity.window_handle,
                snapshot.identity.process_id,
                snapshot.identity.focus_window_handle,
            );
            (snapshot.source_app, snapshot.elevated)
        }
        None => {
            paste_target.clear();
            (None, false)
        }
    };
    show_quick_panel(
        app,
        target_identity,
        source_app,
        elevated,
        sample_started_at,
    );
}

fn show_main_window(app: &AppHandle) {
    if let Some(target) = app.try_state::<PasteTarget>() {
        clear_paste_target_and_notify(app, &target);
    }
    show_quick_panel(app, None, None, false, None);
}

fn show_quick_panel(
    app: &AppHandle,
    target_identity: Option<PasteTargetIdentity>,
    source_app: Option<SourceAppIdentity>,
    elevated: bool,
    sample_started_at: Option<Instant>,
) {
    // 鼠标坐标也在抢焦点前快照；跨进程 caret 读取失败时不会产生二次跳动。
    let pointer = app
        .cursor_position()
        .ok()
        .map(|cursor| ScreenPoint::new(cursor.x.round() as i32, cursor.y.round() as i32));
    let caret = target_identity.as_ref().and_then(|identity| {
        text_caret_rect_for_window(identity.window_handle, identity.process_id)
    });
    let monitor_hint = caret.and_then(|_| {
        target_identity
            .as_ref()
            .and_then(|identity| window_center_point(identity.window_handle))
    });
    let anchor = choose_popup_anchor(caret, pointer);
    if let Err(error) = set_window_mode_internal(app, WindowMode::Quick, anchor, monitor_hint) {
        log::warn!("无法定位快捷面板: {error}");
        return;
    }
    let session_id = app
        .try_state::<CurrentQuickPanelSession>()
        .map(|session| session.begin())
        .unwrap_or_default();
    if let Some(started_at) = sample_started_at {
        if let Some(metrics) = app.try_state::<AcceptanceMetricsState>() {
            let _ = metrics.start_quick_panel_session(session_id, started_at);
        }
    }
    let (source_app, source_app_icon) = paste_target_presentation(source_app);
    let _ = app.emit(
        PASTE_TARGET_EVENT,
        PasteTargetPayload {
            session_id,
            source_app: source_app.clone(),
            source_app_icon: source_app_icon.clone(),
            elevated,
        },
    );
    let _ = app.emit(
        QUICK_PANEL_INVOKED_EVENT,
        QuickPanelInvocationPayload {
            session_id,
            source_app,
            source_app_icon,
            elevated,
        },
    );
    if let Err(error) = present_main_window(app) {
        log::warn!("无法显示快捷面板: {error}");
    }
}

pub(crate) fn request_app_quit(app: &AppHandle) {
    let requested = app.state::<QuitRequested>();
    let request_id = next_quit_request_id();
    if !mark_quit_requested(&requested.0, request_id) {
        return;
    }
    let _ = app.emit(QUIT_REQUESTED_EVENT, serde_json::json!({}));
    let fallback_app = app.clone();
    let fallback_requested = requested.0.clone();
    thread::spawn(move || {
        thread::sleep(QUIT_FALLBACK_TIMEOUT);
        if take_pending_quit(&fallback_requested, request_id) {
            flush_acceptance_metrics(&fallback_app);
            fallback_app.exit(0);
        }
    });
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    flush_acceptance_metrics(&app);
    app.exit(0);
}

fn flush_acceptance_metrics(app: &AppHandle) {
    if app
        .try_state::<AcceptanceMetricsState>()
        .is_some_and(|metrics| !metrics.flush_now())
    {
        log::warn!("退出前无法刷新验收指标");
    }
}

#[tauri::command]
fn cancel_app_quit(requested: State<'_, QuitRequested>) {
    cancel_quit_request(&requested.0);
}

#[tauri::command]
fn write_clipboard_text(
    text: String,
    internal_writes: State<'_, InternalClipboardWrites>,
) -> Result<(), String> {
    let expected = ClipboardSnapshot::Text(text.clone());
    let signature = internal_writes.begin(&expected);
    if let Err(error) = write_text_to_clipboard(text) {
        internal_writes.cancel(signature);
        return Err(error);
    }
    internal_writes.commit(signature, verified_clipboard_sequence(&expected));
    Ok(())
}

fn write_text_to_clipboard(text: String) -> Result<(), String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_clipboard_image(
    data_url: String,
    internal_writes: State<'_, InternalClipboardWrites>,
) -> Result<(), String> {
    let image = decode_clipboard_image(&data_url)?;
    let expected = ClipboardSnapshot::Image {
        width: image.width,
        height: image.height,
        bytes: image.bytes.to_vec(),
        omitted_formats: Vec::new(),
    };
    let signature = internal_writes.begin(&expected);
    if let Err(error) = write_image_data_to_clipboard(image) {
        internal_writes.cancel(signature);
        return Err(error);
    }
    internal_writes.commit(signature, verified_clipboard_sequence(&expected));
    Ok(())
}

fn decode_clipboard_image(data_url: &str) -> Result<ImageData<'static>, String> {
    const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";
    let encoded = if data_url.starts_with("data:") {
        data_url
            .strip_prefix(PNG_DATA_URL_PREFIX)
            .ok_or_else(|| "剪贴板图片必须是 PNG data URL".to_owned())?
    } else {
        data_url
    };
    let max_encoded = clipboard_formats::MAX_CLIPBOARD_IMAGE_SOURCE_BYTES
        .div_ceil(3)
        .saturating_mul(4);
    if encoded.is_empty() || encoded.len() > max_encoded {
        return Err("剪贴板 PNG 超过 64 MiB 限制".to_owned());
    }
    let png = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    if png.is_empty() || png.len() > clipboard_formats::MAX_CLIPBOARD_IMAGE_SOURCE_BYTES {
        return Err("剪贴板 PNG 超过 64 MiB 限制".to_owned());
    }
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(clipboard_formats::MAX_CLIPBOARD_IMAGE_DIMENSION as u32);
    limits.max_image_height = Some(clipboard_formats::MAX_CLIPBOARD_IMAGE_DIMENSION as u32);
    limits.max_alloc = Some(clipboard_formats::MAX_CLIPBOARD_IMAGE_SOURCE_BYTES as u64);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "剪贴板 PNG 无效或超过安全尺寸".to_owned())?
        .to_rgba8();
    let (width, height) = image.dimensions();
    if !clipboard_formats::clipboard_rgba_layout_is_safe(
        width as usize,
        height as usize,
        image.as_raw().len(),
    ) {
        return Err("剪贴板图片解码后超过 64 MiB、40 MP 或 8192 像素边界".to_owned());
    }
    Ok(ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(image.into_raw()),
    })
}

fn write_image_data_to_clipboard(image: ImageData<'static>) -> Result<(), String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_image(image))
        .map_err(|error| error.to_string())
}

const HISTORY_RUNTIME_UNAVAILABLE: &str = "历史运行时暂时不可用";
const HISTORY_RUNTIME_WORKER_FAILED: &str = "历史后台操作异常结束";

#[derive(Clone)]
struct HistoryDataDirectory(PathBuf);

#[derive(Clone)]
struct HistoryRuntimeState {
    runtime: Arc<Mutex<history::HistoryRuntime>>,
    maintenance_started: Arc<AtomicBool>,
}

impl HistoryRuntimeState {
    fn new(runtime: history::HistoryRuntime) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(runtime)),
            maintenance_started: Arc::new(AtomicBool::new(false)),
        }
    }

    fn try_start_maintenance_with<F>(&self, start: F) -> Result<bool, String>
    where
        F: FnOnce(Weak<Mutex<history::HistoryRuntime>>) -> Result<(), String>,
    {
        if self
            .maintenance_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(false);
        }
        if let Err(error) = start(Arc::downgrade(&self.runtime)) {
            self.maintenance_started.store(false, Ordering::Release);
            return Err(error);
        }
        Ok(true)
    }

    #[cfg(test)]
    fn shares_runtime_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.runtime, &other.runtime)
    }
}

fn resolve_history_data_directory(
    acceptance_profile: Option<&Path>,
    executable_path: &Path,
) -> Result<PathBuf, String> {
    if let Some(profile) = acceptance_profile {
        return Ok(profile.to_path_buf());
    }
    let executable_directory = executable_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "无法确定程序所在目录".to_owned())?;
    Ok(executable_directory.join("data"))
}

fn initialize_history_runtime(data_directory: PathBuf) -> Result<HistoryRuntimeState, String> {
    fs::create_dir_all(&data_directory)
        .map_err(|_| "无法在程序目录创建数据文件夹，请确认 QuickPaste 所在目录可写".to_owned())?;
    history::HistoryRuntime::open(data_directory).map(HistoryRuntimeState::new)
}

fn initialize_history_runtime_off_ui_thread(
    data_directory: PathBuf,
) -> Result<HistoryRuntimeState, String> {
    thread::Builder::new()
        .name("quickpaste-history-init".to_owned())
        .spawn(move || initialize_history_runtime(data_directory))
        .map_err(|_| "无法启动历史初始化线程".to_owned())?
        .join()
        .map_err(|_| "历史初始化线程异常结束".to_owned())?
}

fn execute_history_operation<T, F>(state: HistoryRuntimeState, operation: F) -> Result<T, String>
where
    F: FnOnce(&mut history::HistoryRuntime) -> Result<T, String>,
{
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| HISTORY_RUNTIME_UNAVAILABLE.to_owned())?;
    operation(&mut runtime)
}

async fn run_history_operation<T, F>(state: HistoryRuntimeState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut history::HistoryRuntime) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || execute_history_operation(state, operation))
        .await
        .map_err(|_| HISTORY_RUNTIME_WORKER_FAILED.to_owned())?
}

fn history_maintenance_loop(runtime: Weak<Mutex<history::HistoryRuntime>>) {
    loop {
        thread::sleep(history::HISTORY_MAINTENANCE_INTERVAL);
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        let Ok(mut runtime) = runtime.lock() else {
            log::warn!("历史维护因运行时不可用而停止");
            return;
        };
        if runtime.purge_expired().is_err() {
            log::warn!("历史恢复暂存清理将在下一维护周期重试");
        }
    }
}

fn start_history_maintenance(state: &HistoryRuntimeState) -> Result<(), String> {
    state
        .try_start_maintenance_with(|runtime| {
            thread::Builder::new()
                .name("quickpaste-history-maintenance".to_owned())
                .spawn(move || history_maintenance_loop(runtime))
                .map(|_| ())
                .map_err(|_| "无法启动历史维护线程".to_owned())
        })
        .map(|_| ())
}

#[tauri::command]
async fn load_clipboard_history(
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<Vec<history::HistoryItem>, String> {
    run_history_operation(history_state.inner().clone(), |runtime| {
        runtime.with_connection(|connection| history::load_history(connection))
    })
    .await
}

#[tauri::command]
async fn apply_history_mutation(
    upserts: Vec<history::HistoryItem>,
    delete_ids: Vec<String>,
    policy: history::CapacityPolicy,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::HistoryMutationResult, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| {
            history::apply_history_mutation(
                connection,
                history::HistoryMutation {
                    upserts,
                    delete_ids,
                    policy,
                },
            )
        })
    })
    .await
}

#[tauri::command]
async fn query_clipboard_history(
    query: history::HistoryQuery,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::HistoryPage, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| history::query_history(connection, query))
    })
    .await
}

#[tauri::command]
async fn list_pending_ocr_images(
    query: history::PendingOcrQuery,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::PendingOcrPage, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| history::list_pending_ocr_images(connection, query))
    })
    .await
}

#[tauri::command]
async fn get_clip_payload(
    id: String,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<Option<history::HistoryItem>, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| history::get_clip_payload(connection, &id))
    })
    .await
}

#[tauri::command]
async fn get_clip_thumbnail(
    id: String,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<Option<String>, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| history::get_clip_thumbnail(connection, &id))
    })
    .await
}

#[tauri::command]
async fn detect_clip_qr(
    id: String,
    history_state: State<'_, HistoryRuntimeState>,
    qr_state: State<'_, QrRuntimeState>,
) -> Result<Vec<String>, String> {
    let _permit = qr_state.try_reserve()?;
    let png = run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime
            .with_connection(|connection| history::load_stored_image_for_analysis(connection, &id))
    })
    .await?
    .ok_or_else(|| "二维码图片不存在".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || qr::decode_qr_png(&png))
        .await
        .map_err(|_| "二维码识别后台任务异常结束".to_owned())?
        .map_err(|failure| match failure {
            qr::QrFailure::Oversized => "二维码图片超过本地识别限制".to_owned(),
            qr::QrFailure::Decode => "二维码图片无法解码".to_owned(),
        })
}

#[tauri::command]
async fn get_storage_stats(
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::StorageStats, String> {
    run_history_operation(history_state.inner().clone(), |runtime| {
        runtime.with_connection(|connection| history::get_storage_stats(connection))
    })
    .await
}

#[tauri::command]
async fn open_history_data_directory(
    directory: State<'_, HistoryDataDirectory>,
) -> Result<bool, String> {
    let path = directory.0.to_string_lossy().into_owned();
    system_actions::open_file_path(path).await
}

#[tauri::command]
async fn compact_history_database(
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::StorageStats, String> {
    run_history_operation(history_state.inner().clone(), |runtime| {
        runtime.with_connection(|connection| history::compact_history_database(connection))
    })
    .await
}

#[tauri::command]
async fn create_history_backup(
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::BackupResult, String> {
    run_history_operation(history_state.inner().clone(), |runtime| {
        runtime.with_connection(|_| Ok(()))?;
        let Some(destination) = system_actions::choose_history_backup_destination()? else {
            return Ok(history::BackupResult::Cancelled {});
        };
        runtime.create_backup_at(&destination)
    })
    .await
}

#[tauri::command]
async fn prepare_history_restore(
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::PreparedRestoreResult, String> {
    run_history_operation(history_state.inner().clone(), |runtime| {
        runtime.with_connection(|_| Ok(()))?;
        let Some(source) = system_actions::choose_history_restore_source()? else {
            return Ok(history::PreparedRestoreResult::Cancelled {});
        };
        runtime.prepare_restore_source(&source)
    })
    .await
}

#[tauri::command]
async fn commit_history_restore(
    token: String,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::RestoreResult, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.commit_restore_token(&token)
    })
    .await
}

#[tauri::command]
async fn discard_history_restore(
    token: String,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::DiscardRestoreResult, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.discard_restore(&token)
    })
    .await
}

#[tauri::command]
async fn get_history_health(
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::HistoryHealth, String> {
    run_history_operation(
        history_state.inner().clone(),
        |runtime| Ok(runtime.health()),
    )
    .await
}

#[tauri::command]
async fn list_history_collections(
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<Vec<history::Collection>, String> {
    run_history_operation(history_state.inner().clone(), |runtime| {
        runtime.with_connection(|connection| history::list_history_collections(connection))
    })
    .await
}

#[tauri::command]
async fn create_history_collection(
    name: String,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::Collection, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| history::create_history_collection(connection, &name))
    })
    .await
}

#[tauri::command]
async fn rename_history_collection(
    id: String,
    name: String,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::Collection, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| {
            history::rename_history_collection(connection, &id, &name)
        })
    })
    .await
}

#[tauri::command]
async fn delete_history_collection(
    id: String,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::CollectionDeleteResult, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| history::delete_history_collection(connection, &id))
    })
    .await
}

#[tauri::command]
async fn save_history_snippet(
    draft: history::SnippetDraft,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::HistoryItem, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime.with_connection(|connection| history::save_history_snippet(connection, draft))
    })
    .await
}

#[tauri::command]
async fn apply_history_batch(
    target: history::BatchTarget,
    action: history::BatchAction,
    history_state: State<'_, HistoryRuntimeState>,
) -> Result<history::BatchResult, String> {
    run_history_operation(history_state.inner().clone(), move |runtime| {
        runtime
            .with_connection(|connection| history::apply_history_batch(connection, target, action))
    })
    .await
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum OcrErrorReason {
    Busy,
    Database,
    QueueFull,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum OcrCommandResult {
    Applied {
        ocr_status: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        ocr_text: Option<String>,
    },
    Stale {},
    Error {
        reason: OcrErrorReason,
    },
}

fn history_ocr_error(error: &str) -> OcrCommandResult {
    let lower = error.to_ascii_lowercase();
    let reason = if lower.contains("busy")
        || lower.contains("locked")
        || error == HISTORY_RUNTIME_UNAVAILABLE
    {
        OcrErrorReason::Busy
    } else {
        OcrErrorReason::Database
    };
    OcrCommandResult::Error { reason }
}

fn terminal_ocr_patch(
    outcome: Result<ocr::OcrOutcome, ocr::OcrFailure>,
) -> (&'static str, Option<String>) {
    match outcome {
        Ok(ocr::OcrOutcome::Completed(text)) => ("completed", Some(text)),
        Ok(ocr::OcrOutcome::Unavailable) => ("unavailable", None),
        Ok(ocr::OcrOutcome::Oversized) | Err(ocr::OcrFailure::Oversized) => ("oversized", None),
        Err(ocr::OcrFailure::Decode | ocr::OcrFailure::Winrt) => ("failed", None),
    }
}

async fn apply_native_ocr_patch(
    history_state: HistoryRuntimeState,
    ocr_runtime: ocr::OcrRuntime,
    expected_generation: u64,
    id: String,
    image_hash: String,
    status: &'static str,
    text: Option<String>,
) -> OcrCommandResult {
    let patch_text = text.clone();
    match run_history_operation(history_state, move |runtime| {
        runtime.with_connection(|connection| {
            ocr_runtime
                .commit_if_current(expected_generation, || {
                    history::apply_ocr_patch(
                        connection,
                        &id,
                        &image_hash,
                        status,
                        patch_text.as_deref(),
                    )
                })
                .unwrap_or(Ok(false))
        })
    })
    .await
    {
        Ok(true) => OcrCommandResult::Applied {
            ocr_status: status,
            ocr_text: text,
        },
        Ok(false) => OcrCommandResult::Stale {},
        Err(error) => history_ocr_error(&error),
    }
}

async fn recognize_clip_image_inner(
    id: String,
    image_hash: String,
    history_state: State<'_, HistoryRuntimeState>,
    ocr_state: State<'_, ocr::OcrRuntime>,
) -> OcrCommandResult {
    // Reserve before entering the blocking history lane or loading the PNG BLOB.
    // The RAII permit remains held through the final conditional database patch.
    let command_permit = match ocr_state.try_reserve() {
        Ok(permit) => permit,
        Err(ocr::OcrSubmitError::Disabled) => return OcrCommandResult::Stale {},
        Err(ocr::OcrSubmitError::QueueFull) => {
            return OcrCommandResult::Error {
                reason: OcrErrorReason::QueueFull,
            }
        }
    };
    let command_generation = command_permit.generation();
    let stored = match run_history_operation(history_state.inner().clone(), {
        let id = id.clone();
        let image_hash = image_hash.clone();
        move |runtime| {
            runtime.with_connection(|connection| {
                history::load_stored_ocr_image(connection, &id, &image_hash)
            })
        }
    })
    .await
    {
        Ok(stored) => stored,
        Err(error) => return history_ocr_error(&error),
    };

    let png = match stored {
        history::StoredOcrImage::Ready(png) => png,
        history::StoredOcrImage::Stale => return OcrCommandResult::Stale {},
        history::StoredOcrImage::Decode => {
            return apply_native_ocr_patch(
                history_state.inner().clone(),
                ocr_state.inner().clone(),
                command_generation,
                id,
                image_hash,
                "failed",
                None,
            )
            .await;
        }
        history::StoredOcrImage::Oversized => {
            if ocr_state.enabled_generation() != Some(command_generation) {
                return OcrCommandResult::Stale {};
            }
            return apply_native_ocr_patch(
                history_state.inner().clone(),
                ocr_state.inner().clone(),
                command_generation,
                id,
                image_hash,
                "oversized",
                None,
            )
            .await;
        }
    };

    let ticket = match ocr_state.submit_reserved(command_permit, png) {
        Ok(ticket) => ticket,
        Err(ocr::OcrSubmitError::Disabled) => return OcrCommandResult::Stale {},
        Err(ocr::OcrSubmitError::QueueFull) => {
            return OcrCommandResult::Error {
                reason: OcrErrorReason::QueueFull,
            }
        }
    };
    let (received, _command_permit) =
        match tauri::async_runtime::spawn_blocking(move || ticket.wait()).await {
            Ok(received) => received,
            Err(_) => {
                return OcrCommandResult::Error {
                    reason: OcrErrorReason::Unknown,
                }
            }
        };
    let outcome = match received {
        Ok(outcome) => outcome,
        Err(ocr::OcrReceiveError::Disabled) => return OcrCommandResult::Stale {},
        Err(ocr::OcrReceiveError::Disconnected) => {
            return OcrCommandResult::Error {
                reason: OcrErrorReason::Unknown,
            }
        }
    };
    if ocr_state.enabled_generation() != Some(command_generation) {
        return OcrCommandResult::Stale {};
    }
    let (status, text) = terminal_ocr_patch(outcome);
    apply_native_ocr_patch(
        history_state.inner().clone(),
        ocr_state.inner().clone(),
        command_generation,
        id,
        image_hash,
        status,
        text,
    )
    .await
}

async fn mark_clip_ocr_failed_inner(
    id: String,
    image_hash: String,
    history_state: State<'_, HistoryRuntimeState>,
    ocr_state: State<'_, ocr::OcrRuntime>,
) -> OcrCommandResult {
    let command_permit = match ocr_state.try_reserve() {
        Ok(permit) => permit,
        Err(ocr::OcrSubmitError::Disabled) => return OcrCommandResult::Stale {},
        Err(ocr::OcrSubmitError::QueueFull) => {
            return OcrCommandResult::Error {
                reason: OcrErrorReason::QueueFull,
            }
        }
    };
    let command_generation = command_permit.generation();
    apply_native_ocr_patch(
        history_state.inner().clone(),
        ocr_state.inner().clone(),
        command_generation,
        id,
        image_hash,
        "failed",
        None,
    )
    .await
}

#[tauri::command]
async fn recognize_clip_image(
    id: String,
    image_hash: String,
    history_state: State<'_, HistoryRuntimeState>,
    ocr_state: State<'_, ocr::OcrRuntime>,
) -> Result<OcrCommandResult, String> {
    Ok(recognize_clip_image_inner(id, image_hash, history_state, ocr_state).await)
}

#[tauri::command]
async fn mark_clip_ocr_failed(
    id: String,
    image_hash: String,
    history_state: State<'_, HistoryRuntimeState>,
    ocr_state: State<'_, ocr::OcrRuntime>,
) -> Result<OcrCommandResult, String> {
    Ok(mark_clip_ocr_failed_inner(id, image_hash, history_state, ocr_state).await)
}

#[tauri::command]
fn set_clipboard_ocr_enabled(enabled: bool, ocr_state: State<'_, ocr::OcrRuntime>) -> bool {
    ocr_state.set_enabled(enabled);
    enabled
}

#[tauri::command]
fn invalidate_clipboard_ocr(ocr_state: State<'_, ocr::OcrRuntime>) -> bool {
    ocr_state.invalidate()
}

fn unverified_clipboard_copy_result(sequence: Option<u64>) -> Option<PasteResult> {
    sequence.is_none().then_some(PasteResult {
        copied: true,
        pasted: false,
        requires_elevation: false,
    })
}

fn paste_to_remembered_target(
    app: &AppHandle,
    paste_target: &PasteTarget,
    elevated_paste_enabled: bool,
    quick_panel_pinned: bool,
    clipboard_sequence: Option<u64>,
) -> PasteAttempt {
    if let Some(result) = unverified_clipboard_copy_result(clipboard_sequence) {
        return PasteAttempt {
            result,
            terminal_outcome: metrics::PasteTerminalOutcome::ClipboardUnverified,
        };
    }
    let Some(identity) = paste_target.identity_for_activation(quick_panel_pinned) else {
        return PasteAttempt {
            result: PasteResult {
                copied: true,
                pasted: false,
                requires_elevation: false,
            },
            terminal_outcome: metrics::PasteTerminalOutcome::TargetMissing,
        };
    };
    if !quick_panel_pinned {
        let _ = app.emit(
            PASTE_TARGET_EVENT,
            cleared_paste_target_payload(current_quick_panel_session_id(app)),
        );
    }
    if !target_identity_is_current(&identity) {
        if paste_target.complete_activation(&identity, quick_panel_pinned, false) {
            let _ = app.emit(
                PASTE_TARGET_EVENT,
                cleared_paste_target_payload(current_quick_panel_session_id(app)),
            );
        }
        return PasteAttempt {
            result: PasteResult {
                copied: true,
                pasted: false,
                requires_elevation: false,
            },
            terminal_outcome: metrics::PasteTerminalOutcome::TargetStale,
        };
    }

    let target_elevated = window_is_elevated(identity.window_handle).unwrap_or(true);
    let current_elevated = current_process_is_elevated().unwrap_or(false);
    let strategy = choose_paste_strategy(current_elevated, target_elevated, elevated_paste_enabled);
    let result = match strategy {
        PasteStrategy::Direct => PasteResult {
            copied: true,
            pasted: clipboard_sequence.is_some_and(|sequence| {
                paste_into_window(app, &identity, quick_panel_pinned, sequence)
            }),
            requires_elevation: false,
        },
        PasteStrategy::CopyOnly => PasteResult {
            copied: true,
            pasted: false,
            requires_elevation: true,
        },
        PasteStrategy::ElevatedHelper => {
            let main_window = app.get_webview_window("main");
            if !quick_panel_pinned {
                if let Some(window) = &main_window {
                    let _ = window.hide();
                }
                thread::sleep(Duration::from_millis(40));
            }
            let pasted = clipboard_sequence
                .is_some_and(|sequence| launch_elevated_paste_helper(&identity, sequence));
            if !pasted && !quick_panel_pinned {
                if let Some(window) = main_window {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            PasteResult {
                copied: true,
                pasted,
                requires_elevation: !pasted,
            }
        }
    };
    if paste_target.complete_activation(&identity, quick_panel_pinned, result.pasted) {
        let _ = app.emit(
            PASTE_TARGET_EVENT,
            cleared_paste_target_payload(current_quick_panel_session_id(app)),
        );
    }
    PasteAttempt {
        terminal_outcome: paste_strategy_terminal_outcome(strategy, result.pasted),
        result,
    }
}

fn paste_command_error(
    metrics: &AcceptanceMetricsState,
    error: String,
) -> Result<PasteResult, String> {
    let _ = metrics.record_paste_terminal(metrics::PasteTerminalOutcome::ClipboardWriteFailed);
    Err(error)
}

fn finish_paste_attempt(
    metrics: &AcceptanceMetricsState,
    attempt: PasteAttempt,
) -> Result<PasteResult, String> {
    let _ = metrics.record_paste_terminal(attempt.terminal_outcome);
    Ok(attempt.result)
}

#[tauri::command]
// Tauri command 保持顶层参数；状态参数由运行时注入，不能打包进前端请求。
#[allow(clippy::too_many_arguments)]
fn paste_clipboard_text(
    text: String,
    app: AppHandle,
    internal_writes: State<'_, InternalClipboardWrites>,
    paste_target: State<'_, PasteTarget>,
    elevated_paste: State<'_, ElevatedPasteEnabled>,
    quick_panel_pinned: State<'_, QuickPanelPinned>,
    current_window_mode: State<'_, CurrentWindowMode>,
    metrics_state: State<'_, AcceptanceMetricsState>,
) -> Result<PasteResult, String> {
    let expected = ClipboardSnapshot::Text(text.clone());
    let signature = internal_writes.begin(&expected);
    if let Err(error) = write_text_to_clipboard(text) {
        internal_writes.cancel(signature);
        return paste_command_error(&metrics_state, error);
    }
    let clipboard_sequence = verified_clipboard_sequence(&expected);
    internal_writes.commit(signature, clipboard_sequence);
    let continuous_paste = current_window_mode.get() == WindowMode::Quick
        && quick_panel_pinned.0.load(Ordering::Relaxed);
    finish_paste_attempt(
        &metrics_state,
        paste_to_remembered_target(
            &app,
            &paste_target,
            elevated_paste.0.load(Ordering::Relaxed),
            continuous_paste,
            clipboard_sequence,
        ),
    )
}

#[tauri::command]
// Tauri command 保持顶层 camelCase 参数；状态参数由运行时注入，不能打包进前端请求。
#[allow(clippy::too_many_arguments)]
fn paste_clipboard_formats(
    plain_text: String,
    html: Option<String>,
    rtf_base64: Option<String>,
    app: AppHandle,
    internal_writes: State<'_, InternalClipboardWrites>,
    paste_target: State<'_, PasteTarget>,
    elevated_paste: State<'_, ElevatedPasteEnabled>,
    quick_panel_pinned: State<'_, QuickPanelPinned>,
    current_window_mode: State<'_, CurrentWindowMode>,
    metrics_state: State<'_, AcceptanceMetricsState>,
) -> Result<PasteResult, String> {
    let expected = match clipboard_formats::prepare_format_package(
        &plain_text,
        html.as_deref(),
        rtf_base64.as_deref(),
    ) {
        Ok(expected) => expected,
        Err(error) => return paste_command_error(&metrics_state, error),
    };
    let clipboard_sequence = match write_and_verify_package(
        internal_writes.inner(),
        &expected,
        clipboard_formats::write_format_package,
        verified_format_package_sequence,
    ) {
        Ok(sequence) => sequence,
        Err(error) => return paste_command_error(&metrics_state, error),
    };
    let continuous_paste = current_window_mode.get() == WindowMode::Quick
        && quick_panel_pinned.0.load(Ordering::Relaxed);
    finish_paste_attempt(
        &metrics_state,
        paste_to_remembered_target(
            &app,
            &paste_target,
            elevated_paste.0.load(Ordering::Relaxed),
            continuous_paste,
            clipboard_sequence,
        ),
    )
}

#[tauri::command]
// Tauri command 保持顶层参数；状态参数由运行时注入，不能打包进前端请求。
#[allow(clippy::too_many_arguments)]
fn paste_clipboard_files(
    paths: Vec<String>,
    app: AppHandle,
    internal_writes: State<'_, InternalClipboardWrites>,
    paste_target: State<'_, PasteTarget>,
    elevated_paste: State<'_, ElevatedPasteEnabled>,
    quick_panel_pinned: State<'_, QuickPanelPinned>,
    current_window_mode: State<'_, CurrentWindowMode>,
    metrics_state: State<'_, AcceptanceMetricsState>,
) -> Result<PasteResult, String> {
    let expected = match clipboard_formats::prepare_file_package(&paths) {
        Ok(expected) => expected,
        Err(error) => return paste_command_error(&metrics_state, error),
    };
    let clipboard_sequence = match write_and_verify_package(
        internal_writes.inner(),
        &expected,
        clipboard_formats::write_format_package,
        verified_format_package_sequence,
    ) {
        Ok(sequence) => sequence,
        Err(error) => return paste_command_error(&metrics_state, error),
    };
    let continuous_paste = current_window_mode.get() == WindowMode::Quick
        && quick_panel_pinned.0.load(Ordering::Relaxed);
    finish_paste_attempt(
        &metrics_state,
        paste_to_remembered_target(
            &app,
            &paste_target,
            elevated_paste.0.load(Ordering::Relaxed),
            continuous_paste,
            clipboard_sequence,
        ),
    )
}

#[tauri::command]
// Tauri command 保持顶层参数；状态参数由运行时注入，不能打包进前端请求。
#[allow(clippy::too_many_arguments)]
fn paste_clipboard_image(
    data_url: String,
    app: AppHandle,
    internal_writes: State<'_, InternalClipboardWrites>,
    paste_target: State<'_, PasteTarget>,
    elevated_paste: State<'_, ElevatedPasteEnabled>,
    quick_panel_pinned: State<'_, QuickPanelPinned>,
    current_window_mode: State<'_, CurrentWindowMode>,
    metrics_state: State<'_, AcceptanceMetricsState>,
) -> Result<PasteResult, String> {
    let image = match decode_clipboard_image(&data_url) {
        Ok(image) => image,
        Err(error) => return paste_command_error(&metrics_state, error),
    };
    let expected = ClipboardSnapshot::Image {
        width: image.width,
        height: image.height,
        bytes: image.bytes.to_vec(),
        omitted_formats: Vec::new(),
    };
    let signature = internal_writes.begin(&expected);
    if let Err(error) = write_image_data_to_clipboard(image) {
        internal_writes.cancel(signature);
        return paste_command_error(&metrics_state, error);
    }
    let clipboard_sequence = verified_clipboard_sequence(&expected);
    internal_writes.commit(signature, clipboard_sequence);
    let continuous_paste = current_window_mode.get() == WindowMode::Quick
        && quick_panel_pinned.0.load(Ordering::Relaxed);
    finish_paste_attempt(
        &metrics_state,
        paste_to_remembered_target(
            &app,
            &paste_target,
            elevated_paste.0.load(Ordering::Relaxed),
            continuous_paste,
            clipboard_sequence,
        ),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(exit_code) = maybe_run_elevated_paste_helper() {
        std::process::exit(exit_code);
    }
    if !main_process_startup_allowed(current_process_is_elevated()) {
        show_elevated_main_process_warning();
        std::process::exit(2);
    }

    let process_arguments = std::env::args_os().collect::<Vec<_>>();
    let start_hidden = process_arguments
        .iter()
        .any(|argument| argument == "--hidden");
    let acceptance_mode = metrics::acceptance_metrics_enabled(&process_arguments);
    let acceptance_profile_override =
        std::env::var_os(metrics::ACCEPTANCE_PROFILE_ENV).map(PathBuf::from);
    let acceptance_profile = match metrics::prepare_acceptance_profile(
        acceptance_mode,
        acceptance_profile_override.as_deref(),
        &std::env::temp_dir(),
        SystemTime::now(),
    ) {
        Ok(profile) => profile,
        Err(_) => {
            eprintln!("验收 profile 校验失败；拒绝启动以保护正常用户数据");
            std::process::exit(2);
        }
    };
    let capture_control = CaptureControl(Arc::new(AtomicBool::new(false)));
    let capture_health = CaptureHealth::default();
    let internal_clipboard_writes = InternalClipboardWrites::default();
    let capture_menu_item = CaptureMenuItem::default();
    let quit_requested = QuitRequested::default();
    let elevated_paste_enabled = ElevatedPasteEnabled(Arc::new(AtomicBool::new(true)));
    let capture_exclusions = CaptureExclusions::default();
    let current_shortcut = CurrentGlobalShortcut::default();
    let current_window_mode = CurrentWindowMode::default();
    let current_quick_panel_session = CurrentQuickPanelSession::default();
    let quick_panel_pinned = QuickPanelPinned::default();
    let onboarding_window_active = OnboardingWindowActive::default();
    let paste_target = PasteTarget::default();
    let open_shortcut = parse_configured_shortcut(DEFAULT_GLOBAL_SHORTCUT)
        .expect("default global shortcut must remain valid");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            activate_quick_panel_from_foreground(app, Some(Instant::now()));
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(capture_control.clone())
        .manage(capture_health.clone())
        .manage(internal_clipboard_writes.clone())
        .manage(capture_menu_item.clone())
        .manage(quit_requested)
        .manage(updater::UpdateRuntime::default())
        .manage(elevated_paste_enabled)
        .manage(capture_exclusions.clone())
        .manage(current_shortcut)
        .manage(current_window_mode)
        .manage(current_quick_panel_session)
        .manage(quick_panel_pinned)
        .manage(QrRuntimeState::default())
        .manage(onboarding_window_active)
        .manage(paste_target)
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        activate_quick_panel_from_foreground(app, Some(Instant::now()));
                    }
                })
                .build(),
        )
        .setup(move |app| {
            if !acceptance_mode {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                        .max_file_size(256_000)
                        .build(),
                )?;
            }
            let executable_path = std::env::current_exe()?;
            let history_data_directory =
                resolve_history_data_directory(acceptance_profile.as_deref(), &executable_path)
                    .map_err(std::io::Error::other)?;
            let metrics_state = if acceptance_mode && acceptance_profile.is_some() {
                AcceptanceMetricsState::enabled(&history_data_directory)
            } else {
                AcceptanceMetricsState::default()
            };
            if !app.manage(HistoryDataDirectory(history_data_directory.clone())) {
                return Err(std::io::Error::other("历史数据目录被重复注册").into());
            }
            if !app.manage(metrics_state.clone()) {
                return Err(std::io::Error::other("验收指标运行时被重复注册").into());
            }
            metrics_state.schedule_flush();
            let history_state = initialize_history_runtime_off_ui_thread(history_data_directory)
                .map_err(std::io::Error::other)?;
            if !app.manage(history_state.clone()) {
                return Err(std::io::Error::other("历史运行时被重复注册").into());
            }
            let ocr_runtime = ocr::OcrRuntime::new()
                .map_err(|_| std::io::Error::other("无法启动本地 OCR 运行时"))?;
            if !app.manage(ocr_runtime) {
                return Err(std::io::Error::other("OCR 运行时被重复注册").into());
            }
            start_history_maintenance(&history_state).map_err(std::io::Error::other)?;
            if let Err(error) = app.global_shortcut().register(open_shortcut) {
                log::warn!("全局快捷键 Ctrl+Shift+V 注册失败: {error}");
            }

            let show_item = MenuItem::with_id(app, "show", "打开闪电剪贴板", true, None::<&str>)?;
            let pause_item =
                MenuItem::with_id(app, "toggle-capture", "暂停记录", true, None::<&str>)?;
            let update_item =
                MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &pause_item, &update_item, &quit_item])?;
            let pause_item_for_menu = pause_item.clone();
            capture_menu_item.replace(pause_item.clone());
            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("闪电剪贴板 QuickPaste")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => activate_quick_panel_from_foreground(app, Some(Instant::now())),
                    "toggle-capture" => {
                        let control = app.state::<CaptureControl>();
                        let paused = !control.0.fetch_xor(true, Ordering::Relaxed);
                        let _ = pause_item_for_menu.set_text(capture_menu_text(paused));
                        let _ = app.emit(CAPTURE_STATE_EVENT, CaptureStatePayload { paused });
                    }
                    "check-update" => {
                        show_main_window(app);
                        let _ = app.emit(UPDATE_CHECK_REQUESTED_EVENT, ());
                    }
                    "quit" => request_app_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        activate_quick_panel_from_foreground(
                            tray.app_handle(),
                            Some(Instant::now()),
                        );
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

            start_clipboard_monitor(
                app.handle().clone(),
                capture_control.clone(),
                capture_exclusions.clone(),
                capture_health.clone(),
                internal_clipboard_writes.clone(),
                metrics_state.clone(),
            );
            if let Err(error) = set_screen_capture_protection(
                initial_screen_capture_protection(),
                app.handle().clone(),
            ) {
                log::warn!("首次显示前无法应用窗口捕获策略: {error}");
            }
            if !start_hidden {
                show_quick_panel(app.handle(), None, None, false, None);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            } else if let WindowEvent::Focused(focused) = event {
                let mode = window.app_handle().state::<CurrentWindowMode>().get();
                let pinned = window
                    .app_handle()
                    .state::<QuickPanelPinned>()
                    .0
                    .load(Ordering::Relaxed);
                let onboarding_active = window.app_handle().state::<OnboardingWindowActive>().get();
                let native_window_foreground = native_window_is_foreground(window);
                if should_auto_hide_quick_panel(
                    mode,
                    *focused,
                    pinned,
                    onboarding_active,
                    native_window_foreground,
                ) {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_capture_paused,
            get_capture_availability,
            set_capture_exclusions,
            set_elevated_paste_enabled,
            set_global_shortcut,
            set_window_mode,
            set_quick_panel_pinned,
            set_onboarding_window_active,
            record_quick_panel_first_frame,
            get_launch_at_startup,
            set_launch_at_startup,
            set_screen_capture_protection,
            write_clipboard_text,
            write_clipboard_image,
            paste_clipboard_text,
            paste_clipboard_formats,
            paste_clipboard_files,
            paste_clipboard_image,
            system_actions::open_external_link,
            system_actions::open_file_path,
            system_actions::reveal_file_path,
            system_actions::save_clipboard_image,
            load_clipboard_history,
            apply_history_mutation,
            query_clipboard_history,
            list_pending_ocr_images,
            get_clip_payload,
            get_clip_thumbnail,
            detect_clip_qr,
            get_storage_stats,
            open_history_data_directory,
            compact_history_database,
            create_history_backup,
            prepare_history_restore,
            commit_history_restore,
            discard_history_restore,
            get_history_health,
            list_history_collections,
            create_history_collection,
            rename_history_collection,
            delete_history_collection,
            save_history_snippet,
            apply_history_batch,
            recognize_clip_image,
            mark_clip_ocr_failed,
            set_clipboard_ocr_enabled,
            invalidate_clipboard_ocr,
            cancel_app_quit,
            exit_app,
            updater::check_for_update,
            updater::download_update,
            updater::install_downloaded_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_data_directory_is_portable_and_keeps_acceptance_profiles_isolated() {
        let executable = Path::new(r"C:\Apps\QuickPaste\QuickPaste.exe");
        assert_eq!(
            resolve_history_data_directory(None, executable).expect("portable data directory"),
            PathBuf::from(r"C:\Apps\QuickPaste\data")
        );

        let acceptance_profile = Path::new(r"C:\Temp\quickpaste-acceptance");
        assert_eq!(
            resolve_history_data_directory(Some(acceptance_profile), executable)
                .expect("isolated acceptance profile"),
            acceptance_profile
        );
    }

    #[test]
    fn portable_history_data_directory_requires_an_executable_parent() {
        assert!(resolve_history_data_directory(None, Path::new("QuickPaste.exe")).is_err());
    }

    fn temporary_history_lane_directory(name: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "quickpaste-lib-history-{name}-{}-{nonce}-{counter}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create isolated history lane directory");
        path
    }

    #[test]
    fn history_runtime_clones_share_one_serial_lane() {
        use std::sync::atomic::AtomicUsize;

        let directory = temporary_history_lane_directory("serial-lane");
        let runtime = history::HistoryRuntime::open(directory.clone()).expect("open history lane");
        let state = HistoryRuntimeState::new(runtime);
        let sibling = state.clone();
        assert!(state.shares_runtime_with(&sibling));

        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for lane in [state.clone(), sibling] {
            let active = active.clone();
            let maximum = maximum.clone();
            workers.push(thread::spawn(move || {
                execute_history_operation(lane, |_| {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(now, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(25));
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .expect("serialized history operation");
            }));
        }
        for worker in workers {
            worker.join().expect("history lane worker");
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);

        drop(state);
        fs::remove_dir_all(directory).expect("remove history lane directory");
    }

    #[test]
    fn history_maintenance_can_only_be_started_once_per_managed_lane() {
        assert_eq!(
            history::HISTORY_MAINTENANCE_INTERVAL,
            Duration::from_secs(30)
        );
        let directory = temporary_history_lane_directory("maintenance-once");
        let runtime = history::HistoryRuntime::open(directory.clone()).expect("open history lane");
        let state = HistoryRuntimeState::new(runtime);
        let starts = Arc::new(AtomicU64::new(0));

        for _ in 0..3 {
            let starts = starts.clone();
            state
                .try_start_maintenance_with(move |_| {
                    starts.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .expect("claim bounded maintenance loop");
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);

        drop(state);
        fs::remove_dir_all(directory).expect("remove history lane directory");
    }

    #[test]
    fn history_worker_join_and_mutex_poison_errors_are_content_free() {
        let directory = temporary_history_lane_directory("worker-errors");
        let runtime = history::HistoryRuntime::open(directory.clone()).expect("open history lane");
        let state = HistoryRuntimeState::new(runtime);

        let worker_error = tauri::async_runtime::block_on(run_history_operation(
            state.clone(),
            |_| -> Result<(), String> { panic!("injected history worker panic") },
        ));
        assert_eq!(worker_error, Err(HISTORY_RUNTIME_WORKER_FAILED.to_owned()));
        assert_eq!(
            execute_history_operation(state.clone(), |_| Ok(())),
            Err(HISTORY_RUNTIME_UNAVAILABLE.to_owned())
        );

        drop(state);
        fs::remove_dir_all(directory).expect("remove history lane directory");
    }

    #[test]
    fn managed_restore_commit_keeps_the_reopened_lane_usable() {
        let root = temporary_history_lane_directory("restore-reopen");
        let live_directory = root.join("live");
        let source_directory = root.join("source");
        fs::create_dir(&live_directory).expect("create live directory");
        fs::create_dir(&source_directory).expect("create source directory");

        let source = history::HistoryRuntime::open(source_directory.clone())
            .expect("open restore source runtime");
        drop(source);
        let mut live =
            history::HistoryRuntime::open(live_directory).expect("open restore live runtime");
        let prepared = live
            .prepare_restore_source(&source_directory.join("history.sqlite3"))
            .expect("prepare managed restore");
        let history::PreparedRestoreResult::Prepared { token, .. } = prepared else {
            panic!("fixture restore must be prepared");
        };
        let state = HistoryRuntimeState::new(live);

        execute_history_operation(state.clone(), move |runtime| {
            runtime.commit_restore_token(&token).map(|_| ())
        })
        .expect("commit through managed runtime route");
        execute_history_operation(state.clone(), |runtime| {
            runtime.with_connection(|connection| history::get_storage_stats(connection))
        })
        .expect("reopened connection remains usable");

        drop(state);
        fs::remove_dir_all(root).expect("remove restore lane directory");
    }

    #[test]
    fn every_history_ipc_is_async_registered_and_routes_through_spawn_blocking() {
        let source = include_str!("lib.rs");
        let command_source = source
            .split_once("const HISTORY_RUNTIME_UNAVAILABLE")
            .expect("history runtime source")
            .1
            .split_once("fn unverified_clipboard_copy_result")
            .expect("history command source")
            .0;
        let handler_source = source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .expect("invoke handler source")
            .1
            .split_once("])\n        .run(")
            .expect("invoke handler end")
            .0;
        let setup_source = source
            .split_once(".setup(move |app| {")
            .expect("setup source")
            .1
            .split_once("        .on_window_event(")
            .expect("setup end")
            .0;
        let commands = [
            "load_clipboard_history",
            "apply_history_mutation",
            "query_clipboard_history",
            "get_clip_payload",
            "get_clip_thumbnail",
            "detect_clip_qr",
            "get_storage_stats",
            "compact_history_database",
            "create_history_backup",
            "prepare_history_restore",
            "commit_history_restore",
            "discard_history_restore",
            "get_history_health",
            "list_history_collections",
            "create_history_collection",
            "rename_history_collection",
            "delete_history_collection",
            "save_history_snippet",
            "apply_history_batch",
        ];
        for command in commands {
            let body = command_source
                .split_once(&format!("async fn {command}("))
                .unwrap_or_else(|| panic!("{command} must remain async"))
                .1
                .split_once("\n}\n")
                .unwrap_or_else(|| panic!("{command} must keep a bounded body"))
                .0;
            assert!(
                body.contains("run_history_operation("),
                "{command} must route through the shared blocking lane"
            );
            assert!(
                handler_source.contains(&format!("            {command},")),
                "{command} must remain registered"
            );
        }
        assert!(command_source.contains("tauri::async_runtime::spawn_blocking"));
        assert!(!command_source.contains("fn open_history_database(app:"));
        assert!(command_source.contains("runtime.commit_restore_token(&token)"));
        assert_eq!(
            setup_source
                .matches("start_history_maintenance(&history_state)")
                .count(),
            1
        );
    }

    #[test]
    fn native_ocr_commands_reserve_capacity_before_history_or_blob_work() {
        let source = include_str!("lib.rs");
        let recognize = source
            .split_once("async fn recognize_clip_image_inner(")
            .expect("recognize command source")
            .1
            .split_once("async fn mark_clip_ocr_failed_inner(")
            .expect("recognize command end")
            .0;
        let reserve = recognize
            .find("ocr_state.try_reserve()")
            .expect("recognize must reserve a bounded command permit");
        let history_lane = recognize
            .find("run_history_operation(")
            .expect("recognize must enter the history lane");
        let blob_load = recognize
            .find("history::load_stored_ocr_image")
            .expect("recognize must load the stored image");
        assert!(reserve < history_lane && reserve < blob_load);
        assert!(recognize.contains("submit_reserved(command_permit, png)"));
        let stored_decode = recognize
            .split_once("history::StoredOcrImage::Decode =>")
            .expect("stored decode branch")
            .1
            .split_once("history::StoredOcrImage::Oversized =>")
            .expect("stored decode branch end")
            .0;
        assert!(stored_decode.contains("apply_native_ocr_patch("));
        assert!(stored_decode.contains("\"failed\""));

        let mark_failed = source
            .split_once("async fn mark_clip_ocr_failed_inner(")
            .expect("failure command source")
            .1
            .split_once("#[tauri::command]\nasync fn recognize_clip_image(")
            .expect("failure command end")
            .0;
        assert!(
            mark_failed
                .find("ocr_state.try_reserve()")
                .expect("failure patch must reserve capacity")
                < mark_failed
                    .find("apply_native_ocr_patch(")
                    .expect("failure patch database call")
        );
    }

    #[test]
    fn snapshot_signatures_are_stable_and_kind_sensitive() {
        let first = ClipboardSnapshot::Text("QuickPaste".into());
        let same = ClipboardSnapshot::Text("QuickPaste".into());
        let different = ClipboardSnapshot::Text("quickpaste".into());

        assert_eq!(snapshot_signature(&first), snapshot_signature(&same));
        assert_ne!(snapshot_signature(&first), snapshot_signature(&different));
    }

    #[test]
    fn rich_and_file_packages_participate_in_snapshot_signatures() {
        let rich = ClipboardSnapshot::Package(clipboard_formats::FormatPackage {
            plain_text: Some("same plain".into()),
            html: Some("<b>same plain</b>".into()),
            ..clipboard_formats::FormatPackage::default()
        });
        let different_html = ClipboardSnapshot::Package(clipboard_formats::FormatPackage {
            plain_text: Some("same plain".into()),
            html: Some("<i>same plain</i>".into()),
            ..clipboard_formats::FormatPackage::default()
        });

        assert_ne!(
            snapshot_signature(&rich),
            snapshot_signature(&different_html)
        );
    }

    #[test]
    fn a_new_windows_sequence_is_not_deduplicated_only_because_content_matches() {
        assert!(should_capture_snapshot(Some(42), Some(7), 7));
        assert!(!should_capture_snapshot(None, Some(7), 7));
        assert!(should_capture_snapshot(None, Some(7), 8));
    }

    #[test]
    fn an_exact_internal_clipboard_write_is_consumed_once() {
        let writes = InternalClipboardWrites::default();
        let snapshot = ClipboardSnapshot::Text("由 QuickPaste 写入".into());
        let signature = writes.begin(&snapshot);
        writes.commit(signature, Some(88));

        assert!(writes.consume(Some(88), signature));
        assert!(!writes.consume(Some(88), signature));
    }

    #[test]
    fn legacy_plain_writes_match_the_windows_plain_format_package_once() {
        let writes = InternalClipboardWrites::default();
        let text = ClipboardSnapshot::Text("由 QuickPaste 写入".into());
        let package = ClipboardSnapshot::Package(clipboard_formats::FormatPackage {
            plain_text: Some("由 QuickPaste 写入".into()),
            ..clipboard_formats::FormatPackage::default()
        });
        let signature = writes.begin(&text);
        writes.commit(signature, Some(89));

        assert_eq!(signature, snapshot_signature(&package));
        assert!(writes.consume(Some(89), snapshot_signature(&package)));
        assert!(!writes.consume(Some(90), snapshot_signature(&package)));
    }

    #[test]
    fn an_internal_format_package_is_consumed_once_then_the_same_external_content_is_visible() {
        let writes = InternalClipboardWrites::default();
        let snapshot = ClipboardSnapshot::Package(clipboard_formats::FormatPackage {
            plain_text: Some("由 QuickPaste 写入".into()),
            html: Some("<b>由 QuickPaste 写入</b>".into()),
            ..clipboard_formats::FormatPackage::default()
        });
        let signature = writes.begin(&snapshot);
        writes.commit(signature, Some(91));

        assert!(writes.consume(Some(91), signature));
        assert!(!writes.consume(Some(92), signature));
    }

    #[test]
    fn package_payloads_keep_rich_formats_and_ordered_file_metadata() {
        let rich = snapshot_payload(
            ClipboardSnapshot::Package(clipboard_formats::FormatPackage {
                plain_text: Some("富文本".into()),
                html: Some("<b>富文本</b>".into()),
                rtf: Some(br"{\rtf1 rich}".to_vec()),
                ..clipboard_formats::FormatPackage::default()
            }),
            None,
        )
        .expect("rich payload");
        assert_eq!(rich.kind, "text");
        assert_eq!(
            rich.formats,
            vec![
                clipboard_formats::ClipboardFormatKind::Text,
                clipboard_formats::ClipboardFormatKind::Html,
                clipboard_formats::ClipboardFormatKind::Rtf,
            ]
        );
        assert_eq!(rich.html.as_deref(), Some("<b>富文本</b>"));
        assert!(rich.rtf_base64.is_some());

        let files = clipboard_formats::prepare_file_package(&[
            "C:\\Fixtures\\first.txt".into(),
            "C:\\Fixtures\\folder".into(),
        ])
        .expect("valid file paths");
        let files =
            snapshot_payload(ClipboardSnapshot::Package(files), None).expect("file payload");
        let json = serde_json::to_value(files).expect("serialize file payload");
        assert_eq!(json["kind"], "file");
        assert_eq!(json["formats"], serde_json::json!(["files"]));
        assert_eq!(json["files"][0]["path"], "C:\\Fixtures\\first.txt");
        assert!(json["files"][0].get("existsAtCapture").is_none());
        assert!(json["files"][0].get("exists").is_some());
    }

    #[test]
    fn package_write_verification_commits_optional_sequence_and_cancels_on_write_failure() {
        let expected = clipboard_formats::prepare_format_package(
            "plain",
            Some("<b>plain</b>"),
            Some("e1xydGYxXGFuc2k="),
        )
        .expect("valid package");
        let writes = InternalClipboardWrites::default();

        let sequence =
            write_and_verify_package(&writes, &expected, |_| Ok(Some(100)), |_| Some(101))
                .expect("write succeeds");
        assert_eq!(sequence, Some(101));
        assert!(writes.consume(
            Some(101),
            snapshot_signature(&ClipboardSnapshot::Package(expected.clone()))
        ));

        let occupied = write_and_verify_package(&writes, &expected, |_| Ok(Some(103)), |_| None)
            .expect("successful write survives temporary reader contention");
        assert_eq!(occupied, Some(103));
        assert!(writes.consume(
            Some(103),
            snapshot_signature(&ClipboardSnapshot::Package(expected.clone()))
        ));

        let failed = write_and_verify_package(
            &writes,
            &expected,
            |_| Err("拒绝写入".into()),
            |_| Some(102),
        );
        assert_eq!(failed, Err("拒绝写入".into()));
        assert!(!writes.consume(
            Some(102),
            snapshot_signature(&ClipboardSnapshot::Package(expected))
        ));
    }

    #[test]
    fn image_payload_is_encoded_as_png_data_url() {
        let payload = snapshot_payload(
            ClipboardSnapshot::Image {
                width: 1,
                height: 1,
                bytes: vec![77, 111, 206, 255],
                omitted_formats: Vec::new(),
            },
            Some(SourceAppIdentity {
                name: "截图工具".into(),
                icon: Some("data:image/png;base64,source-icon".into()),
            }),
        )
        .expect("valid image payload");

        assert_eq!(payload.kind, "image");
        assert!(payload.content.starts_with("data:image/png;base64,"));
        assert_eq!(payload.width, Some(1));
        assert_eq!(
            payload.image_hash.as_deref(),
            Some("bb56ccebcec59e12ecff6f26f69eb98418b0402726e4086c3235e9cdc1d282bc")
        );
        assert_eq!(
            image_capture_hash(1, 1, &[77, 111, 206, 255]).as_deref(),
            payload.image_hash.as_deref()
        );
        assert_eq!(payload.source_app, "截图工具");
        assert_eq!(
            payload.source_app_icon.as_deref(),
            Some("data:image/png;base64,source-icon")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn oversized_or_malformed_rgba_never_reaches_png_base64_or_ipc_payloads() {
        let oversized_dimension = complete_windows_image_fallback(
            clipboard_formats::FormatPackage::default(),
            Some(71),
            ClipboardReadAttempt::Captured {
                snapshot: ClipboardSnapshot::Image {
                    width: 8_193,
                    height: 1,
                    bytes: vec![0; 8_193 * 4],
                    omitted_formats: Vec::new(),
                },
                sequence: None,
            },
            Some(71),
        );
        assert!(matches!(
            oversized_dimension,
            ClipboardReadAttempt::Ignored { package, sequence: Some(71) }
                if package.omitted_formats
                    == vec![clipboard_formats::ClipboardFormatKind::Image]
        ));

        let omitted = clipboard_formats::FormatPackage {
            omitted_formats: vec![clipboard_formats::ClipboardFormatKind::Image],
            ..clipboard_formats::FormatPackage::default()
        };
        assert!(!clipboard_package_allows_image_fallback(&omitted));
        assert!(snapshot_payload(
            ClipboardSnapshot::Image {
                width: usize::MAX,
                height: 2,
                bytes: Vec::new(),
                omitted_formats: Vec::new(),
            },
            None,
        )
        .is_none());
    }

    #[test]
    fn native_ocr_results_have_closed_content_free_error_and_terminal_shapes() {
        let cases = [
            (
                OcrCommandResult::Applied {
                    ocr_status: "completed",
                    ocr_text: Some("line\r\ntext".into()),
                },
                serde_json::json!({
                    "status": "applied",
                    "ocrStatus": "completed",
                    "ocrText": "line\r\ntext"
                }),
            ),
            (
                OcrCommandResult::Applied {
                    ocr_status: "oversized",
                    ocr_text: None,
                },
                serde_json::json!({"status": "applied", "ocrStatus": "oversized"}),
            ),
            (
                OcrCommandResult::Stale {},
                serde_json::json!({"status": "stale"}),
            ),
            (
                OcrCommandResult::Error {
                    reason: OcrErrorReason::QueueFull,
                },
                serde_json::json!({"status": "error", "reason": "queueFull"}),
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(
                serde_json::to_value(actual).expect("serialize OCR result"),
                expected
            );
        }
    }

    #[test]
    fn deterministic_ocr_failures_become_terminal_failed_patches() {
        assert_eq!(
            terminal_ocr_patch(Ok(ocr::OcrOutcome::Completed("text".into()))),
            ("completed", Some("text".into()))
        );
        assert_eq!(
            terminal_ocr_patch(Ok(ocr::OcrOutcome::Unavailable)),
            ("unavailable", None)
        );
        assert_eq!(
            terminal_ocr_patch(Ok(ocr::OcrOutcome::Oversized)),
            ("oversized", None)
        );
        for failure in [ocr::OcrFailure::Decode, ocr::OcrFailure::Winrt] {
            assert_eq!(terminal_ocr_patch(Err(failure)), ("failed", None));
        }
        assert_eq!(
            terminal_ocr_patch(Err(ocr::OcrFailure::Oversized)),
            ("oversized", None)
        );
    }

    #[test]
    fn captured_images_keep_their_original_dimensions_for_paste_back() {
        let width = 3_001_usize;
        let height = 2_usize;
        let data_url = image_data_url(width, height, vec![255; width * height * 4])
            .expect("valid full-resolution image");
        let encoded = data_url
            .strip_prefix("data:image/png;base64,")
            .expect("PNG data URL");
        let png = STANDARD.decode(encoded).expect("base64 payload");
        let decoded = image::load_from_memory(&png).expect("encoded PNG");

        assert_eq!(
            (decoded.width(), decoded.height()),
            (width as u32, height as u32)
        );
    }

    #[test]
    fn source_app_icon_payloads_use_camel_case_and_clear_without_stale_icon() {
        let captured = CapturedClipboardPayload {
            kind: "text",
            content: "hello".into(),
            captured_at: "2026-07-19T00:00:00.000Z".into(),
            source_app: "Notepad".into(),
            source_app_icon: Some("data:image/png;base64,captured".into()),
            width: None,
            height: None,
            image_hash: None,
            formats: vec![clipboard_formats::ClipboardFormatKind::Text],
            html: None,
            rtf_base64: None,
            files: Vec::new(),
            omitted_formats: Vec::new(),
        };
        let target = PasteTargetPayload {
            session_id: 7,
            source_app: "Notepad".into(),
            source_app_icon: Some("data:image/png;base64,target".into()),
            elevated: false,
        };
        let invocation = QuickPanelInvocationPayload {
            session_id: 7,
            source_app: "Notepad".into(),
            source_app_icon: Some("data:image/png;base64,invocation".into()),
            elevated: false,
        };

        for payload in [
            serde_json::to_value(captured).expect("serialize captured payload"),
            serde_json::to_value(target).expect("serialize target payload"),
            serde_json::to_value(invocation).expect("serialize invocation payload"),
        ] {
            assert!(payload.get("sourceAppIcon").is_some());
            assert!(payload.get("source_app_icon").is_none());
        }

        let cleared = cleared_paste_target_payload(8);
        assert_eq!(cleared.source_app_icon, None);
        let cleared_json = serde_json::to_value(cleared).expect("serialize cleared payload");
        assert!(cleared_json.get("sourceAppIcon").is_none());
    }

    #[test]
    fn clipboard_source_keeps_name_and_icon_from_the_same_identity() {
        let clipboard_owner = SourceAppIdentity {
            name: "Owner".into(),
            icon: Some("owner-icon".into()),
        };
        let foreground = SourceAppIdentity {
            name: "Foreground".into(),
            icon: Some("foreground-icon".into()),
        };

        assert_eq!(
            choose_clipboard_source(Some(clipboard_owner.clone()), Some(foreground)),
            Some(clipboard_owner)
        );
    }

    #[test]
    fn app_icon_cache_keeps_hits_and_misses_with_a_bounded_capacity() {
        assert_eq!(APP_ICON_CACHE_CAPACITY, 96);
        let mut cache = AppIconCache::new(2);
        cache.insert("c:\\apps\\one.exe".into(), Some("one-icon".into()));
        cache.insert("c:\\apps\\missing.exe".into(), None);

        assert_eq!(
            cache.get("c:\\apps\\one.exe"),
            Some(Some("one-icon".into()))
        );
        assert_eq!(cache.get("c:\\apps\\missing.exe"), Some(None));

        cache.insert("c:\\apps\\one.exe".into(), None);
        assert_eq!(
            cache.get("c:\\apps\\one.exe"),
            Some(Some("one-icon".into()))
        );

        cache.insert("c:\\apps\\three.exe".into(), Some("three-icon".into()));
        assert_eq!(cache.get("c:\\apps\\one.exe"), None);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn app_icon_png_encoding_is_always_64_square_and_rejects_invalid_rgba() {
        assert!(app_icon_png_data_url(0, 1, vec![]).is_none());
        assert!(app_icon_png_data_url(1, 1, vec![1, 2, 3]).is_none());
        assert!(app_icon_png_data_url(1, 1, vec![1, 2, 3, 0]).is_none());

        let data_url =
            app_icon_png_data_url(1, 1, vec![77, 111, 206, 128]).expect("valid icon data URL");
        let png = STANDARD
            .decode(
                data_url
                    .strip_prefix("data:image/png;base64,")
                    .expect("PNG data URL prefix"),
            )
            .expect("base64 PNG");

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 64);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 64);
        let decoded = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .expect("decode generated PNG")
            .to_rgba8();
        assert_eq!(decoded.get_pixel(0, 0).0, [77, 111, 206, 128]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_extracts_current_executable_icon_as_64_png() {
        let executable = std::env::current_exe().expect("current test executable");
        let started_at = Instant::now();
        let data_url = extract_app_icon(&executable).expect("extract current executable icon");
        let elapsed = started_at.elapsed();
        let png = STANDARD
            .decode(
                data_url
                    .strip_prefix("data:image/png;base64,")
                    .expect("safe PNG data URL prefix"),
            )
            .expect("base64 PNG");
        let decoded = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .expect("decode extracted PNG")
            .to_rgba8();

        assert_eq!(decoded.dimensions(), (APP_ICON_SIZE, APP_ICON_SIZE));
        assert!(decoded.pixels().any(|pixel| pixel[3] != 0));
        eprintln!("首次 Shell/WIC 图标提取耗时: {elapsed:?}");
    }

    #[test]
    fn paste_target_is_consumed_after_one_activation() {
        let target = PasteTarget::default();
        target.remember(4242);

        assert_eq!(target.take(), Some(4242));
        assert_eq!(target.take(), None);
    }

    #[test]
    fn paste_target_remembers_the_exact_focused_child_window() {
        let target = PasteTarget::default();
        target.remember_with_pid_and_focus(4242, 777, Some(4343));

        let identity = target
            .identity_for_activation(false)
            .expect("paste target should exist");
        assert_eq!(identity.window_handle, 4242);
        assert_eq!(identity.process_id, 777);
        assert_eq!(identity.focus_window_handle, Some(4343));
    }

    #[test]
    fn pinned_success_keeps_the_same_target_for_continuous_paste() {
        let target = PasteTarget::default();
        target.remember(4242);

        let first = target
            .identity_for_activation(true)
            .expect("pinned panel should have a paste target");
        assert!(!target.complete_activation(&first, true, true));

        let second = target
            .identity_for_activation(true)
            .expect("successful pinned paste should keep its target");
        assert_eq!(second.window_handle, 4242);
    }

    #[test]
    fn pinned_failure_clears_the_stale_target() {
        let target = PasteTarget::default();
        target.remember(4242);

        let identity = target
            .identity_for_activation(true)
            .expect("pinned panel should have a paste target");
        assert!(target.complete_activation(&identity, true, false));
        assert!(target.identity_for_activation(true).is_none());
    }

    #[test]
    fn unpinned_activation_still_consumes_the_target_immediately() {
        let target = PasteTarget::default();
        target.remember(4242);

        assert!(target.identity_for_activation(false).is_some());
        assert!(target.identity_for_activation(false).is_none());
    }

    #[test]
    fn completing_an_old_activation_does_not_clear_a_new_target() {
        let target = PasteTarget::default();
        target.remember(4242);
        let old_identity = target
            .identity_for_activation(true)
            .expect("first target should exist");
        target.remember(8484);

        assert!(!target.complete_activation(&old_identity, true, false));
        assert_eq!(
            target
                .identity_for_activation(true)
                .expect("new target should remain")
                .window_handle,
            8484
        );
    }

    #[test]
    fn sensitive_app_exclusions_ignore_case_and_whitespace() {
        let exclusions = CaptureExclusions::default();
        exclusions.replace(vec![" 1Password ".into(), "Bitwarden".into()]);

        assert!(exclusions.contains("1password"));
        assert!(exclusions.contains("BITWARDEN"));
        assert!(!exclusions.contains("Microsoft Word"));
    }

    #[test]
    fn clipboard_owner_wins_over_a_later_foreground_window() {
        let owner = SourceAppIdentity {
            name: "1Password".into(),
            icon: Some("owner-icon".into()),
        };
        let foreground = SourceAppIdentity {
            name: "Notepad".into(),
            icon: Some("foreground-icon".into()),
        };
        assert_eq!(
            choose_clipboard_source(Some(owner.clone()), Some(foreground.clone())),
            Some(owner)
        );
        assert_eq!(
            choose_clipboard_source(None, Some(foreground.clone())),
            Some(foreground)
        );
    }

    #[test]
    fn windows_process_names_are_presented_as_friendly_sources() {
        assert_eq!(
            friendly_app_name(r"C:\Program Files\Microsoft Office\WINWORD.EXE"),
            "Microsoft Word"
        );
        assert_eq!(
            friendly_app_name(r"C:\Windows\System32\notepad.exe"),
            "Notepad"
        );
        assert_eq!(
            friendly_app_name(r"C:\Tools\custom-editor.exe"),
            "custom-editor"
        );
    }

    #[test]
    fn own_window_is_never_presented_as_the_paste_destination() {
        assert_eq!(paste_target_label(Some("QuickPaste".into())), "");
        assert_eq!(paste_target_label(Some("mypaste".into())), "");
        assert_eq!(paste_target_label(Some("Notepad".into())), "Notepad");
    }

    #[test]
    fn configured_shortcuts_require_a_primary_modifier() {
        assert!(parse_configured_shortcut("Ctrl+Alt+K").is_ok());
        assert!(parse_configured_shortcut("Ctrl+Shift+V").is_ok());
        assert!(parse_configured_shortcut("Ctrl+C").is_err());
        assert!(parse_configured_shortcut("Ctrl+V").is_err());
        assert!(parse_configured_shortcut("Alt+V").is_err());
        assert!(parse_configured_shortcut("Alt+Space").is_err());
        assert!(parse_configured_shortcut("Alt+Tab").is_err());
        assert!(parse_configured_shortcut("Ctrl+Escape").is_err());
        assert!(parse_configured_shortcut("Shift+V").is_err());
        assert!(parse_configured_shortcut("V").is_err());
    }

    #[test]
    fn shortcut_registration_recovers_a_missing_current_registration() {
        assert_eq!(
            shortcut_update_plan("Ctrl+Shift+V", "Ctrl+Shift+V", false),
            ShortcutUpdatePlan::RegisterOnly
        );
        assert_eq!(
            shortcut_update_plan("Ctrl+Shift+V", "Ctrl+Shift+V", true),
            ShortcutUpdatePlan::AlreadyRegistered
        );
        assert_eq!(
            shortcut_update_plan("Ctrl+Shift+V", "Alt+Space", true),
            ShortcutUpdatePlan::Replace
        );
        assert_eq!(
            shortcut_update_plan("Ctrl+Shift+V", "Alt+Space", false),
            ShortcutUpdatePlan::RegisterOnly
        );
    }

    #[test]
    fn shortcut_replacement_registers_new_before_unregistering_old() {
        assert_eq!(
            shortcut_update_steps(ShortcutUpdatePlan::Replace),
            vec![
                ShortcutUpdateStep::RegisterNext,
                ShortcutUpdateStep::UnregisterPrevious,
                ShortcutUpdateStep::CommitNext,
            ]
        );
    }

    #[test]
    fn foreground_target_rejects_own_window_and_own_process() {
        assert!(!foreground_target_is_eligible(42, 100, 200, Some(42)));
        assert!(!foreground_target_is_eligible(43, 200, 200, Some(42)));
        assert!(foreground_target_is_eligible(43, 100, 200, Some(42)));
    }

    #[test]
    fn cleared_paste_target_event_has_no_stale_destination() {
        let payload = cleared_paste_target_payload(7);
        assert_eq!(payload.session_id, 7);
        assert_eq!(payload.source_app, "");
        assert!(!payload.elevated);
    }

    #[test]
    fn quick_panel_invocation_uses_a_dedicated_event() {
        assert_eq!(QUICK_PANEL_INVOKED_EVENT, "quick-panel://invoked");
        assert_ne!(QUICK_PANEL_INVOKED_EVENT, PASTE_TARGET_EVENT);
    }

    #[test]
    fn modifier_gate_requires_every_physical_modifier_to_be_released() {
        assert!(modifier_states_are_released(&[
            false, false, false, false, false
        ]));
        assert!(!modifier_states_are_released(&[
            false, true, false, false, false
        ]));
    }

    #[test]
    fn partial_ctrl_v_injection_releases_only_keys_we_pressed() {
        assert_eq!(ctrl_v_partial_cleanup_range(0), None);
        assert_eq!(ctrl_v_partial_cleanup_range(1), Some((3, 4)));
        assert_eq!(ctrl_v_partial_cleanup_range(2), Some((2, 4)));
        assert_eq!(ctrl_v_partial_cleanup_range(3), Some((3, 4)));
        assert_eq!(ctrl_v_partial_cleanup_range(4), None);
    }

    #[test]
    fn helper_deadline_is_absolute_and_fail_closed() {
        assert!(helper_deadline_allows_injection(10_001, 10_000));
        assert!(!helper_deadline_allows_injection(10_000, 10_000));
        assert!(!helper_deadline_allows_injection(9_999, 10_000));

        assert!(elevated_helper_request_is_active(10_001, 10_000, false));
        assert!(!elevated_helper_request_is_active(10_001, 10_000, true));
        assert!(!elevated_helper_request_is_active(10_000, 10_000, false));
    }

    #[test]
    fn elevated_helper_allows_only_one_pending_uac_request() {
        let busy = AtomicBool::new(false);
        assert!(try_acquire_elevated_helper_slot(&busy));
        assert!(!try_acquire_elevated_helper_slot(&busy));
        release_elevated_helper_slot(&busy);
        assert!(try_acquire_elevated_helper_slot(&busy));
    }

    #[test]
    fn persistent_main_process_refuses_elevated_or_unknown_integrity() {
        assert!(main_process_startup_allowed(Some(false)));
        assert!(!main_process_startup_allowed(Some(true)));
        assert!(!main_process_startup_allowed(None));
    }

    #[test]
    fn elevated_pipe_request_is_bound_to_the_exact_session() {
        let request = ElevatedPasteRequest {
            window_handle: 4242,
            focus_window_handle: Some(4343),
            process_id: 77,
            deadline_ms: 123456,
            nonce: "00112233445566778899aabbccddeeff".into(),
            clipboard_sequence: 9001,
        };
        let message = elevated_request_message(&request);
        assert_eq!(
            parse_elevated_request_message(&message),
            Some(request.clone())
        );
        assert_eq!(
            elevated_pipe_name(&request.nonce),
            Some(r"\\.\pipe\MyPaste.ElevatedPaste.00112233445566778899aabbccddeeff".into())
        );

        let mut changed = request.clone();
        changed.process_id = 78;
        assert_ne!(parse_elevated_request_message(&message), Some(changed));
        assert!(parse_elevated_request_message(&format!("{message}unexpected\n")).is_none());
        assert!(
            parse_elevated_request_message(&"x".repeat(ELEVATED_REQUEST_MAX_BYTES + 1)).is_none()
        );
        assert!(elevated_pipe_name("../../forged").is_none());
        assert!(clipboard_sequence_matches(9001, Some(9001)));
        assert!(!clipboard_sequence_matches(9001, Some(9002)));
        assert!(!clipboard_sequence_matches(9001, None));
        assert_eq!(
            stable_verified_clipboard_sequence(Some(9001), true, Some(9001)),
            Some(9001)
        );
        assert_eq!(
            stable_verified_clipboard_sequence(Some(9001), false, Some(9001)),
            None
        );
        assert_eq!(
            stable_verified_clipboard_sequence(Some(9001), true, Some(9002)),
            None
        );

        let mut missing_binding = request.clone();
        missing_binding.clipboard_sequence = 0;
        assert!(
            parse_elevated_request_message(&elevated_request_message(&missing_binding)).is_none()
        );
    }

    #[test]
    fn elevated_pipe_requires_mutual_process_authentication() {
        assert!(elevated_helper_client_is_trusted(41, 41));
        assert!(!elevated_helper_client_is_trusted(40, 41));
        assert!(!elevated_helper_client_is_trusted(0, 0));

        assert!(elevated_helper_server_is_trusted(
            41,
            41,
            99,
            Some(false),
            true
        ));
        assert!(!elevated_helper_server_is_trusted(
            40,
            41,
            99,
            Some(false),
            true
        ));
        assert!(!elevated_helper_server_is_trusted(
            0,
            0,
            99,
            Some(false),
            true
        ));
        assert!(!elevated_helper_server_is_trusted(
            99,
            99,
            99,
            Some(false),
            true
        ));
        assert!(!elevated_helper_server_is_trusted(
            41,
            41,
            99,
            Some(true),
            true
        ));
        assert!(!elevated_helper_server_is_trusted(41, 41, 99, None, true));
        assert!(!elevated_helper_server_is_trusted(
            41,
            41,
            99,
            Some(false),
            false
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn elevated_pipe_transfers_one_bounded_request_to_the_expected_client() {
        use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{CloseHandle, GENERIC_READ},
                Storage::FileSystem::{
                    CreateFileW, ReadFile, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING,
                    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
                },
                System::{Pipes::WaitNamedPipeW, Threading::GetCurrentProcess},
            },
        };

        let nonce = elevated_request_nonce().expect("system RNG should be available");
        let deadline_ms = unix_time_millis().expect("system clock should be available") + 5_000;
        let request = ElevatedPasteRequest {
            window_handle: 4242,
            focus_window_handle: Some(4343),
            process_id: 77,
            deadline_ms,
            nonce: nonce.clone(),
            clipboard_sequence: 9001,
        };
        let pipe = create_elevated_request_pipe(&nonce).expect("pipe should be created");
        let pipe_name = elevated_pipe_name(&nonce).expect("nonce should form a pipe name");
        let client = thread::spawn(move || {
            let pipe_name_wide = OsStr::new(&pipe_name)
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            assert!(unsafe { WaitNamedPipeW(PCWSTR(pipe_name_wide.as_ptr()), 5_000) }.as_bool());
            let handle = unsafe {
                CreateFileW(
                    PCWSTR(pipe_name_wide.as_ptr()),
                    GENERIC_READ.0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    None,
                )
            }
            .expect("client should connect");
            let mut bytes = [0_u8; ELEVATED_REQUEST_MAX_BYTES];
            let mut read = 0_u32;
            unsafe { ReadFile(handle, Some(&mut bytes), Some(&mut read), None) }
                .expect("client should receive one request");
            let _ = unsafe { CloseHandle(handle) };
            String::from_utf8(bytes[..read as usize].to_vec()).expect("request should be UTF-8")
        });

        assert!(wait_for_elevated_helper_connection(
            &pipe,
            unsafe { GetCurrentProcess() },
            std::process::id(),
            deadline_ms,
            &AtomicBool::new(false),
        ));
        assert!(write_elevated_request_to_pipe(&pipe, &request));
        let received = client.join().expect("client thread should finish");
        assert_eq!(parse_elevated_request_message(&received), Some(request));
    }

    #[test]
    fn quick_panel_prefers_the_caret_bottom_right_and_flips_at_screen_edges() {
        let work_area = ScreenRect::new(0, 0, 1920, 1040);
        let size = ScreenSize::new(800, 580);

        assert_eq!(
            place_window_near_anchor(ScreenRect::new(600, 180, 602, 204), size, work_area, 12),
            ScreenPoint::new(614, 216)
        );
        assert_eq!(
            place_window_near_anchor(ScreenRect::new(1900, 1000, 1902, 1024), size, work_area, 12),
            ScreenPoint::new(1088, 408)
        );
        assert_eq!(
            place_window_near_anchor(ScreenRect::new(1900, 180, 1902, 204), size, work_area, 12),
            ScreenPoint::new(1088, 216)
        );
        assert_eq!(
            place_window_near_anchor(ScreenRect::new(600, 1000, 602, 1024), size, work_area, 12),
            ScreenPoint::new(614, 408)
        );
    }

    #[test]
    fn quick_panel_positions_the_visible_shell_at_the_requested_gap() {
        let native_work_area = ScreenRect::new(16, 16, 1904, 1024);
        let native_size = ScreenSize::new(800, 580);
        let anchor = ScreenRect::new(600, 180, 602, 204);

        let native_position = place_quick_panel_window(anchor, native_size, native_work_area, 1.0);
        assert_eq!(native_position, ScreenPoint::new(598, 200));
        assert_eq!(
            ScreenPoint::new(native_position.x + 16, native_position.y + 16),
            ScreenPoint::new(anchor.right + 12, anchor.bottom + 12)
        );
    }

    #[test]
    fn quick_panel_uses_compact_size_when_the_standard_shell_would_cover_a_center_anchor() {
        let cases = [
            ("1366x728 at 100%", ScreenSize::new(1366, 728), 1.0_f64),
            ("1920x1040 at 125%", ScreenSize::new(1920, 1040), 1.25_f64),
        ];

        for (case, screen, scale) in cases {
            let margin = (16.0 * scale).round() as i32;
            let work_area = ScreenRect::new(
                margin,
                margin,
                screen.width - margin,
                screen.height - margin,
            );
            let center_x = screen.width / 2;
            let center_y = screen.height / 2;
            let anchor = ScreenRect::new(
                center_x,
                center_y,
                center_x + (2.0 * scale).round() as i32,
                center_y + (24.0 * scale).round() as i32,
            );

            assert_eq!(
                choose_quick_panel_size_dip(anchor, work_area, scale),
                ScreenSize::new(640, 440),
                "{case}"
            );
        }
    }

    #[test]
    fn quick_panel_shrinks_until_the_visible_shell_clears_the_anchor() {
        let cases = [
            ("1366x728 at 150%", ScreenSize::new(1366, 728), 1.5_f64),
            ("1280x680 at 175%", ScreenSize::new(1280, 680), 1.75_f64),
        ];

        for (case, screen, scale) in cases {
            let margin = (16.0 * scale).round() as i32;
            let work_area = ScreenRect::new(
                margin,
                margin,
                screen.width - margin,
                screen.height - margin,
            );
            let anchor = ScreenRect::new(
                screen.width / 2,
                screen.height / 2,
                screen.width / 2 + (2.0 * scale).round() as i32,
                screen.height / 2 + (24.0 * scale).round() as i32,
            );
            let size_dip = choose_quick_panel_size_dip(anchor, work_area, scale);
            let native_size = fit_window_size_to_work_area(size_dip, work_area, scale);
            let native_position = place_quick_panel_window(anchor, native_size, work_area, scale);
            let inset = (QUICK_PANEL_SHELL_INSET_DIP * scale).round() as i32;
            let visible_shell = ScreenRect::new(
                native_position.x + inset,
                native_position.y + inset,
                native_position.x + native_size.width - inset,
                native_position.y + native_size.height - inset,
            );
            let intersects_anchor = visible_shell.left < anchor.right
                && visible_shell.right > anchor.left
                && visible_shell.top < anchor.bottom
                && visible_shell.bottom > anchor.top;

            assert!(
                !intersects_anchor,
                "{case}: visible shell {visible_shell:?} overlaps anchor {anchor:?} at {size_dip:?}"
            );
        }
    }

    #[test]
    fn quick_panel_keeps_standard_size_when_it_can_clear_the_anchor() {
        let cases = [
            (
                "1920x1040 center at 100%",
                ScreenSize::new(1920, 1040),
                1.0_f64,
                false,
            ),
            (
                "1366x728 corner at 100%",
                ScreenSize::new(1366, 728),
                1.0_f64,
                true,
            ),
            (
                "1366x728 corner at 125%",
                ScreenSize::new(1366, 728),
                1.25_f64,
                true,
            ),
            (
                "1366x728 corner at 150%",
                ScreenSize::new(1366, 728),
                1.5_f64,
                true,
            ),
            (
                "1920x1040 corner at 150%",
                ScreenSize::new(1920, 1040),
                1.5_f64,
                true,
            ),
        ];

        for (case, screen, scale, at_corner) in cases {
            let margin = (16.0 * scale).round() as i32;
            let work_area = ScreenRect::new(
                margin,
                margin,
                screen.width - margin,
                screen.height - margin,
            );
            let anchor = if at_corner {
                ScreenRect::new(
                    screen.width - margin - 42,
                    screen.height - margin - 48,
                    screen.width - margin - 40,
                    screen.height - margin - 24,
                )
            } else {
                ScreenRect::new(
                    screen.width / 2,
                    screen.height / 2,
                    screen.width / 2 + 2,
                    screen.height / 2 + 24,
                )
            };

            assert_eq!(
                choose_quick_panel_size_dip(anchor, work_area, scale),
                ScreenSize::new(800, 580),
                "{case}"
            );
        }
    }

    #[test]
    fn caret_monitor_probe_stays_inside_the_caret_at_display_seams() {
        assert_eq!(
            anchor_monitor_point(ScreenRect::new(-2, 100, 0, 124), None),
            ScreenPoint::new(-1, 112)
        );
        assert_eq!(
            anchor_monitor_point(
                ScreenRect::new(0, 100, 0, 124),
                Some(ScreenPoint::new(-800, 500))
            ),
            ScreenPoint::new(-1, 112)
        );
        assert_eq!(
            anchor_monitor_point(
                ScreenRect::new(0, 100, 0, 124),
                Some(ScreenPoint::new(800, 500))
            ),
            ScreenPoint::new(0, 112)
        );
    }

    #[test]
    fn quick_panel_geometry_covers_all_supported_dpi_and_taskbar_edges() {
        let scales = [1.0_f64, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
        let taskbar_edges = ["top", "right", "bottom", "left"];

        for scale in scales {
            let screen_width = (1920.0 * scale).round() as i32;
            let screen_height = (1080.0 * scale).round() as i32;
            let taskbar = (40.0 * scale).round() as i32;
            let margin = (16.0 * scale).round() as i32;

            for edge in taskbar_edges {
                let native_work = match edge {
                    "top" => ScreenRect::new(0, taskbar, screen_width, screen_height),
                    "right" => ScreenRect::new(0, 0, screen_width - taskbar, screen_height),
                    "bottom" => ScreenRect::new(0, 0, screen_width, screen_height - taskbar),
                    "left" => ScreenRect::new(taskbar, 0, screen_width, screen_height),
                    _ => unreachable!(),
                };
                let work = ScreenRect::new(
                    native_work.left + margin,
                    native_work.top + margin,
                    native_work.right - margin,
                    native_work.bottom - margin,
                );
                let center_x = work.left + (work.right - work.left) / 2;
                let center_y = work.top + (work.bottom - work.top) / 2;
                let anchor = ScreenRect::new(
                    center_x,
                    center_y,
                    center_x + (2.0 * scale).round() as i32,
                    center_y + (24.0 * scale).round() as i32,
                );

                let size_dip = choose_quick_panel_size_dip(anchor, work, scale);
                let native_size = fit_window_size_to_work_area(size_dip, work, scale);
                let position = place_quick_panel_window(anchor, native_size, work, scale);
                let case = format!("scale={scale}, taskbar={edge}");

                assert!(native_size.width >= 1 && native_size.height >= 1, "{case}");
                assert!(
                    position.x >= work.left && position.y >= work.top,
                    "{case}: {position:?}"
                );
                assert!(
                    position.x + native_size.width <= work.right,
                    "{case}: {position:?} {native_size:?}"
                );
                assert!(
                    position.y + native_size.height <= work.bottom,
                    "{case}: {position:?} {native_size:?}"
                );
                assert!(
                    quick_panel_can_clear_anchor(anchor, native_size, work, scale),
                    "{case}"
                );

                let requested_inset = (QUICK_PANEL_SHELL_INSET_DIP * scale).round() as i32;
                let inset_x = requested_inset.clamp(0, ((native_size.width - 1) / 2).max(0));
                let inset_y = requested_inset.clamp(0, ((native_size.height - 1) / 2).max(0));
                let shell = ScreenRect::new(
                    position.x + inset_x,
                    position.y + inset_y,
                    position.x + native_size.width - inset_x,
                    position.y + native_size.height - inset_y,
                );
                assert!(
                    shell.left >= native_work.left && shell.top >= native_work.top,
                    "{case}: {shell:?}"
                );
                assert!(
                    shell.right <= native_work.right && shell.bottom <= native_work.bottom,
                    "{case}: {shell:?}"
                );
                let overlaps = shell.left < anchor.right
                    && shell.right > anchor.left
                    && shell.top < anchor.bottom
                    && shell.bottom > anchor.top;
                assert!(!overlaps, "{case}: shell={shell:?}, anchor={anchor:?}");
            }
        }
    }

    #[test]
    fn quick_panel_geometry_is_bounded_in_small_work_areas_at_all_supported_dpi() {
        for scale in [1.0_f64, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5] {
            let left = (-80.0 * scale).round() as i32;
            let top = (24.0 * scale).round() as i32;
            let width = (520.0 * scale).round() as i32;
            let height = (360.0 * scale).round() as i32;
            let work = ScreenRect::new(left, top, left + width, top + height);
            let anchor = ScreenRect::new(
                left + width / 2,
                top + height / 2,
                left + width / 2 + (2.0 * scale).round() as i32,
                top + height / 2 + (24.0 * scale).round() as i32,
            );
            let size_dip = choose_quick_panel_size_dip(anchor, work, scale);
            let native_size = fit_window_size_to_work_area(size_dip, work, scale);
            let position = place_quick_panel_window(anchor, native_size, work, scale);
            let case = format!("small work area at {scale}");

            assert!(
                (1..=width).contains(&native_size.width),
                "{case}: {native_size:?}"
            );
            assert!(
                (1..=height).contains(&native_size.height),
                "{case}: {native_size:?}"
            );
            assert!(
                (work.left..=work.right - native_size.width).contains(&position.x),
                "{case}: {position:?}"
            );
            assert!(
                (work.top..=work.bottom - native_size.height).contains(&position.y),
                "{case}: {position:?}"
            );
        }
    }

    #[test]
    fn cross_display_anchor_wins_over_cursor_and_selects_the_anchor_monitor() {
        let caret_on_left_seam = ScreenRect::new(-2, 420, 0, 444);
        let cursor_on_right = ScreenPoint::new(960, 540);
        let anchor = choose_popup_anchor(Some(caret_on_left_seam), Some(cursor_on_right)).unwrap();
        assert_eq!(anchor, caret_on_left_seam);
        assert_eq!(
            anchor_monitor_point(anchor, Some(ScreenPoint::new(-1280, 720))),
            ScreenPoint::new(-1, 432),
        );

        let left_work = ScreenRect::new(-2544, 16, -16, 1424);
        let size = fit_window_size_to_work_area(
            choose_quick_panel_size_dip(anchor, left_work, 1.0),
            left_work,
            1.0,
        );
        let position = place_quick_panel_window(anchor, size, left_work, 1.0);
        assert!(position.x >= left_work.left && position.x + size.width <= left_work.right);
        assert!(position.y >= left_work.top && position.y + size.height <= left_work.bottom);

        assert_eq!(
            choose_popup_anchor(Some(ScreenRect::new(0, 0, 0, 0)), Some(cursor_on_right),),
            Some(ScreenRect::from_point(cursor_on_right)),
        );
        assert_eq!(
            anchor_monitor_point(ScreenRect::from_point(cursor_on_right), None),
            cursor_on_right,
        );

        let seam = ScreenRect::new(0, 420, 0, 444);
        assert_eq!(
            anchor_monitor_point(seam, Some(ScreenPoint::new(-1280, 720))).x,
            -1,
        );
        assert_eq!(
            anchor_monitor_point(seam, Some(ScreenPoint::new(960, 540))).x,
            0,
        );
    }

    #[test]
    fn quick_panel_clamps_to_negative_coordinate_work_areas() {
        let work_area = ScreenRect::new(-1920, 40, 0, 1080);
        let size = ScreenSize::new(800, 580);

        assert_eq!(
            place_window_near_anchor(
                ScreenRect::from_point(ScreenPoint::new(-12, 1068)),
                size,
                work_area,
                12
            ),
            ScreenPoint::new(-824, 476)
        );
    }

    #[test]
    fn caret_rect_validation_accepts_zero_width_but_rejects_invalid_geometry() {
        assert!(ScreenRect::new(640, 320, 640, 344).is_valid_caret());
        assert!(!ScreenRect::new(640, 320, 641, 320).is_valid_caret());
        assert!(!ScreenRect::new(640, 344, 641, 320).is_valid_caret());
        assert!(!ScreenRect::new(1_000_000, 320, 1_000_000, 344).is_valid_caret());
        assert!(!ScreenRect::new(i32::MIN, 320, i32::MIN, 344).is_valid_caret());
        assert!(!ScreenRect::new(640, 320, 1_200, 344).is_valid_caret());
        assert!(!ScreenRect::new(640, 320, 641, 1_500).is_valid_caret());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn msaa_caret_uses_a_fallback_line_height_when_the_provider_reports_zero_height() {
        assert_eq!(
            accessibility_caret_rect(640, 320, 0, 0, 30),
            Some(ScreenRect::new(640, 320, 640, 350))
        );
    }

    #[test]
    fn caret_resolution_matches_ditto_order_and_skips_invalid_candidates() {
        let invalid = ScreenRect::new(10, 10, 10, 10);
        let accessibility = ScreenRect::new(100, 100, 102, 124);
        let gui_thread = ScreenRect::new(200, 200, 201, 224);
        let attached = ScreenRect::new(300, 300, 300, 320);

        assert_eq!(
            choose_caret_rect(Some(accessibility), Some(gui_thread), Some(attached)),
            Some(accessibility)
        );
        assert_eq!(
            choose_caret_rect(Some(invalid), Some(gui_thread), Some(attached)),
            Some(gui_thread)
        );
        assert_eq!(
            choose_caret_rect(None, None, Some(attached)),
            Some(attached)
        );
    }

    #[test]
    fn quick_panel_auto_hide_policy_respects_webview_and_native_window_focus() {
        assert!(should_auto_hide_quick_panel(
            WindowMode::Quick,
            false,
            false,
            false,
            false
        ));
        assert!(!should_auto_hide_quick_panel(
            WindowMode::Quick,
            false,
            true,
            false,
            false
        ));
        assert!(!should_auto_hide_quick_panel(
            WindowMode::Quick,
            true,
            false,
            false,
            false
        ));
        assert!(!should_auto_hide_quick_panel(
            WindowMode::Library,
            false,
            false,
            false,
            false
        ));
        assert!(!should_auto_hide_quick_panel(
            WindowMode::Quick,
            false,
            false,
            true,
            false
        ));
        assert!(!should_auto_hide_quick_panel(
            WindowMode::Quick,
            false,
            false,
            false,
            true
        ));
    }

    #[test]
    fn quick_panel_focus_loss_checks_the_native_foreground_window_before_hiding() {
        let source = include_str!("lib.rs");
        let window_event_handler = source
            .split_once(".on_window_event(|window, event| {")
            .expect("window event handler")
            .1
            .split_once("        .invoke_handler(")
            .expect("window event handler end")
            .0;

        assert!(window_event_handler.contains("native_window_is_foreground(window)"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn direct_paste_hands_off_foreground_input_before_injecting_ctrl_v() {
        let source = include_str!("lib.rs");
        let paste_handler = source
            .split_once("fn focus_target_and_send_ctrl_v(")
            .expect("direct paste handler")
            .1
            .split_once("fn paste_into_window(")
            .expect("direct paste handler end")
            .0;

        let attach = paste_handler
            .find("attach_to_foreground_thread()")
            .expect("foreground input handoff");
        let activate = paste_handler
            .find("SetForegroundWindow(target)")
            .expect("target activation");
        let settle = paste_handler
            .find("wait_for_target_activation_settle(")
            .expect("target activation settle");
        let inject = paste_handler
            .find("SendInput(&inputs")
            .expect("Ctrl+V injection");

        assert!(attach < activate);
        assert!(activate < settle);
        assert!(settle < inject);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn direct_paste_verifies_the_exact_target_focus_after_activation() {
        let source = include_str!("lib.rs");
        let focus_restore = source
            .split_once("fn restore_target_focus(")
            .expect("target focus restore")
            .1
            .split_once("fn focus_target_and_send_ctrl_v(")
            .expect("target focus restore end")
            .0;

        assert!(focus_restore.contains("gui_thread_info_for_window("));
        assert!(focus_restore.contains("focus_snapshot_matches_target("));
        assert!(!focus_restore.contains("SetFocus(Some(focus)).is_ok()"));
    }

    #[test]
    fn paste_focus_snapshot_must_match_the_exact_child_root_and_process() {
        let identity = PasteTargetIdentity {
            window_handle: 101,
            focus_window_handle: Some(202),
            process_id: 303,
            captured_at: Instant::now(),
        };

        assert!(focus_snapshot_matches_target(
            &identity,
            202,
            Some(101),
            Some(303)
        ));
        assert!(!focus_snapshot_matches_target(
            &identity,
            203,
            Some(101),
            Some(303)
        ));
        assert!(!focus_snapshot_matches_target(
            &identity,
            202,
            Some(102),
            Some(303)
        ));
        assert!(!focus_snapshot_matches_target(
            &identity,
            202,
            Some(101),
            Some(304)
        ));
    }

    #[test]
    fn paste_focus_snapshot_accepts_the_target_when_no_child_was_captured() {
        let identity = PasteTargetIdentity {
            window_handle: 101,
            focus_window_handle: None,
            process_id: 303,
            captured_at: Instant::now(),
        };

        assert!(focus_snapshot_matches_target(
            &identity,
            101,
            Some(101),
            Some(303)
        ));
    }

    #[test]
    fn repeated_hotkey_toggles_only_a_visible_non_minimized_quick_panel() {
        assert!(should_toggle_quick_panel_on_hotkey(
            WindowMode::Quick,
            true,
            false
        ));
        assert!(!should_toggle_quick_panel_on_hotkey(
            WindowMode::Quick,
            true,
            true
        ));
        assert!(!should_toggle_quick_panel_on_hotkey(
            WindowMode::Quick,
            false,
            false
        ));
        assert!(!should_toggle_quick_panel_on_hotkey(
            WindowMode::Library,
            true,
            false
        ));

        assert_eq!(
            quick_panel_hotkey_action(WindowMode::Quick, true, false),
            QuickPanelHotkeyAction::Hide,
        );
        for (mode, visible, minimized) in [
            (WindowMode::Quick, true, true),
            (WindowMode::Quick, false, false),
            (WindowMode::Library, true, false),
        ] {
            assert_eq!(
                quick_panel_hotkey_action(mode, visible, minimized),
                QuickPanelHotkeyAction::ShowAndSample,
            );
        }
    }

    #[test]
    fn tray_click_shortcut_and_second_launch_share_the_foreground_activation_path() {
        let source = include_str!("lib.rs");
        let single_instance_handler = source
            .split_once(".plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {")
            .expect("single instance handler")
            .1
            .split_once("        }))")
            .expect("single instance handler end")
            .0;
        let shortcut_handler = source
            .split_once(".with_handler(move |app, _shortcut, event| {")
            .expect("shortcut handler")
            .1
            .split_once("                })\n                .build(),")
            .expect("shortcut handler end")
            .0;
        let tray_handler = source
            .split_once(".on_tray_icon_event(|tray, event| {")
            .expect("tray handler")
            .1
            .split_once("                });")
            .expect("tray handler end")
            .0;

        assert!(single_instance_handler.contains("activate_quick_panel_from_foreground("));
        assert!(!single_instance_handler.contains("show_main_window("));
        assert!(shortcut_handler.contains("activate_quick_panel_from_foreground("));
        assert!(tray_handler.contains("activate_quick_panel_from_foreground("));
        assert!(!tray_handler.contains("show_main_window("));
    }

    #[test]
    fn first_frame_acknowledgement_requires_the_current_quick_panel_session() {
        let sessions = CurrentQuickPanelSession::default();
        assert!(!quick_panel_ack_matches_current_session(&sessions, 0));

        let first = sessions.begin();
        assert!(quick_panel_ack_matches_current_session(&sessions, first));

        // 托盘或启动等非采样唤起也会推进全局会话，旧 hotkey 的迟到 rAF 不得入账。
        let second = sessions.begin();
        assert!(!quick_panel_ack_matches_current_session(&sessions, first));
        assert!(quick_panel_ack_matches_current_session(&sessions, second));
    }

    #[test]
    fn popup_anchor_prefers_text_caret_and_falls_back_to_the_pointer_snapshot() {
        let caret = ScreenRect::new(100, 100, 102, 124);
        let pointer = ScreenPoint::new(800, 600);

        assert_eq!(choose_popup_anchor(Some(caret), Some(pointer)), Some(caret));
        assert_eq!(
            choose_popup_anchor(None, Some(pointer)),
            Some(ScreenRect::from_point(pointer))
        );
        assert_eq!(
            choose_popup_anchor(Some(ScreenRect::new(10, 10, 10, 10)), Some(pointer)),
            Some(ScreenRect::from_point(pointer))
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn win32_gui_thread_caret_is_converted_to_physical_screen_coordinates() {
        use windows::{
            core::w,
            Win32::{
                Foundation::HWND,
                UI::WindowsAndMessaging::{
                    CreateCaret, CreateWindowExW, DestroyCaret, DestroyWindow, SetCaretPos,
                    WINDOW_EX_STYLE, WS_POPUP,
                },
            },
        };

        struct NativeCaretWindow(HWND);
        impl Drop for NativeCaretWindow {
            fn drop(&mut self) {
                let _ = unsafe { DestroyCaret() };
                let _ = unsafe { DestroyWindow(self.0) };
            }
        }

        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("QuickPaste caret test"),
                WS_POPUP,
                120,
                140,
                300,
                200,
                None,
                None,
                None,
                None,
            )
        }
        .expect("the hidden caret test window should be created");
        let _window = NativeCaretWindow(window);
        unsafe { CreateCaret(window, None, 2, 24) }
            .expect("the hidden window should own a native caret");
        unsafe { SetCaretPos(40, 50) }.expect("the native caret should be positioned");

        let rect = caret_rect_from_gui_thread(window.0 as isize)
            .expect("GetGUIThreadInfo should expose the native caret");
        assert_eq!(rect.right - rect.left, 2);
        assert_eq!(rect.bottom - rect.top, 24);
    }

    #[test]
    fn library_mode_uses_a_roomier_window_than_the_quick_panel() {
        assert_eq!(
            window_size_dip(WindowMode::Quick),
            ScreenSize::new(800, 580)
        );
        assert_eq!(
            window_size_dip(WindowMode::Library),
            ScreenSize::new(1080, 720)
        );
    }

    #[test]
    fn window_minimum_is_disabled_for_quick_mode_and_restored_for_library_mode() {
        let work_area = ScreenRect::new(20, 20, 1900, 1020);

        assert_eq!(
            window_min_size_native(WindowMode::Quick, work_area, 1.25),
            None
        );
        assert_eq!(
            window_min_size_native(WindowMode::Library, work_area, 1.25),
            Some(ScreenSize::new(800, 550))
        );

        let small_work_area = ScreenRect::new(0, 0, 1_000, 600);
        assert_eq!(
            window_min_size_native(WindowMode::Library, small_work_area, 1.5),
            Some(ScreenSize::new(960, 600))
        );
    }

    #[test]
    fn native_window_failures_keep_the_operation_context() {
        assert_eq!(
            window_operation_result("退出最大化状态", Err::<(), _>("access denied")),
            Err("退出最大化状态: access denied".to_owned())
        );
    }

    #[test]
    fn startup_config_does_not_reintroduce_a_static_quick_panel_minimum() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json should be valid JSON");
        let window = &config["app"]["windows"][0];

        assert!(window.get("minWidth").is_none());
        assert!(window.get("minHeight").is_none());
    }

    #[test]
    fn elevated_targets_use_the_helper_only_when_the_user_allows_it() {
        assert_eq!(
            choose_paste_strategy(false, true, true),
            PasteStrategy::ElevatedHelper
        );
        assert_eq!(
            choose_paste_strategy(false, true, false),
            PasteStrategy::CopyOnly
        );
        assert_eq!(
            choose_paste_strategy(true, true, true),
            PasteStrategy::CopyOnly
        );
        assert_eq!(
            choose_paste_strategy(false, false, true),
            PasteStrategy::Direct
        );
    }

    #[test]
    fn paste_strategy_maps_to_one_closed_terminal_metric() {
        assert_eq!(
            paste_strategy_terminal_outcome(PasteStrategy::Direct, true),
            metrics::PasteTerminalOutcome::DirectSucceeded,
        );
        assert_eq!(
            paste_strategy_terminal_outcome(PasteStrategy::Direct, false),
            metrics::PasteTerminalOutcome::DirectFailed,
        );
        assert_eq!(
            paste_strategy_terminal_outcome(PasteStrategy::ElevatedHelper, true),
            metrics::PasteTerminalOutcome::ElevatedSucceeded,
        );
        assert_eq!(
            paste_strategy_terminal_outcome(PasteStrategy::ElevatedHelper, false),
            metrics::PasteTerminalOutcome::ElevatedFailed,
        );
        assert_eq!(
            paste_strategy_terminal_outcome(PasteStrategy::CopyOnly, false),
            metrics::PasteTerminalOutcome::ElevationDisabled,
        );
    }

    #[test]
    fn capture_decision_maps_every_stable_sequence_to_one_terminal_metric() {
        assert_eq!(
            captured_snapshot_terminal_outcome(true, true, false, false, true, Some(true)),
            metrics::CaptureTerminalOutcome::InternalWrite,
        );
        assert_eq!(
            captured_snapshot_terminal_outcome(false, false, false, false, true, Some(true)),
            metrics::CaptureTerminalOutcome::Duplicate,
        );
        assert_eq!(
            captured_snapshot_terminal_outcome(false, true, true, false, true, Some(true)),
            metrics::CaptureTerminalOutcome::Paused,
        );
        assert_eq!(
            captured_snapshot_terminal_outcome(false, true, false, true, true, Some(true)),
            metrics::CaptureTerminalOutcome::Excluded,
        );
        assert_eq!(
            captured_snapshot_terminal_outcome(false, true, false, false, false, None),
            metrics::CaptureTerminalOutcome::ExternalFailed,
        );
        assert_eq!(
            captured_snapshot_terminal_outcome(false, true, false, false, true, Some(true)),
            metrics::CaptureTerminalOutcome::ExternalDelivered,
        );
        assert_eq!(
            captured_snapshot_terminal_outcome(false, true, false, false, true, Some(false)),
            metrics::CaptureTerminalOutcome::ExternalFailed,
        );
    }

    #[test]
    fn an_unverified_clipboard_write_is_copy_only_before_any_target_strategy() {
        let result = unverified_clipboard_copy_result(None).expect("copy-only result");

        assert!(result.copied);
        assert!(!result.pasted);
        assert!(!result.requires_elevation);
        assert!(unverified_clipboard_copy_result(Some(42)).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn helper_arguments_only_select_an_authenticated_pipe_session() {
        assert_eq!(parse_elevated_helper_arguments(&["--hidden".into()]), None);
        assert_eq!(
            parse_elevated_helper_arguments(&["--mypaste-elevated-paste".into()]),
            Some(Err(()))
        );
        let valid = parse_elevated_helper_arguments(&[
            "--mypaste-elevated-paste".into(),
            "41".into(),
            "123456".into(),
            "00112233445566778899aabbccddeeff".into(),
        ]);
        assert_eq!(
            valid,
            Some(Ok(ElevatedHelperInvocation {
                parent_process_id: 41,
                deadline_ms: 123456,
                nonce: "00112233445566778899aabbccddeeff".into(),
            }))
        );

        // 旧协议允许调用方直接指定目标窗口并伪造本地 proof；该形式必须永久拒绝。
        assert_eq!(
            parse_elevated_helper_arguments(&[
                "--mypaste-elevated-paste".into(),
                "4242".into(),
                "77".into(),
                "123456".into(),
                "00112233445566778899aabbccddeeff".into(),
            ]),
            Some(Err(()))
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ctrl_v_input_sequence_releases_keys_in_reverse_order() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_KEYUP, VK_CONTROL, VK_V};

        let inputs = ctrl_v_inputs();
        assert_eq!(inputs.len(), 4);
        unsafe {
            assert_eq!(inputs[0].Anonymous.ki.wVk, VK_CONTROL);
            assert_eq!(inputs[1].Anonymous.ki.wVk, VK_V);
            assert!(inputs[2].Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP));
            assert!(inputs[3].Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP));
        }
    }

    #[test]
    fn clipboard_initialization_retries_are_finite() {
        let mut attempts = 0;
        let result = retry_with_delay(4, Duration::ZERO, || {
            attempts += 1;
            (attempts == 4).then_some("ready")
        });

        assert_eq!(result, Some("ready"));
        assert_eq!(attempts, 4);
        let never = retry_with_delay(4, Duration::ZERO, || None::<()>);
        assert!(never.is_none());
    }

    #[test]
    fn clipboard_snapshot_read_retries_transient_contention_before_succeeding() {
        let mut attempts = 0;
        let outcome = retry_clipboard_snapshot_read(4, Duration::ZERO, || {
            attempts += 1;
            if attempts < 3 {
                ClipboardReadAttempt::Retryable
            } else {
                ClipboardReadAttempt::Captured {
                    snapshot: ClipboardSnapshot::Text("重试成功".into()),
                    sequence: Some(41),
                }
            }
        });

        assert_eq!(attempts, 3);
        assert!(matches!(
            outcome,
            ClipboardReadOutcome::Captured {
                snapshot: ClipboardSnapshot::Text(ref text),
                sequence: Some(41),
            } if text == "重试成功"
        ));
    }

    #[test]
    fn retry_outcome_carries_the_sequence_from_the_stable_successful_attempt() {
        let snapshot = ClipboardSnapshot::Text("重试后的新内容".into());
        let signature = snapshot_signature(&snapshot);
        let writes = InternalClipboardWrites::default();
        let pending = writes.begin(&snapshot);
        writes.commit(pending, Some(42));
        let mut attempts = 0;

        let outcome = retry_clipboard_snapshot_read(2, Duration::ZERO, || {
            attempts += 1;
            if attempts == 1 {
                ClipboardReadAttempt::Retryable
            } else {
                ClipboardReadAttempt::Captured {
                    snapshot: ClipboardSnapshot::Text("重试后的新内容".into()),
                    sequence: Some(42),
                }
            }
        });

        assert!(matches!(
            outcome,
            ClipboardReadOutcome::Captured {
                sequence: Some(42),
                ..
            }
        ));
        assert_eq!(committed_clipboard_sequence(Some(41), &outcome), Some(42));
        let actual_sequence = match outcome {
            ClipboardReadOutcome::Captured { sequence, .. } => sequence,
            _ => unreachable!("stable capture expected"),
        };
        assert!(writes.consume(actual_sequence, signature));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_image_fallback_carries_omissions_through_retry_to_monitor_payload() {
        let omitted_package = clipboard_formats::FormatPackage {
            omitted_formats: vec![
                clipboard_formats::ClipboardFormatKind::Html,
                clipboard_formats::ClipboardFormatKind::Rtf,
            ],
            ..clipboard_formats::FormatPackage::default()
        };
        let attempt = complete_windows_image_fallback(
            omitted_package,
            Some(73),
            ClipboardReadAttempt::Captured {
                snapshot: ClipboardSnapshot::Image {
                    width: 1,
                    height: 1,
                    bytes: vec![1, 2, 3, 255],
                    omitted_formats: Vec::new(),
                },
                sequence: None,
            },
            Some(73),
        );
        let mut attempt = Some(attempt);
        let outcome = retry_clipboard_snapshot_read(1, Duration::ZERO, || {
            attempt.take().expect("one monitor read attempt")
        });

        let ClipboardReadOutcome::Captured {
            snapshot,
            sequence: Some(73),
        } = outcome
        else {
            panic!("stable image fallback should reach the monitor as a captured outcome");
        };
        let payload = snapshot_payload(snapshot, None).expect("monitor event candidate");
        assert_eq!(
            payload.omitted_formats,
            vec![
                clipboard_formats::ClipboardFormatKind::Html,
                clipboard_formats::ClipboardFormatKind::Rtf,
            ]
        );
        let json = serde_json::to_value(payload).expect("serialize monitor payload");
        assert_eq!(json["omittedFormats"], serde_json::json!(["html", "rtf"]));
        let history_formats: Vec<history::ClipboardFormat> =
            serde_json::from_value(json["omittedFormats"].clone())
                .expect("monitor omissions match the history JSON contract");
        assert_eq!(
            history_formats,
            vec![
                history::ClipboardFormat::Html,
                history::ClipboardFormat::Rtf,
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_ignored_package_reaches_the_monitor_outcome_without_an_image() {
        let omitted_package = clipboard_formats::FormatPackage {
            omitted_formats: vec![clipboard_formats::ClipboardFormatKind::Html],
            ..clipboard_formats::FormatPackage::default()
        };
        let attempt = complete_windows_image_fallback(
            omitted_package,
            Some(74),
            ClipboardReadAttempt::Ignored {
                package: clipboard_formats::FormatPackage::default(),
                sequence: None,
            },
            Some(74),
        );
        let mut attempt = Some(attempt);
        let outcome = retry_clipboard_snapshot_read(1, Duration::ZERO, || {
            attempt.take().expect("one monitor read attempt")
        });

        let candidate = monitor_omission_candidate(&outcome)
            .expect("the monitor should retain an omission-only package candidate");
        assert_eq!(candidate.sequence, Some(74));
        assert_eq!(
            candidate.package.omitted_formats,
            vec![clipboard_formats::ClipboardFormatKind::Html]
        );
        assert!(matches!(
            outcome,
            ClipboardReadOutcome::Ignored {
                package: clipboard_formats::FormatPackage { ref omitted_formats, .. },
                sequence: Some(74),
            } if omitted_formats == &[clipboard_formats::ClipboardFormatKind::Html]
        ));
    }

    #[test]
    fn clipboard_snapshot_read_stops_after_a_finite_retry_budget() {
        let mut attempts = 0;
        let outcome = retry_clipboard_snapshot_read(4, Duration::ZERO, || {
            attempts += 1;
            ClipboardReadAttempt::<ClipboardSnapshot>::Retryable
        });

        assert_eq!(attempts, 4);
        assert!(matches!(outcome, ClipboardReadOutcome::Exhausted));
    }

    #[test]
    fn clipboard_sequence_is_committed_only_after_a_terminal_read_outcome() {
        let previous = Some(40);

        assert_eq!(
            committed_clipboard_sequence(
                previous,
                &ClipboardReadOutcome::<ClipboardSnapshot>::Exhausted,
            ),
            previous
        );
        assert_eq!(
            committed_clipboard_sequence(
                previous,
                &ClipboardReadOutcome::Captured {
                    snapshot: ClipboardSnapshot::Text("内容".into()),
                    sequence: Some(41),
                },
            ),
            Some(41)
        );
        assert_eq!(
            committed_clipboard_sequence(
                previous,
                &ClipboardReadOutcome::<ClipboardSnapshot>::Ignored {
                    package: clipboard_formats::FormatPackage::default(),
                    sequence: Some(41),
                },
            ),
            Some(41)
        );
    }

    #[test]
    fn sequence_less_platforms_are_not_permanently_suppressed_after_exhaustion() {
        assert_eq!(exhausted_clipboard_sequence(None), None);
        assert_eq!(exhausted_clipboard_sequence(Some(41)), Some(41));
    }

    #[test]
    fn exhausted_sequence_is_retried_after_the_backoff_deadline() {
        let now = Instant::now();
        let retry_at = now + Duration::from_secs(1);

        assert!(exhausted_clipboard_retry_pending(
            Some(41),
            Some(41),
            Some(retry_at),
            now,
        ));
        assert!(!exhausted_clipboard_retry_pending(
            Some(41),
            Some(41),
            Some(retry_at),
            retry_at,
        ));
        assert!(!exhausted_clipboard_retry_pending(
            Some(42),
            Some(41),
            Some(retry_at),
            now,
        ));
    }

    #[test]
    fn capture_signature_is_committed_only_after_an_event_is_delivered() {
        let previous = Some(7);

        assert_eq!(
            committed_capture_signature(previous, 8, false, true),
            previous
        );
        assert_eq!(
            committed_capture_signature(previous, 8, true, false),
            previous
        );
        assert_eq!(
            committed_capture_signature(previous, 8, true, true),
            Some(8)
        );
    }

    #[test]
    fn capture_health_distinguishes_starting_available_and_unavailable() {
        let health = CaptureHealth::default();
        assert_eq!(
            health.snapshot(),
            CaptureAvailabilityPayload {
                available: false,
                initialized: false
            }
        );
        health.finish(true);
        assert_eq!(
            health.snapshot(),
            CaptureAvailabilityPayload {
                available: true,
                initialized: true
            }
        );
        health.finish(false);
        assert_eq!(
            health.snapshot(),
            CaptureAvailabilityPayload {
                available: false,
                initialized: true
            }
        );
    }

    #[test]
    fn tray_capture_text_matches_restored_pause_state() {
        assert_eq!(capture_menu_text(true), "恢复记录");
        assert_eq!(capture_menu_text(false), "暂停记录");
    }

    #[test]
    fn startup_allows_screen_capture_before_user_settings_load() {
        assert!(!initial_screen_capture_protection());
    }

    #[test]
    fn bounded_worker_wait_returns_on_timeout() {
        let started = Instant::now();
        let result = run_with_timeout(Duration::from_millis(10), || {
            thread::sleep(Duration::from_millis(80));
            true
        });

        assert_eq!(result, None);
        assert!(started.elapsed() < Duration::from_millis(70));
    }

    #[test]
    fn pending_quit_is_consumed_by_the_fallback_once() {
        let requested = AtomicU64::new(0);
        assert!(mark_quit_requested(&requested, 1));
        assert!(!mark_quit_requested(&requested, 2));
        assert!(take_pending_quit(&requested, 1));
        assert!(!take_pending_quit(&requested, 1));
    }

    #[test]
    fn cancelled_quit_skips_fallback_and_can_be_requested_again() {
        let requested = AtomicU64::new(0);
        assert!(mark_quit_requested(&requested, 1));

        cancel_quit_request(&requested);

        assert!(!take_pending_quit(&requested, 1));
        assert!(mark_quit_requested(&requested, 2));
        assert!(!take_pending_quit(&requested, 1));
        assert!(take_pending_quit(&requested, 2));
    }
}
