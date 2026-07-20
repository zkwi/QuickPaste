use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};

pub(crate) const ACCEPTANCE_METRICS_FLAG: &str = "--acceptance-metrics";
pub(crate) const ACCEPTANCE_PROFILE_ENV: &str = "QUICKPASTE_ACCEPTANCE_PROFILE";
pub(crate) const ACCEPTANCE_TEMP_DIRECTORY: &str = "QuickPasteAcceptance";
pub(crate) const ACCEPTANCE_PROFILE_MARKER_FILE: &str = "acceptance-profile-v1.json";
pub(crate) const METRICS_RELATIVE_PATH: &str = "acceptance/metrics-v1.json";
pub(crate) const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const MAX_DURATION_SAMPLES: usize = 500;
pub(crate) const PENDING_SESSION_LIMIT: usize = 64;
pub(crate) const MAX_PASTE_TERMINAL_OPERATIONS: usize = 10_000;
pub(crate) const MAX_CAPTURE_TERMINAL_OPERATIONS: usize = 100_000;
pub(crate) const SESSION_TTL: Duration = Duration::from_secs(10);
static TEMP_FILE_NONCE: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

pub(crate) fn acceptance_metrics_enabled<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|argument| argument.as_ref() == OsStr::new(ACCEPTANCE_METRICS_FLAG))
}

