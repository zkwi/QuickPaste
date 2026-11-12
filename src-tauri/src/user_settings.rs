use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

const SETTINGS_FILE: &str = "settings.json";
const MAX_SETTINGS_BYTES: u64 = 64 * 1024;
const READ_ERROR: &str = "无法读取便携设置";
const WRITE_ERROR: &str = "无法保存便携设置";

pub(crate) fn load(directory: &Path) -> Result<Option<Value>, String> {
    let file = match fs::File::open(directory.join(SETTINGS_FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(READ_ERROR.into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_ERROR.to_owned())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(READ_ERROR.into());
    }
    let settings: Value = serde_json::from_slice(&bytes).map_err(|_| READ_ERROR.to_owned())?;
    if !settings.is_object() {
        return Err(READ_ERROR.into());
    }
    Ok(Some(settings))
}

pub(crate) fn save(directory: &Path, settings: &Value) -> Result<(), String> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| WRITE_ERROR.to_owned())?;
    if !settings.is_object() || bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(WRITE_ERROR.into());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let index = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".settings-{}-{timestamp}-{index}.tmp",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| WRITE_ERROR.to_owned())?;
    let written = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = written.map_err(|_| WRITE_ERROR.to_owned()).and_then(|_| {
        crate::system_actions::atomic_replace_history_file(
            &temporary,
            &directory.join(SETTINGS_FILE),
        )
        .map_err(|_| WRITE_ERROR.to_owned())
    });
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn portable_settings_support_first_save_and_atomic_replacement() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "quickpaste-settings-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        assert_eq!(load(&directory).unwrap(), None);
        let first = json!({"theme":"dark","excludedApps":["示例应用"]});
        save(&directory, &first).unwrap();
        assert_eq!(load(&directory).unwrap(), Some(first));
        let second = json!({"theme":"light","singleClickPaste":true});
        save(&directory, &second).unwrap();
        assert!(save(
            &directory,
            &json!({"oversized":"x".repeat(MAX_SETTINGS_BYTES as usize)})
        )
        .is_err());
        assert_eq!(load(&directory).unwrap(), Some(second));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::write(directory.join(SETTINGS_FILE), b"not-json").unwrap();
        assert!(load(&directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
