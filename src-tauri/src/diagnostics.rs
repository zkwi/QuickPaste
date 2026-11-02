use std::{
    cell::Cell,
    time::{Duration, Instant},
};

thread_local! {
    static CLIPBOARD_FAILURE: Cell<&'static str> = const { Cell::new("unknown") };
}

pub(crate) fn clipboard_failure(reason: &'static str) {
    CLIPBOARD_FAILURE.set(reason);
}

pub(crate) fn last_clipboard_failure() -> &'static str {
    CLIPBOARD_FAILURE.get()
}

// 重试保持原有频率；只限制日志，避免同一故障挤掉其他诊断。
#[derive(Default)]
pub(crate) struct WarningThrottle(Option<Instant>);

impl WarningThrottle {
    pub(crate) fn should_log(&mut self, now: Instant) -> bool {
        if self
            .0
            .is_some_and(|last| now.duration_since(last) < Duration::from_secs(60))
        {
            return false;
        }
        self.0 = Some(now);
        true
    }
}

pub(crate) fn install() {
    // panic 文本可能包含剪贴板正文，仅记录位置和调用栈，不记录 payload。
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()));
        log::error!(
            "Rust panic: location={location:?}; backtrace={}",
            std::backtrace::Backtrace::force_capture()
        );
    }));
    log::info!(
        "QuickPaste startup: version={}; pid={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_failures_are_logged_at_most_once_a_minute() {
        let now = Instant::now();
        let mut throttle = WarningThrottle::default();
        assert!(throttle.should_log(now));
        assert!(!throttle.should_log(now + Duration::from_millis(800)));
        assert!(!throttle.should_log(now + Duration::from_secs(59)));
        assert!(throttle.should_log(now + Duration::from_secs(60)));
    }

    #[test]
    fn failure_reasons_are_thread_local_and_content_free() {
        clipboard_failure("sequence-changed");
        assert_eq!(last_clipboard_failure(), "sequence-changed");
        assert_eq!(
            std::thread::spawn(last_clipboard_failure).join().unwrap(),
            "unknown"
        );
    }
}