pub(crate) fn nearest_rank_ms(samples: &[f64], percentile: u8) -> Option<f64> {
    if samples.is_empty()
        || !(1..=100).contains(&percentile)
        || samples
            .iter()
            .any(|sample| !sample.is_finite() || *sample < 0.0)
    {
        return None;
    }

    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = (usize::from(percentile) * sorted.len()).div_ceil(100);
    sorted.get(rank - 1).copied()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PasteTerminalOutcome {
    DirectSucceeded,
    DirectFailed,
    ClipboardWriteFailed,
    ClipboardUnverified,
    TargetMissing,
    TargetStale,
    ElevatedSucceeded,
    ElevatedFailed,
    ElevationDisabled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureTerminalOutcome {
    ExternalDelivered,
    ExternalFailed,
    InternalWrite,
    Duplicate,
    Paused,
    Excluded,
    Unsupported,
    RetryExhausted,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasteCounters {
    direct_succeeded: u64,
    direct_failed: u64,
    clipboard_write_failed: u64,
    clipboard_unverified: u64,
    target_missing: u64,
    target_stale: u64,
    elevated_succeeded: u64,
    elevated_failed: u64,
    elevation_disabled: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureCounters {
    stable_external: u64,
    event_delivered: u64,
    event_failed: u64,
    internal_write_consumed: u64,
    duplicate_suppressed: u64,
    paused: u64,
    excluded: u64,
    unsupported: u64,
    retry_exhausted: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsSnapshot {
    pub(crate) format_version: u8,
    pub(crate) updated_at: String,
    pub(crate) quick_panel_first_frame_ack_ms: Vec<f64>,
    pub(crate) paste_counters: PasteCounters,
    pub(crate) capture_counters: CaptureCounters,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FlushOutcome {
    Disabled,
    Clean,
    Written,
}

#[derive(Clone, Copy, Debug)]
struct PendingSession {
    session_id: u64,
    started_at: Instant,
}

#[derive(Debug)]
pub(crate) struct AcceptanceMetrics {
    output_path: Option<PathBuf>,
    duration_samples_ms: VecDeque<f64>,
    paste_counters: PasteCounters,
    capture_counters: CaptureCounters,
    pending_sessions: VecDeque<PendingSession>,
    latest_session_id: Option<u64>,
    closed_paste_operations: HashSet<u64>,
    closed_capture_operations: HashSet<u64>,
    dirty: bool,
}

impl Default for AcceptanceMetrics {
    fn default() -> Self {
        Self::disabled()
    }
}

impl AcceptanceMetrics {
    pub(crate) fn disabled() -> Self {
        Self {
            output_path: None,
            duration_samples_ms: VecDeque::new(),
            paste_counters: PasteCounters::default(),
            capture_counters: CaptureCounters::default(),
            pending_sessions: VecDeque::new(),
            latest_session_id: None,
            closed_paste_operations: HashSet::new(),
            closed_capture_operations: HashSet::new(),
            dirty: false,
        }
    }

    pub(crate) fn enabled(app_data_root: impl AsRef<Path>) -> Self {
        let mut metrics = Self::disabled();
        metrics.output_path = Some(app_data_root.as_ref().join(METRICS_RELATIVE_PATH));
        metrics.dirty = true;
        metrics
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.output_path.is_some()
    }

    pub(crate) fn has_pending_changes(&self) -> bool {
        self.is_enabled() && self.dirty
    }

    pub(crate) fn start_quick_panel_session(
        &mut self,
        session_id: u64,
        started_at: Instant,
    ) -> bool {
        if !self.is_enabled() || !valid_identifier(session_id) {
            return false;
        }

        self.prune_expired_sessions(started_at);
        if self
            .latest_session_id
            .is_some_and(|latest_session_id| session_id <= latest_session_id)
        {
            return false;
        }

        self.pending_sessions.push_back(PendingSession {
            session_id,
            started_at,
        });
        while self.pending_sessions.len() > PENDING_SESSION_LIMIT {
            self.pending_sessions.pop_front();
        }
        self.latest_session_id = Some(session_id);
        true
    }

    pub(crate) fn acknowledge_quick_panel_first_frame(
        &mut self,
        session_id: u64,
        acknowledged_at: Instant,
    ) -> bool {
        if !self.is_enabled() || !valid_identifier(session_id) {
            return false;
        }

        self.prune_expired_sessions(acknowledged_at);
        if self.latest_session_id != Some(session_id) {
            return false;
        }

        let Some(position) = self
            .pending_sessions
            .iter()
            .position(|session| session.session_id == session_id)
        else {
            return false;
        };
        let Some(session) = self.pending_sessions.remove(position) else {
            return false;
        };
        let Some(duration) = acknowledged_at.checked_duration_since(session.started_at) else {
            return false;
        };
        if duration >= SESSION_TTL {
            return false;
        }

        self.duration_samples_ms
            .push_back(duration.as_secs_f64() * 1_000.0);
        while self.duration_samples_ms.len() > MAX_DURATION_SAMPLES {
            self.duration_samples_ms.pop_front();
        }
        self.dirty = true;
        true
    }

    pub(crate) fn record_paste_terminal(
        &mut self,
        operation_id: u64,
        outcome: PasteTerminalOutcome,
    ) -> bool {
        if !self.is_enabled() || !valid_identifier(operation_id) {
            return false;
        }
        if self.closed_paste_operations.contains(&operation_id)
            || self.closed_paste_operations.len() >= MAX_PASTE_TERMINAL_OPERATIONS
        {
            return false;
        }
        self.closed_paste_operations.insert(operation_id);

        let counter = match outcome {
            PasteTerminalOutcome::DirectSucceeded => &mut self.paste_counters.direct_succeeded,
            PasteTerminalOutcome::DirectFailed => &mut self.paste_counters.direct_failed,
            PasteTerminalOutcome::ClipboardWriteFailed => {
                &mut self.paste_counters.clipboard_write_failed
            }
            PasteTerminalOutcome::ClipboardUnverified => {
                &mut self.paste_counters.clipboard_unverified
            }
            PasteTerminalOutcome::TargetMissing => &mut self.paste_counters.target_missing,
            PasteTerminalOutcome::TargetStale => &mut self.paste_counters.target_stale,
            PasteTerminalOutcome::ElevatedSucceeded => &mut self.paste_counters.elevated_succeeded,
            PasteTerminalOutcome::ElevatedFailed => &mut self.paste_counters.elevated_failed,
            PasteTerminalOutcome::ElevationDisabled => &mut self.paste_counters.elevation_disabled,
        };
        increment_counter(counter);
        self.dirty = true;
        true
    }

    pub(crate) fn record_capture_terminal(
        &mut self,
        operation_id: u64,
        outcome: CaptureTerminalOutcome,
    ) -> bool {
        if !self.is_enabled() || !valid_identifier(operation_id) {
            return false;
        }
        if self.closed_capture_operations.contains(&operation_id)
            || self.closed_capture_operations.len() >= MAX_CAPTURE_TERMINAL_OPERATIONS
        {
            return false;
        }
        self.closed_capture_operations.insert(operation_id);

        match outcome {
            CaptureTerminalOutcome::ExternalDelivered => {
                increment_counter(&mut self.capture_counters.stable_external);
                increment_counter(&mut self.capture_counters.event_delivered);
            }
            CaptureTerminalOutcome::ExternalFailed => {
                increment_counter(&mut self.capture_counters.stable_external);
                increment_counter(&mut self.capture_counters.event_failed);
            }
            CaptureTerminalOutcome::InternalWrite => {
                increment_counter(&mut self.capture_counters.internal_write_consumed);
            }
            CaptureTerminalOutcome::Duplicate => {
                increment_counter(&mut self.capture_counters.duplicate_suppressed);
            }
            CaptureTerminalOutcome::Paused => {
                increment_counter(&mut self.capture_counters.paused);
            }
            CaptureTerminalOutcome::Excluded => {
                increment_counter(&mut self.capture_counters.excluded);
            }
            CaptureTerminalOutcome::Unsupported => {
                increment_counter(&mut self.capture_counters.unsupported);
            }
            CaptureTerminalOutcome::RetryExhausted => {
                increment_counter(&mut self.capture_counters.retry_exhausted);
            }
        }
        self.dirty = true;
        true
    }

    pub(crate) fn snapshot_at(&self, now: SystemTime) -> MetricsSnapshot {
        let quick_panel_first_frame_ack_ms =
            self.duration_samples_ms.iter().copied().collect::<Vec<_>>();
        debug_assert!(
            quick_panel_first_frame_ack_ms.is_empty()
                || nearest_rank_ms(&quick_panel_first_frame_ack_ms, 95).is_some(),
            "retained metrics durations must remain valid nearest-rank inputs",
        );
        MetricsSnapshot {
            format_version: 1,
            updated_at: utc_timestamp(now),
            quick_panel_first_frame_ack_ms,
            paste_counters: self.paste_counters.clone(),
            capture_counters: self.capture_counters.clone(),
        }
    }

    pub(crate) fn flush(&mut self, now: SystemTime) -> io::Result<FlushOutcome> {
        self.flush_with_replacer(now, replace_file_atomically)
    }

    fn flush_with_replacer<F>(&mut self, now: SystemTime, replace: F) -> io::Result<FlushOutcome>
    where
        F: FnOnce(&Path, &Path) -> io::Result<()>,
    {
        let Some(output_path) = self.output_path.clone() else {
            return Ok(FlushOutcome::Disabled);
        };
        if !self.dirty {
            return Ok(FlushOutcome::Clean);
        }

        let bytes = serde_json::to_vec_pretty(&self.snapshot_at(now))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        atomic_write_with_replacer(&output_path, &bytes, replace)?;
        self.dirty = false;
        Ok(FlushOutcome::Written)
    }

    fn prune_expired_sessions(&mut self, now: Instant) {
        self.pending_sessions.retain(|session| {
            now.checked_duration_since(session.started_at)
                .is_none_or(|age| age < SESSION_TTL)
        });
    }

    #[cfg(test)]
    fn pending_session_count(&self) -> usize {
        self.pending_sessions.len()
    }

    #[cfg(test)]
    fn has_pending_session(&self, session_id: u64) -> bool {
        self.pending_sessions
            .iter()
            .any(|session| session.session_id == session_id)
    }

    #[cfg(test)]
    fn is_dirty(&self) -> bool {
        self.dirty
    }

    #[cfg(test)]
    fn closed_paste_operation_count(&self) -> usize {
        self.closed_paste_operations.len()
    }

    #[cfg(test)]
    fn closed_capture_operation_count(&self) -> usize {
        self.closed_capture_operations.len()
    }
}

fn valid_identifier(identifier: u64) -> bool {
    (1..=JS_MAX_SAFE_INTEGER).contains(&identifier)
}

fn increment_counter(counter: &mut u64) {
    *counter = counter.saturating_add(1).min(JS_MAX_SAFE_INTEGER);
}

fn utc_timestamp(now: SystemTime) -> String {
    DateTime::<Utc>::from(now).to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn resolve_acceptance_profile(
    acceptance_mode: bool,
    override_path: Option<&Path>,
    temp_directory: &Path,
) -> io::Result<Option<PathBuf>> {
    let Some(override_path) = override_path else {
        return if acceptance_mode {
            Err(invalid_profile(
                "--acceptance-metrics requires QUICKPASTE_ACCEPTANCE_PROFILE",
            ))
        } else {
            Ok(None)
        };
    };
    if !acceptance_mode {
        return Err(invalid_profile(
            "acceptance profile override requires --acceptance-metrics",
        ));
    }
    if !override_path.is_absolute() {
        return Err(invalid_profile("acceptance profile must be absolute"));
    }
    if override_path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(invalid_profile(
            "acceptance profile must not contain traversal components",
        ));
    }
    if !override_path.is_dir() {
        return Err(invalid_profile(
            "acceptance profile must be an existing directory",
        ));
    }
    #[cfg(windows)]
    reject_windows_reparse_point(
        override_path,
        "acceptance profile must not be a reparse point",
    )?;

    let acceptance_temp_root = temp_directory.join(ACCEPTANCE_TEMP_DIRECTORY);
    #[cfg(windows)]
    reject_windows_reparse_point(
        &acceptance_temp_root,
        "acceptance temp root must not be a reparse point",
    )?;
    let canonical_base = fs::canonicalize(acceptance_temp_root)?;
    if !canonical_base.is_dir() {
        return Err(invalid_profile(
            "acceptance temp root must be an existing directory",
        ));
    }
    let canonical_profile = fs::canonicalize(override_path)?;
    if !canonical_profile_parent_is_allowed(&canonical_profile, &canonical_base) {
        return Err(invalid_profile(
            "acceptance profile must be a direct child of the acceptance temp root",
        ));
    }

    Ok(Some(canonical_profile))
}

pub(crate) fn prepare_acceptance_profile(
    acceptance_mode: bool,
    override_path: Option<&Path>,
    temp_directory: &Path,
    now: SystemTime,
) -> io::Result<Option<PathBuf>> {
    let Some(profile_root) =
        resolve_acceptance_profile(acceptance_mode, override_path, temp_directory)?
    else {
        return Ok(None);
    };

    write_acceptance_profile_marker(&profile_root, now)?;
    Ok(Some(profile_root))
}

fn canonical_profile_parent_is_allowed(canonical_profile: &Path, canonical_base: &Path) -> bool {
    canonical_profile.parent() == Some(canonical_base)
}

#[cfg(windows)]
fn windows_profile_attributes_are_safe(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

#[cfg(windows)]
fn reject_windows_reparse_point(path: &Path, message: &'static str) -> io::Result<()> {
    if windows_profile_attributes_are_safe(fs::symlink_metadata(path)?.file_attributes()) {
        Ok(())
    } else {
        Err(invalid_profile(message))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptanceProfileMarker {
    format_version: u8,
    created_at: String,
}

fn write_acceptance_profile_marker(profile_root: &Path, now: SystemTime) -> io::Result<()> {
    let marker = AcceptanceProfileMarker {
        format_version: 1,
        created_at: utc_timestamp(now),
    };
    let bytes = serde_json::to_vec_pretty(&marker)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    atomic_write_with_replacer(
        &profile_root.join(ACCEPTANCE_PROFILE_MARKER_FILE),
        &bytes,
        replace_file_atomically,
    )
}

fn invalid_profile(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(windows)]
fn replace_file_atomically(source_path: &Path, destination_path: &Path) -> io::Result<()> {
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    ensure_same_parent(source_path, destination_path)?;
    let source_wide = nul_terminated_windows_path(source_path)?;
    let destination_wide = nul_terminated_windows_path(destination_path)?;
    // SAFETY: 两个 UTF-16 缓冲区均以 NUL 结尾，并在系统调用返回前保持有效。
    let succeeded = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn nul_terminated_windows_path(path: &Path) -> io::Result<Vec<u16>> {
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must not contain NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(not(windows))]
fn replace_file_atomically(source_path: &Path, destination_path: &Path) -> io::Result<()> {
    ensure_same_parent(source_path, destination_path)?;
    fs::rename(source_path, destination_path)
}

fn ensure_same_parent(source_path: &Path, destination_path: &Path) -> io::Result<()> {
    if source_path.parent() != destination_path.parent() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic replacement requires paths in the same directory",
        ));
    }
    Ok(())
}

fn atomic_write_with_replacer<F>(
    destination_path: &Path,
    bytes: &[u8],
    replace: F,
) -> io::Result<()>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let parent = destination_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "metrics destination must have a parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;

    let (temporary_path, mut temporary_file) = create_same_directory_temp(destination_path)?;
    let write_result = (|| {
        temporary_file.write_all(bytes)?;
        temporary_file.sync_all()?;
        Ok(())
    })();
    drop(temporary_file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    if let Err(error) = replace(&temporary_path, destination_path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(())
}

fn create_same_directory_temp(destination_path: &Path) -> io::Result<(PathBuf, File)> {
    let parent = destination_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "metrics destination must have a parent directory",
        )
    })?;
    let file_name = destination_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("metrics-v1.json");

    for _ in 0..128 {
        let nonce = TEMP_FILE_NONCE.fetch_add(1, Ordering::Relaxed);
        let temporary_path =
            parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nonce,));
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique metrics temp file",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant, UNIX_EPOCH};

    static TEST_DIRECTORY_NONCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = TEST_DIRECTORY_NONCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quickpaste-metrics-{label}-{}-{nonce}",
                std::process::id(),
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn object_keys(value: &Value) -> Vec<String> {
        let mut keys = value
            .as_object()
            .expect("expected JSON object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    fn enabled_metrics() -> AcceptanceMetrics {
        AcceptanceMetrics::enabled(PathBuf::from("test-profile"))
    }

    #[test]
    fn acceptance_mode_requires_the_exact_flag() {
        assert!(!acceptance_metrics_enabled(["quickpaste"]));
        assert!(acceptance_metrics_enabled([
            "quickpaste",
            "--acceptance-metrics",
        ]));
        assert!(!acceptance_metrics_enabled([
            "quickpaste",
            "--acceptance-metrics=true",
        ]));
        assert!(!acceptance_metrics_enabled([
            "quickpaste",
            "--ACCEPTANCE-METRICS",
        ]));
    }

    #[test]
    fn nearest_rank_handles_boundaries_and_unsorted_samples() {
        assert_eq!(nearest_rank_ms(&[], 95), None);
        assert_eq!(nearest_rank_ms(&[40.5, 10.5, 30.5, 20.5], 50), Some(20.5));
        assert_eq!(nearest_rank_ms(&[40.5, 10.5, 30.5, 20.5], 95), Some(40.5));
        assert_eq!(nearest_rank_ms(&[40.5, 10.5, 30.5, 20.5], 100), Some(40.5));
        assert_eq!(nearest_rank_ms(&[40.5, 10.5, 30.5, 20.5], 0), None);
        assert_eq!(nearest_rank_ms(&[40.5, 10.5, 30.5, 20.5], 101), None);
        assert_eq!(nearest_rank_ms(&[f64::NAN, 1.0], 95), None);

        let descending = (1..=500).rev().map(f64::from).collect::<Vec<_>>();
        assert_eq!(nearest_rank_ms(&descending, 95), Some(475.0));
    }

    #[test]
    fn snapshot_serializes_only_the_fixed_metrics_v1_schema() {
        let metrics = enabled_metrics();
        let value = serde_json::to_value(metrics.snapshot_at(UNIX_EPOCH)).unwrap();

        assert_eq!(
            object_keys(&value),
            [
                "captureCounters",
                "formatVersion",
                "pasteCounters",
                "quickPanelFirstFrameAckMs",
                "updatedAt",
            ]
        );
        assert_eq!(value["formatVersion"], 1);
        assert_eq!(value["updatedAt"], "1970-01-01T00:00:00.000Z");
        assert_eq!(value["quickPanelFirstFrameAckMs"], Value::Array(vec![]));
        assert_eq!(
            object_keys(&value["pasteCounters"]),
            [
                "clipboardUnverified",
                "clipboardWriteFailed",
                "directFailed",
                "directSucceeded",
                "elevatedFailed",
                "elevatedSucceeded",
                "elevationDisabled",
                "targetMissing",
                "targetStale",
            ]
        );
        assert_eq!(
            object_keys(&value["captureCounters"]),
            [
                "duplicateSuppressed",
                "eventDelivered",
                "eventFailed",
                "excluded",
                "internalWriteConsumed",
                "paused",
                "retryExhausted",
                "stableExternal",
                "unsupported",
            ]
        );

        let forbidden = [
            "content",
            "text",
            "html",
            "rtf",
            "image",
            "hash",
            "path",
            "sourceApp",
            "error",
            "clipboardSequence",
        ];
        let serialized = serde_json::to_string(&value).unwrap();
        assert!(forbidden.iter().all(|field| !serialized.contains(field)));
    }

    #[test]
    fn paste_terminal_outcomes_increment_once_per_operation() {
        let mut metrics = enabled_metrics();
        let outcomes = [
            PasteTerminalOutcome::DirectSucceeded,
            PasteTerminalOutcome::DirectFailed,
            PasteTerminalOutcome::ClipboardWriteFailed,
            PasteTerminalOutcome::ClipboardUnverified,
            PasteTerminalOutcome::TargetMissing,
            PasteTerminalOutcome::TargetStale,
            PasteTerminalOutcome::ElevatedSucceeded,
            PasteTerminalOutcome::ElevatedFailed,
            PasteTerminalOutcome::ElevationDisabled,
        ];

        for (index, outcome) in outcomes.into_iter().enumerate() {
            let operation_id = (index + 1) as u64;
            assert!(metrics.record_paste_terminal(operation_id, outcome));
            assert!(!metrics
                .record_paste_terminal(operation_id, PasteTerminalOutcome::DirectSucceeded,));
        }
        assert!(!metrics.record_paste_terminal(0, PasteTerminalOutcome::DirectSucceeded));

        let value = serde_json::to_value(metrics.snapshot_at(UNIX_EPOCH)).unwrap();
        assert!(value["pasteCounters"]
            .as_object()
            .unwrap()
            .values()
            .all(|counter| counter == 1));
    }

    #[test]
    fn capture_terminal_outcomes_increment_once_with_stable_event_pairing() {
        let mut metrics = enabled_metrics();
        let outcomes = [
            CaptureTerminalOutcome::ExternalDelivered,
            CaptureTerminalOutcome::ExternalFailed,
            CaptureTerminalOutcome::InternalWrite,
            CaptureTerminalOutcome::Duplicate,
            CaptureTerminalOutcome::Paused,
            CaptureTerminalOutcome::Excluded,
            CaptureTerminalOutcome::Unsupported,
            CaptureTerminalOutcome::RetryExhausted,
        ];

        for (index, outcome) in outcomes.into_iter().enumerate() {
            assert!(metrics.record_capture_terminal((index + 1) as u64, outcome));
        }
        assert!(!metrics.record_capture_terminal(8, CaptureTerminalOutcome::ExternalDelivered));
        assert!(!metrics.record_capture_terminal(0, CaptureTerminalOutcome::ExternalFailed));

        let value = serde_json::to_value(metrics.snapshot_at(UNIX_EPOCH)).unwrap();
        let counters = value["captureCounters"].as_object().unwrap();
        assert_eq!(counters["stableExternal"], 2);
        assert_eq!(counters["eventDelivered"], 1);
        assert_eq!(counters["eventFailed"], 1);
        for key in [
            "internalWriteConsumed",
            "duplicateSuppressed",
            "paused",
            "excluded",
            "unsupported",
            "retryExhausted",
        ] {
            assert_eq!(counters[key], 1, "counter {key}");
        }
    }

    #[test]
    fn counters_saturate_at_javascript_max_safe_integer() {
        let mut counter = JS_MAX_SAFE_INTEGER;
        increment_counter(&mut counter);
        assert_eq!(counter, JS_MAX_SAFE_INTEGER);
    }

    #[test]
    fn session_acknowledgement_is_strict_once_only_and_content_free() {
        let mut metrics = enabled_metrics();
        let started_at = Instant::now();

        assert!(metrics.start_quick_panel_session(7, started_at));
        assert!(!metrics
            .acknowledge_quick_panel_first_frame(8, started_at + Duration::from_millis(10),));
        assert!(metrics
            .acknowledge_quick_panel_first_frame(7, started_at + Duration::from_micros(25_500),));
        assert!(!metrics
            .acknowledge_quick_panel_first_frame(7, started_at + Duration::from_millis(30),));

        assert_eq!(
            metrics
                .snapshot_at(UNIX_EPOCH)
                .quick_panel_first_frame_ack_ms,
            vec![25.5],
        );
    }

    #[test]
    fn only_the_latest_unexpired_session_can_be_acknowledged() {
        let mut metrics = enabled_metrics();
        let started_at = Instant::now();

        assert!(metrics.start_quick_panel_session(10, started_at));
        assert!(metrics.start_quick_panel_session(11, started_at + Duration::from_millis(1),));
        assert!(!metrics
            .acknowledge_quick_panel_first_frame(10, started_at + Duration::from_millis(4),));
        assert!(
            metrics.acknowledge_quick_panel_first_frame(11, started_at + Duration::from_millis(6),)
        );

        assert_eq!(
            metrics
                .snapshot_at(UNIX_EPOCH)
                .quick_panel_first_frame_ack_ms,
            vec![5.0],
        );

        let mut expired = enabled_metrics();
        assert!(expired.start_quick_panel_session(12, started_at));
        assert!(!expired.acknowledge_quick_panel_first_frame(12, started_at + SESSION_TTL,));
        assert_eq!(expired.pending_session_count(), 0);
    }

    #[test]
    fn pending_sessions_and_duration_samples_are_bounded() {
        let mut metrics = enabled_metrics();
        let started_at = Instant::now();

        for session_id in 1..=(PENDING_SESSION_LIMIT as u64 + 1) {
            assert!(metrics.start_quick_panel_session(session_id, started_at));
        }
        assert_eq!(metrics.pending_session_count(), PENDING_SESSION_LIMIT);
        assert!(!metrics.has_pending_session(1));
        assert!(metrics.has_pending_session(2));

        let mut samples = enabled_metrics();
        for session_id in 1..=(MAX_DURATION_SAMPLES as u64 + 1) {
            let sample_start = started_at + Duration::from_secs(session_id);
            assert!(samples.start_quick_panel_session(session_id, sample_start));
            assert!(samples.acknowledge_quick_panel_first_frame(
                session_id,
                sample_start + Duration::from_millis(session_id),
            ));
        }
        let retained = samples
            .snapshot_at(UNIX_EPOCH)
            .quick_panel_first_frame_ack_ms;
        assert_eq!(retained.len(), MAX_DURATION_SAMPLES);
        assert_eq!(retained.first(), Some(&2.0));
        assert_eq!(retained.last(), Some(&(MAX_DURATION_SAMPLES as f64 + 1.0)));
    }

    #[test]
    fn duplicate_session_start_is_rejected_even_after_acknowledgement() {
        let mut metrics = enabled_metrics();
        let started_at = Instant::now();

        assert!(metrics.start_quick_panel_session(1, started_at));
        assert!(!metrics.start_quick_panel_session(1, started_at));
        assert!(
            metrics.acknowledge_quick_panel_first_frame(1, started_at + Duration::from_millis(1),)
        );
        assert!(!metrics.start_quick_panel_session(1, started_at + Duration::from_millis(2),));

        let mut nonmonotonic = enabled_metrics();
        assert!(nonmonotonic.start_quick_panel_session(2, started_at));
        assert!(!nonmonotonic.start_quick_panel_session(1, started_at + Duration::from_millis(1),));
        assert!(!nonmonotonic.start_quick_panel_session(
            JS_MAX_SAFE_INTEGER + 1,
            started_at + Duration::from_millis(1),
        ));
    }

    #[test]
    fn terminal_deduplication_memory_is_bounded_to_acceptance_run_sizes() {
        let mut metrics = enabled_metrics();
        for operation_id in 1..=MAX_PASTE_TERMINAL_OPERATIONS as u64 {
            assert!(
                metrics.record_paste_terminal(operation_id, PasteTerminalOutcome::DirectSucceeded,)
            );
        }
        assert!(!metrics.record_paste_terminal(
            MAX_PASTE_TERMINAL_OPERATIONS as u64 + 1,
            PasteTerminalOutcome::DirectFailed,
        ));
        assert_eq!(
            metrics.closed_paste_operation_count(),
            MAX_PASTE_TERMINAL_OPERATIONS,
        );

        for operation_id in 1..=MAX_CAPTURE_TERMINAL_OPERATIONS as u64 {
            assert!(metrics
                .record_capture_terminal(operation_id, CaptureTerminalOutcome::ExternalDelivered,));
        }
        assert!(!metrics.record_capture_terminal(
            MAX_CAPTURE_TERMINAL_OPERATIONS as u64 + 1,
            CaptureTerminalOutcome::ExternalFailed,
        ));
        assert_eq!(
            metrics.closed_capture_operation_count(),
            MAX_CAPTURE_TERMINAL_OPERATIONS,
        );
        assert!(!metrics.record_capture_terminal(
            JS_MAX_SAFE_INTEGER + 1,
            CaptureTerminalOutcome::ExternalFailed,
        ));
    }

    #[test]
    fn disabled_metrics_are_the_default_and_never_write() {
        let test_directory = TestDirectory::new("disabled");
        let mut metrics = AcceptanceMetrics::default();

        assert!(!metrics.is_enabled());
        assert!(!metrics.start_quick_panel_session(1, Instant::now()));
        assert!(!metrics.record_paste_terminal(1, PasteTerminalOutcome::DirectSucceeded));
        assert!(!metrics.record_capture_terminal(1, CaptureTerminalOutcome::ExternalDelivered,));
        assert_eq!(metrics.flush(UNIX_EPOCH).unwrap(), FlushOutcome::Disabled);
        assert_eq!(fs::read_dir(test_directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn enabled_metrics_merge_changes_and_write_only_on_explicit_flush() {
        let test_directory = TestDirectory::new("explicit-flush");
        let metrics_path = test_directory.path().join(METRICS_RELATIVE_PATH);
        let mut metrics = AcceptanceMetrics::enabled(test_directory.path());

        assert!(metrics.record_paste_terminal(1, PasteTerminalOutcome::DirectSucceeded));
        assert!(metrics.record_paste_terminal(2, PasteTerminalOutcome::DirectSucceeded));
        assert!(metrics.record_capture_terminal(1, CaptureTerminalOutcome::ExternalDelivered,));
        assert!(!metrics_path.exists());

        assert_eq!(metrics.flush(UNIX_EPOCH).unwrap(), FlushOutcome::Written);
        let first_bytes = fs::read(&metrics_path).unwrap();
        let first: Value = serde_json::from_slice(&first_bytes).unwrap();
        assert_eq!(first["pasteCounters"]["directSucceeded"], 2);
        assert_eq!(first["captureCounters"]["stableExternal"], 1);
        assert_eq!(first["captureCounters"]["eventDelivered"], 1);

        assert_eq!(
            metrics.flush(UNIX_EPOCH + Duration::from_secs(1)).unwrap(),
            FlushOutcome::Clean,
        );
        assert_eq!(fs::read(&metrics_path).unwrap(), first_bytes);

        assert!(metrics.record_capture_terminal(2, CaptureTerminalOutcome::ExternalFailed,));
        assert_eq!(
            metrics.flush(UNIX_EPOCH + Duration::from_secs(2)).unwrap(),
            FlushOutcome::Written,
        );
        let merged: Value = serde_json::from_slice(&fs::read(&metrics_path).unwrap()).unwrap();
        assert_eq!(merged["captureCounters"]["stableExternal"], 2);
        assert_eq!(merged["captureCounters"]["eventDelivered"], 1);
        assert_eq!(merged["captureCounters"]["eventFailed"], 1);
        assert_eq!(merged["updatedAt"], "1970-01-01T00:00:02.000Z");
    }

    #[test]
    fn replacement_failure_preserves_previous_snapshot_and_dirty_state() {
        let test_directory = TestDirectory::new("replace-failure");
        let metrics_path = test_directory.path().join(METRICS_RELATIVE_PATH);
        let mut metrics = AcceptanceMetrics::enabled(test_directory.path());
        assert!(metrics.record_paste_terminal(1, PasteTerminalOutcome::DirectSucceeded));
        assert_eq!(metrics.flush(UNIX_EPOCH).unwrap(), FlushOutcome::Written);
        let previous = fs::read(&metrics_path).unwrap();

        assert!(metrics.record_paste_terminal(2, PasteTerminalOutcome::DirectFailed));
        let result = metrics.flush_with_replacer(
            UNIX_EPOCH + Duration::from_secs(1),
            |temporary_path, destination_path| {
                assert_eq!(temporary_path.parent(), destination_path.parent());
                assert_eq!(destination_path, metrics_path);
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"))
            },
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&metrics_path).unwrap(), previous);
        assert!(metrics.is_dirty());
        let acceptance_directory = metrics_path.parent().unwrap();
        assert_eq!(fs::read_dir(acceptance_directory).unwrap().count(), 1);

        assert_eq!(
            metrics.flush(UNIX_EPOCH + Duration::from_secs(2)).unwrap(),
            FlushOutcome::Written,
        );
        let recovered: Value = serde_json::from_slice(&fs::read(metrics_path).unwrap()).unwrap();
        assert_eq!(recovered["pasteCounters"]["directSucceeded"], 1);
        assert_eq!(recovered["pasteCounters"]["directFailed"], 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_destination_failure_preserves_snapshot_for_retry() {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;

        let test_directory = TestDirectory::new("locked-replace");
        let metrics_path = test_directory.path().join(METRICS_RELATIVE_PATH);
        let mut metrics = AcceptanceMetrics::enabled(test_directory.path());
        assert_eq!(metrics.flush(UNIX_EPOCH).unwrap(), FlushOutcome::Written);
        let previous = fs::read(&metrics_path).unwrap();
        assert!(metrics.record_paste_terminal(1, PasteTerminalOutcome::DirectSucceeded));

        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&metrics_path)
            .unwrap();
        assert!(metrics.flush(UNIX_EPOCH + Duration::from_secs(1)).is_err());
        assert_eq!(fs::read(&metrics_path).unwrap(), previous);
        assert!(metrics.is_dirty());

        drop(locked);
        assert_eq!(
            metrics.flush(UNIX_EPOCH + Duration::from_secs(2)).unwrap(),
            FlushOutcome::Written,
        );
        let recovered: Value = serde_json::from_slice(&fs::read(metrics_path).unwrap()).unwrap();
        assert_eq!(recovered["pasteCounters"]["directSucceeded"], 1);
    }

    #[test]
    fn atomic_replace_overwrites_an_existing_destination() {
        let test_directory = TestDirectory::new("native-replace");
        let temporary_path = test_directory.path().join("metrics.tmp");
        let destination_path = test_directory.path().join("metrics.json");
        fs::write(&temporary_path, b"new snapshot").unwrap();
        fs::write(&destination_path, b"previous snapshot").unwrap();

        replace_file_atomically(&temporary_path, &destination_path).unwrap();

        assert_eq!(fs::read(&destination_path).unwrap(), b"new snapshot");
        assert!(!temporary_path.exists());
    }

    #[test]
    fn acceptance_profile_mode_matrix_fails_closed_before_app_setup() {
        let test_directory = TestDirectory::new("profile-mode");
        let base = test_directory.path().join(ACCEPTANCE_TEMP_DIRECTORY);
        let profile = base.join("run-1");
        fs::create_dir_all(&profile).unwrap();

        assert_eq!(
            resolve_acceptance_profile(false, None, test_directory.path()).unwrap(),
            None,
        );
        assert!(resolve_acceptance_profile(true, None, test_directory.path()).is_err());
        assert!(
            resolve_acceptance_profile(false, Some(profile.as_path()), test_directory.path(),)
                .is_err()
        );
        assert_eq!(
            resolve_acceptance_profile(true, Some(profile.as_path()), test_directory.path(),)
                .unwrap(),
            Some(fs::canonicalize(profile).unwrap()),
        );
    }

    #[test]
    fn profile_override_rejects_every_path_outside_a_direct_canonical_child() {
        let test_directory = TestDirectory::new("profile-boundary");
        let base = test_directory.path().join(ACCEPTANCE_TEMP_DIRECTORY);
        let run = base.join("run");
        let other_run = base.join("other-run");
        let nested = run.join("nested");
        let outside = test_directory.path().join("outside");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&other_run).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(base.join("not-a-directory"), b"x").unwrap();

        for rejected in [
            base.clone(),
            nested,
            outside.clone(),
            base.join("missing"),
            base.join("not-a-directory"),
            run.join("..").join("other-run"),
            PathBuf::from("relative-profile"),
        ] {
            assert!(
                resolve_acceptance_profile(true, Some(&rejected), test_directory.path()).is_err(),
                "accepted unsafe profile: {}",
                rejected.display(),
            );
        }

        let canonical_base = fs::canonicalize(&base).unwrap();
        let canonical_outside = fs::canonicalize(&outside).unwrap();
        assert!(!canonical_profile_parent_is_allowed(
            &canonical_outside,
            &canonical_base,
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_profile_attribute_guard_rejects_every_reparse_point() {
        assert!(windows_profile_attributes_are_safe(0));
        assert!(!windows_profile_attributes_are_safe(
            FILE_ATTRIBUTE_REPARSE_POINT,
        ));
    }

    #[cfg(windows)]
    #[test]
    fn profile_override_rejects_a_symlink_or_junction_escape_when_supported() {
        use std::os::windows::fs::symlink_dir;

        let test_directory = TestDirectory::new("profile-link-escape");
        let base = test_directory.path().join(ACCEPTANCE_TEMP_DIRECTORY);
        let inside = base.join("real-run");
        let linked_inside = base.join("linked-inside-run");
        let outside = test_directory.path().join("outside");
        let linked_profile = base.join("linked-run");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();

        if symlink_dir(&inside, &linked_inside).is_ok() {
            assert!(resolve_acceptance_profile(
                true,
                Some(linked_inside.as_path()),
                test_directory.path(),
            )
            .is_err());
        }
        if symlink_dir(&outside, &linked_profile).is_ok() {
            assert!(resolve_acceptance_profile(
                true,
                Some(linked_profile.as_path()),
                test_directory.path(),
            )
            .is_err());
        }

        let redirected_temp = test_directory.path().join("redirected-temp");
        let redirected_base = redirected_temp.join(ACCEPTANCE_TEMP_DIRECTORY);
        let redirected_run = redirected_base.join("run");
        let outside_base = test_directory.path().join("outside-base");
        let outside_run = outside_base.join("run");
        fs::create_dir_all(&redirected_temp).unwrap();
        fs::create_dir_all(&outside_run).unwrap();
        if symlink_dir(&outside_base, &redirected_base).is_ok() {
            assert!(resolve_acceptance_profile(
                true,
                Some(redirected_run.as_path()),
                redirected_temp.as_path(),
            )
            .is_err());
        }
    }

    #[test]
    fn prepared_acceptance_profile_has_an_exact_atomic_marker_before_return() {
        let test_directory = TestDirectory::new("profile-marker");
        let profile = test_directory
            .path()
            .join(ACCEPTANCE_TEMP_DIRECTORY)
            .join("run-marker");
        fs::create_dir_all(&profile).unwrap();

        let prepared = prepare_acceptance_profile(
            true,
            Some(profile.as_path()),
            test_directory.path(),
            UNIX_EPOCH + Duration::from_millis(123),
        )
        .unwrap()
        .unwrap();
        let marker_path = prepared.join(ACCEPTANCE_PROFILE_MARKER_FILE);
        assert!(marker_path.is_file());

        let marker: Value = serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        assert_eq!(object_keys(&marker), ["createdAt", "formatVersion"]);
        assert_eq!(marker["formatVersion"], 1);
        assert_eq!(marker["createdAt"], "1970-01-01T00:00:00.123Z");
        assert_eq!(fs::read_dir(&prepared).unwrap().count(), 1);
    }

    #[test]
    fn profile_marker_is_never_created_for_normal_mode_or_invalid_override() {
        let test_directory = TestDirectory::new("profile-marker-reject");
        let profile = test_directory
            .path()
            .join(ACCEPTANCE_TEMP_DIRECTORY)
            .join("run-marker");
        fs::create_dir_all(&profile).unwrap();

        assert_eq!(
            prepare_acceptance_profile(false, None, test_directory.path(), UNIX_EPOCH).unwrap(),
            None,
        );
        assert!(prepare_acceptance_profile(true, None, test_directory.path(), UNIX_EPOCH).is_err());
        assert!(prepare_acceptance_profile(
            false,
            Some(profile.as_path()),
            test_directory.path(),
            UNIX_EPOCH,
        )
        .is_err());
        assert!(!profile.join(ACCEPTANCE_PROFILE_MARKER_FILE).exists());
    }
}
