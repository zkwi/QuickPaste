use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{ImageFormat, ImageReader};
use serde::Serialize;

const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_WINDOWS_PATH_UTF16: usize = 32_000;
const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";
const MAX_PNG_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_DECODE_ALLOC_BYTES: u64 = 256 * 1024 * 1024;
static TEMPORARY_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SaveImageStatus {
    Saved,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveImageResult {
    status: SaveImageStatus,
}

impl SaveImageResult {
    fn saved() -> Self {
        Self {
            status: SaveImageStatus::Saved,
        }
    }

    fn cancelled() -> Self {
        Self {
            status: SaveImageStatus::Cancelled,
        }
    }
}

trait SystemActionAdapter {
    fn canonicalize_existing(&self, path: &Path) -> Result<PathBuf, String>;
    fn open_url(&self, url: &str) -> Result<(), String>;
    fn open_path(&self, path: &Path) -> Result<(), String>;
    fn reveal_path(&self, path: &Path) -> Result<(), String>;
    fn choose_png_destination(&self) -> Result<Option<PathBuf>, String>;
    fn replace_file(&self, temporary: &Path, destination: &Path) -> Result<(), String>;
}

fn validate_external_url(value: &str) -> Result<url::Url, String> {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err("链接无效".to_owned());
    }
    let (scheme, authority) = value
        .split_once("://")
        .ok_or_else(|| "仅支持 HTTP 或 HTTPS 链接".to_owned())?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("仅支持 HTTP 或 HTTPS 链接".to_owned());
    }
    if authority.is_empty() || authority.starts_with('/') {
        return Err("链接缺少主机名".to_owned());
    }

    let parsed = url::Url::parse(value).map_err(|_| "链接无效".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("仅支持带主机名的 HTTP 或 HTTPS 链接".to_owned());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("链接不能包含账户凭据".to_owned());
    }
    Ok(parsed)
}

fn validate_windows_path_syntax(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.encode_utf16().count() > MAX_WINDOWS_PATH_UTF16
        || value.contains('\0')
        || value.contains('/')
    {
        return Err("文件路径无效".to_owned());
    }
    if value.starts_with(r"\\?\") || value.starts_with(r"\\.\") {
        return Err("不支持设备或逐字路径".to_owned());
    }

    let (components, unc_root_components): (Vec<&str>, usize) =
        if let Some(unc_path) = value.strip_prefix(r"\\") {
            let components = unc_path.split('\\').collect::<Vec<_>>();
            if components.len() < 2
                || components[0].is_empty()
                || components[1].is_empty()
                || components.iter().any(|component| component.is_empty())
            {
                return Err("UNC 路径必须包含服务器和共享名".to_owned());
            }
            (components, 2)
        } else {
            let bytes = value.as_bytes();
            if bytes.len() < 3
                || !bytes[0].is_ascii_alphabetic()
                || bytes[1] != b':'
                || bytes[2] != b'\\'
            {
                return Err("路径必须是盘符绝对路径或 UNC 路径".to_owned());
            }
            let remainder = &value[3..];
            let components = if remainder.is_empty() {
                Vec::new()
            } else {
                let components = remainder.split('\\').collect::<Vec<_>>();
                if components.iter().any(|component| component.is_empty()) {
                    return Err("文件路径包含多余的分隔符".to_owned());
                }
                components
            };
            (components, 0)
        };

    for (index, component) in components.into_iter().enumerate() {
        let base_name = component
            .split_once('.')
            .map_or(component, |(base_name, _)| base_name)
            .to_ascii_uppercase();
        let reserved_device_name = index >= unc_root_components
            && (matches!(base_name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || base_name
                    .strip_prefix("COM")
                    .or_else(|| base_name.strip_prefix("LPT"))
                    .is_some_and(|suffix| {
                        matches!(
                            suffix,
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    }));
        if matches!(component, "." | "..")
            || component.ends_with(['.', ' '])
            || reserved_device_name
            || component
                .chars()
                .any(|character| character.is_control() || r#"<>:"|?*"#.contains(character))
        {
            return Err("文件路径包含不安全的路径段".to_owned());
        }
    }
    Ok(())
}

fn normalize_canonical_windows_path(path: &Path) -> Result<PathBuf, String> {
    let value = path
        .to_str()
        .ok_or_else(|| "文件路径不是有效 Unicode".to_owned())?;
    let normalized = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) != Some(&b':') {
            return Err("规范化路径落入设备命名空间".to_owned());
        }
        rest.to_owned()
    } else {
        value.to_owned()
    };
    validate_windows_path_syntax(&normalized)?;
    Ok(PathBuf::from(normalized))
}

fn resolve_existing_windows_path(
    value: &str,
    canonicalize: impl FnOnce(&Path) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    validate_windows_path_syntax(value)?;
    let canonical = canonicalize(Path::new(value))?;
    normalize_canonical_windows_path(&canonical)
}

fn decode_png_data_url(value: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let encoded = value
        .strip_prefix(PNG_DATA_URL_PREFIX)
        .ok_or_else(|| "图片必须是 PNG data URL".to_owned())?;
    let max_encoded_bytes = max_bytes
        .checked_add(2)
        .and_then(|length| length.checked_div(3))
        .and_then(|length| length.checked_mul(4))
        .ok_or_else(|| "图片大小上限无效".to_owned())?;
    if encoded.is_empty() || encoded.len() > max_encoded_bytes {
        return Err("PNG 图片超过 64 MiB 限制".to_owned());
    }
    let png = STANDARD
        .decode(encoded)
        .map_err(|_| "PNG data URL 的 Base64 无效".to_owned())?;
    if png.is_empty() || png.len() > max_bytes {
        return Err("PNG 图片超过 64 MiB 限制".to_owned());
    }

    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_DECODE_ALLOC_BYTES);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "图片不是有效的 PNG".to_owned())?;
    let mut normalized = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut normalized), ImageFormat::Png)
        .map_err(|_| "无法规范化 PNG 图片".to_owned())?;
    if normalized.len() > max_bytes {
        return Err("规范化后的 PNG 图片超过 64 MiB 限制".to_owned());
    }
    Ok(normalized)
}

fn open_external_link_with(
    adapter: &impl SystemActionAdapter,
    value: &str,
) -> Result<bool, String> {
    let url = validate_external_url(value)?;
    adapter.open_url(url.as_str())?;
    Ok(true)
}

fn resolve_adapter_path(
    adapter: &impl SystemActionAdapter,
    value: &str,
) -> Result<PathBuf, String> {
    resolve_existing_windows_path(value, |path| adapter.canonicalize_existing(path))
}

fn open_file_path_with(adapter: &impl SystemActionAdapter, value: &str) -> Result<bool, String> {
    let path = resolve_adapter_path(adapter, value)?;
    adapter.open_path(&path)?;
    Ok(true)
}

fn reveal_file_path_with(adapter: &impl SystemActionAdapter, value: &str) -> Result<bool, String> {
    let path = resolve_adapter_path(adapter, value)?;
    adapter.reveal_path(&path)?;
    Ok(true)
}

fn create_temporary_sibling(destination: &Path) -> Result<(PathBuf, fs::File), String> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "保存路径缺少父目录".to_owned())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "保存文件名无效".to_owned())?;

    for _ in 0..32 {
        let counter = TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".{file_name}.quickpaste-{}-{counter}.tmp",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建临时图片文件".to_owned()),
        }
    }
    Err("无法分配唯一临时图片文件".to_owned())
}

fn write_png_atomically_with(
    adapter: &impl SystemActionAdapter,
    destination: &Path,
    png: &[u8],
) -> Result<(), String> {
    let (temporary, mut file) = create_temporary_sibling(destination)?;
    let write_result = file
        .write_all(png)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|_| "无法完整写入临时图片文件".to_owned());
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    if let Err(error) = adapter.replace_file(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    Ok(())
}

fn save_clipboard_image_with(
    adapter: &impl SystemActionAdapter,
    image_data_url: &str,
) -> Result<SaveImageResult, String> {
    let png = decode_png_data_url(image_data_url, MAX_PNG_BYTES)?;
    let Some(destination) = adapter.choose_png_destination()? else {
        return Ok(SaveImageResult::cancelled());
    };
    let destination_value = destination
        .to_str()
        .ok_or_else(|| "保存路径不是有效 Unicode".to_owned())?;
    validate_windows_path_syntax(destination_value)?;
    if !destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        || destination.is_dir()
    {
        return Err("保存路径必须是 PNG 文件".to_owned());
    }
    write_png_atomically_with(adapter, &destination, &png)?;
    Ok(SaveImageResult::saved())
}

struct NativeSystemActions;

impl SystemActionAdapter for NativeSystemActions {
    fn canonicalize_existing(&self, path: &Path) -> Result<PathBuf, String> {
        fs::canonicalize(path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "文件或目录不存在".to_owned(),
            std::io::ErrorKind::PermissionDenied => "没有权限访问文件或目录".to_owned(),
            _ => "无法验证文件或目录".to_owned(),
        })
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        native_open_url(url)
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        native_open_path(path)
    }

    fn reveal_path(&self, path: &Path) -> Result<(), String> {
        native_reveal_path(path)
    }

    fn choose_png_destination(&self) -> Result<Option<PathBuf>, String> {
        native_choose_png_destination()
    }

    fn replace_file(&self, temporary: &Path, destination: &Path) -> Result<(), String> {
        native_replace_file(temporary, destination)
    }
}

#[tauri::command]
pub(crate) async fn open_external_link(url: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_external_link_with(&NativeSystemActions, &url)
    })
    .await
    .map_err(|_| "打开链接的后台任务异常退出".to_owned())?
}

#[tauri::command]
pub(crate) async fn open_file_path(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || open_file_path_with(&NativeSystemActions, &path))
        .await
        .map_err(|_| "打开文件的后台任务异常退出".to_owned())?
}

#[tauri::command]
pub(crate) async fn reveal_file_path(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || reveal_file_path_with(&NativeSystemActions, &path))
        .await
        .map_err(|_| "定位文件的后台任务异常退出".to_owned())?
}

#[tauri::command]
pub(crate) async fn save_clipboard_image(
    image_data_url: String,
) -> Result<SaveImageResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_clipboard_image_with(&NativeSystemActions, &image_data_url)
    })
    .await
    .map_err(|_| "保存图片的后台任务异常退出".to_owned())?
}

#[cfg(target_os = "windows")]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn shell_execute_in_current_sta(value: &std::ffi::OsStr) -> Result<(), String> {
    use windows::{
        core::{w, PCWSTR},
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };

    let value = wide(value);
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(value.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        Err("Windows 无法打开所选目标".to_owned())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn native_open_url(url: &str) -> Result<(), String> {
    let url = std::ffi::OsString::from(url);
    run_in_sta_thread("打开链接的系统线程异常退出", move || {
        shell_execute_in_current_sta(&url)
    })
}

#[cfg(not(target_os = "windows"))]
fn native_open_url(_url: &str) -> Result<(), String> {
    Err("当前平台不支持打开链接".to_owned())
}

#[cfg(target_os = "windows")]
fn native_open_path(path: &Path) -> Result<(), String> {
    let path = path.to_path_buf();
    run_in_sta_thread("打开文件的系统线程异常退出", move || {
        shell_execute_in_current_sta(path.as_os_str())
    })
}

#[cfg(not(target_os = "windows"))]
fn native_open_path(_path: &Path) -> Result<(), String> {
    Err("当前平台不支持打开文件".to_owned())
}

#[cfg(target_os = "windows")]
struct ComUninitializeGuard;

#[cfg(target_os = "windows")]
impl Drop for ComUninitializeGuard {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
fn initialize_sta() -> Result<ComUninitializeGuard, String> {
    use windows::Win32::System::Com::{
        CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };

    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
        .ok()
        .map_err(|_| "无法初始化 Windows COM 公寓".to_owned())?;
    Ok(ComUninitializeGuard)
}

#[cfg(target_os = "windows")]
fn run_in_sta_thread<T, F>(panic_message: &'static str, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    std::thread::spawn(move || {
        let _com = initialize_sta()?;
        operation()
    })
    .join()
    .map_err(|_| panic_message.to_owned())?
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryDialogKind {
    Backup,
    Restore,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct HistoryDialogSpec {
    default_file_name: Option<&'static str>,
    default_extension: &'static str,
    filter_name: &'static str,
    filter_pattern: &'static str,
    options: windows::Win32::UI::Shell::FILEOPENDIALOGOPTIONS,
}

#[cfg(target_os = "windows")]
fn history_dialog_spec(kind: HistoryDialogKind) -> HistoryDialogSpec {
    use windows::Win32::UI::Shell::{
        FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_OVERWRITEPROMPT,
        FOS_PATHMUSTEXIST, FOS_STRICTFILETYPES,
    };

    match kind {
        HistoryDialogKind::Backup => HistoryDialogSpec {
            default_file_name: Some("QuickPaste-backup.sqlite3"),
            default_extension: "sqlite3",
            filter_name: "SQLite 数据库备份 (*.sqlite3)",
            filter_pattern: "*.sqlite3",
            options: FOS_FORCEFILESYSTEM
                | FOS_PATHMUSTEXIST
                | FOS_OVERWRITEPROMPT
                | FOS_NOCHANGEDIR
                | FOS_STRICTFILETYPES,
        },
        HistoryDialogKind::Restore => HistoryDialogSpec {
            default_file_name: None,
            default_extension: "sqlite3",
            filter_name: "SQLite 数据库备份 (*.sqlite3)",
            filter_pattern: "*.sqlite3",
            options: FOS_FORCEFILESYSTEM
                | FOS_FILEMUSTEXIST
                | FOS_PATHMUSTEXIST
                | FOS_NOCHANGEDIR
                | FOS_STRICTFILETYPES,
        },
    }
}

#[cfg(target_os = "windows")]
fn history_dialog_result_path(
    item: &windows::Win32::UI::Shell::IShellItem,
) -> Result<PathBuf, String> {
    use windows::{
        core::PCWSTR,
        Win32::{System::Com::CoTaskMemFree, UI::Shell::SIGDN_FILESYSPATH},
    };

    let display_name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
        .map_err(|_| "无法读取 Windows 文件对话框结果".to_owned())?;
    let path = unsafe { PCWSTR(display_name.as_ptr()).to_string() }
        .map(PathBuf::from)
        .map_err(|_| "Windows 文件对话框返回了无效 Unicode".to_owned());
    unsafe { CoTaskMemFree(Some(display_name.as_ptr().cast())) };
    path
}

#[cfg(target_os = "windows")]
fn reveal_path_in_current_sta(path: &Path) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::UI::Shell::{ILCreateFromPathW, ILFindLastID, ILFree, SHOpenFolderAndSelectItems},
    };

    let Some(parent) = path.parent().filter(|parent| parent != &path) else {
        return shell_execute_in_current_sta(path.as_os_str());
    };
    let parent_wide = wide(parent.as_os_str());
    let path_wide = wide(path.as_os_str());
    let parent_id = unsafe { ILCreateFromPathW(PCWSTR(parent_wide.as_ptr())) };
    if parent_id.is_null() {
        return Err("无法解析文件所在目录".to_owned());
    }
    let item_id = unsafe { ILCreateFromPathW(PCWSTR(path_wide.as_ptr())) };
    if item_id.is_null() {
        unsafe { ILFree(Some(parent_id)) };
        return Err("无法解析要定位的文件".to_owned());
    }
    let child_id = unsafe { ILFindLastID(item_id) } as *const _;
    let result = unsafe { SHOpenFolderAndSelectItems(parent_id, Some(&[child_id]), 0) };
    unsafe {
        ILFree(Some(item_id));
        ILFree(Some(parent_id));
    }
    result.map_err(|_| "Windows 资源管理器无法定位所选文件".to_owned())
}

#[cfg(target_os = "windows")]
fn native_reveal_path(path: &Path) -> Result<(), String> {
    let path = path.to_path_buf();
    run_in_sta_thread("定位文件的系统线程异常退出", move || {
        reveal_path_in_current_sta(&path)
    })
}

#[cfg(not(target_os = "windows"))]
fn native_reveal_path(_path: &Path) -> Result<(), String> {
    Err("当前平台不支持定位文件".to_owned())
}

#[cfg(target_os = "windows")]
fn choose_png_destination_in_current_sta() -> Result<Option<PathBuf>, String> {
    use windows::{
        core::{w, HRESULT, PCWSTR},
        Win32::{
            Foundation::ERROR_CANCELLED,
            System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER},
            UI::Shell::{
                Common::COMDLG_FILTERSPEC, FileSaveDialog, IFileSaveDialog, FOS_FORCEFILESYSTEM,
                FOS_NOCHANGEDIR, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, FOS_STRICTFILETYPES,
                SIGDN_FILESYSPATH,
            },
        },
    };

    let dialog: IFileSaveDialog = unsafe {
        CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "无法创建 Windows 保存对话框".to_owned())?
    };
    let options =
        unsafe { dialog.GetOptions() }.map_err(|_| "无法读取保存对话框选项".to_owned())?;
    unsafe {
        dialog
            .SetOptions(
                options
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_OVERWRITEPROMPT
                    | FOS_NOCHANGEDIR
                    | FOS_STRICTFILETYPES,
            )
            .and_then(|()| dialog.SetDefaultExtension(w!("png")))
            .and_then(|()| dialog.SetFileName(w!("QuickPaste.png")))
            .and_then(|()| {
                dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                    pszName: w!("PNG 图片 (*.png)"),
                    pszSpec: w!("*.png"),
                }])
            })
            .map_err(|_| "无法配置 Windows 保存对话框".to_owned())?;
    }
    match unsafe { dialog.Show(None) } {
        Ok(()) => {}
        Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => return Ok(None),
        Err(_) => return Err("Windows 保存对话框失败".to_owned()),
    }

    let item = unsafe { dialog.GetResult() }.map_err(|_| "无法读取 Windows 保存路径".to_owned())?;
    let display_name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
        .map_err(|_| "无法读取 Windows 保存路径".to_owned())?;
    let path = unsafe { PCWSTR(display_name.as_ptr()).to_string() }
        .map(PathBuf::from)
        .map_err(|_| "Windows 保存路径不是有效 Unicode".to_owned());
    unsafe { CoTaskMemFree(Some(display_name.as_ptr().cast())) };
    path.map(Some)
}

#[cfg(target_os = "windows")]
fn native_choose_png_destination() -> Result<Option<PathBuf>, String> {
    run_in_sta_thread(
        "保存对话框线程异常退出",
        choose_png_destination_in_current_sta,
    )
}

#[cfg(not(target_os = "windows"))]
fn native_choose_png_destination() -> Result<Option<PathBuf>, String> {
    Err("当前平台不支持保存图片".to_owned())
}

#[cfg(target_os = "windows")]
fn choose_history_backup_destination_in_current_sta() -> Result<Option<PathBuf>, String> {
    use std::ffi::OsStr;
    use windows::{
        core::{HRESULT, PCWSTR},
        Win32::{
            Foundation::ERROR_CANCELLED,
            System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            UI::Shell::{Common::COMDLG_FILTERSPEC, FileSaveDialog, IFileSaveDialog},
        },
    };

    let spec = history_dialog_spec(HistoryDialogKind::Backup);
    let dialog: IFileSaveDialog = unsafe {
        CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "无法创建 Windows 历史备份保存对话框".to_owned())?
    };
    let options =
        unsafe { dialog.GetOptions() }.map_err(|_| "无法读取历史备份对话框选项".to_owned())?;
    let extension = wide(OsStr::new(spec.default_extension));
    let default_file_name = spec
        .default_file_name
        .ok_or_else(|| "历史备份保存对话框缺少默认文件名".to_owned())?;
    let file_name = wide(OsStr::new(default_file_name));
    let filter_name = wide(OsStr::new(spec.filter_name));
    let filter_pattern = wide(OsStr::new(spec.filter_pattern));
    let filters = [COMDLG_FILTERSPEC {
        pszName: PCWSTR(filter_name.as_ptr()),
        pszSpec: PCWSTR(filter_pattern.as_ptr()),
    }];
    unsafe {
        dialog
            .SetOptions(options | spec.options)
            .and_then(|()| dialog.SetDefaultExtension(PCWSTR(extension.as_ptr())))
            .and_then(|()| dialog.SetFileName(PCWSTR(file_name.as_ptr())))
            .and_then(|()| dialog.SetFileTypes(&filters))
            .map_err(|_| "无法配置 Windows 历史备份保存对话框".to_owned())?;
    }
    match unsafe { dialog.Show(None) } {
        Ok(()) => {}
        Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => return Ok(None),
        Err(_) => return Err("Windows 历史备份保存对话框失败".to_owned()),
    }

    let item = unsafe { dialog.GetResult() }
        .map_err(|_| "无法读取 Windows 历史备份保存结果".to_owned())?;
    history_dialog_result_path(&item).map(Some)
}

#[cfg(target_os = "windows")]
pub(crate) fn choose_history_backup_destination() -> Result<Option<PathBuf>, String> {
    run_in_sta_thread(
        "历史备份保存对话框线程异常退出",
        choose_history_backup_destination_in_current_sta,
    )
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn choose_history_backup_destination() -> Result<Option<PathBuf>, String> {
    Err("当前平台不支持选择历史备份保存位置".to_owned())
}

#[cfg(target_os = "windows")]
fn choose_history_restore_source_in_current_sta() -> Result<Option<PathBuf>, String> {
    use std::ffi::OsStr;
    use windows::{
        core::{HRESULT, PCWSTR},
        Win32::{
            Foundation::ERROR_CANCELLED,
            System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            UI::Shell::{Common::COMDLG_FILTERSPEC, FileOpenDialog, IFileOpenDialog},
        },
    };

    let spec = history_dialog_spec(HistoryDialogKind::Restore);
    let dialog: IFileOpenDialog = unsafe {
        CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "无法创建 Windows 历史恢复打开对话框".to_owned())?
    };
    let options =
        unsafe { dialog.GetOptions() }.map_err(|_| "无法读取历史恢复对话框选项".to_owned())?;
    let extension = wide(OsStr::new(spec.default_extension));
    let filter_name = wide(OsStr::new(spec.filter_name));
    let filter_pattern = wide(OsStr::new(spec.filter_pattern));
    let filters = [COMDLG_FILTERSPEC {
        pszName: PCWSTR(filter_name.as_ptr()),
        pszSpec: PCWSTR(filter_pattern.as_ptr()),
    }];
    unsafe {
        dialog
            .SetOptions(options | spec.options)
            .and_then(|()| dialog.SetDefaultExtension(PCWSTR(extension.as_ptr())))
            .and_then(|()| dialog.SetFileTypes(&filters))
            .map_err(|_| "无法配置 Windows 历史恢复打开对话框".to_owned())?;
    }
    match unsafe { dialog.Show(None) } {
        Ok(()) => {}
        Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => return Ok(None),
        Err(_) => return Err("Windows 历史恢复打开对话框失败".to_owned()),
    }

    let item = unsafe { dialog.GetResult() }
        .map_err(|_| "无法读取 Windows 历史恢复打开结果".to_owned())?;
    history_dialog_result_path(&item).map(Some)
}

#[cfg(target_os = "windows")]
pub(crate) fn choose_history_restore_source() -> Result<Option<PathBuf>, String> {
    run_in_sta_thread(
        "历史恢复打开对话框线程异常退出",
        choose_history_restore_source_in_current_sta,
    )
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn choose_history_restore_source() -> Result<Option<PathBuf>, String> {
    Err("当前平台不支持选择历史恢复文件".to_owned())
}

#[cfg(target_os = "windows")]
fn atomic_publish_move_flags(
    destination_exists: bool,
) -> windows::Win32::Storage::FileSystem::MOVE_FILE_FLAGS {
    use windows::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

    if destination_exists {
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
    } else {
        MOVEFILE_WRITE_THROUGH
    }
}

#[cfg(target_os = "windows")]
fn native_replace_file_with_messages(
    temporary: &Path,
    destination: &Path,
    temporary_unicode_error: &'static str,
    destination_unicode_error: &'static str,
    replace_error: &'static str,
) -> Result<(), String> {
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::MoveFileExW};

    let temporary_value = temporary
        .to_str()
        .ok_or_else(|| temporary_unicode_error.to_owned())?;
    let destination_value = destination
        .to_str()
        .ok_or_else(|| destination_unicode_error.to_owned())?;
    validate_windows_path_syntax(temporary_value)?;
    validate_windows_path_syntax(destination_value)?;
    let temporary_wide = wide(temporary.as_os_str());
    let destination_wide = wide(destination.as_os_str());
    // 同目录临时文件只做一次内核重命名；MoveFileEx 失败不会进入 ReplaceFileW
    // 文档明确列出的 1176/1177 部分失败状态，因此可以安全地把 Err 解释为未发布。
    let result = unsafe {
        MoveFileExW(
            PCWSTR(temporary_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            atomic_publish_move_flags(destination.exists()),
        )
    };
    result.map_err(|_| replace_error.to_owned())
}

#[cfg(target_os = "windows")]
fn native_replace_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    native_replace_file_with_messages(
        temporary,
        destination,
        "临时图片路径不是有效 Unicode",
        "保存路径不是有效 Unicode",
        "无法原子保存 PNG 图片",
    )
}

#[cfg(not(target_os = "windows"))]
fn native_replace_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination).map_err(|_| "无法原子保存 PNG 图片".to_owned())
}

#[cfg(target_os = "windows")]
pub(crate) fn atomic_replace_history_file(
    temporary: &Path,
    destination: &Path,
) -> Result<(), String> {
    native_replace_file_with_messages(
        temporary,
        destination,
        "临时历史文件路径不是有效 Unicode",
        "历史备份保存路径不是有效 Unicode",
        "无法原子替换历史备份文件",
    )
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn atomic_replace_history_file(
    _temporary: &Path,
    _destination: &Path,
) -> Result<(), String> {
    Err("当前平台不支持原子替换历史备份文件".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use image::{DynamicImage, ImageFormat, RgbaImage};
    use std::path::{Path, PathBuf};
    use std::{
        cell::RefCell,
        fs,
        io::Cursor,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_PATH_COUNTER: AtomicU64 = AtomicU64::new(1);

    #[derive(Default)]
    struct FakeSystemActions {
        calls: RefCell<Vec<String>>,
        canonical_error: Option<String>,
        destination: Option<PathBuf>,
        replace_error: Option<String>,
    }

    impl SystemActionAdapter for FakeSystemActions {
        fn canonicalize_existing(&self, path: &Path) -> Result<PathBuf, String> {
            if let Some(error) = &self.canonical_error {
                return Err(error.clone());
            }
            Ok(path.to_path_buf())
        }

        fn open_url(&self, url: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("url:{url}"));
            Ok(())
        }

        fn open_path(&self, path: &Path) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(format!("open:{}", path.display()));
            Ok(())
        }

        fn reveal_path(&self, path: &Path) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(format!("reveal:{}", path.display()));
            Ok(())
        }

        fn choose_png_destination(&self) -> Result<Option<PathBuf>, String> {
            self.calls.borrow_mut().push("dialog".to_owned());
            Ok(self.destination.clone())
        }

        fn replace_file(&self, temporary: &Path, destination: &Path) -> Result<(), String> {
            self.calls.borrow_mut().push("replace".to_owned());
            if let Some(error) = &self.replace_error {
                return Err(error.clone());
            }
            fs::rename(temporary, destination).map_err(|error| error.to_string())
        }
    }

    fn temporary_test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let counter = TEST_PATH_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "quickpaste-system-actions-{name}-{}-{nonce}-{counter}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create isolated test directory");
        path
    }

    fn tiny_png_data_url() -> String {
        let mut png = Vec::new();
        DynamicImage::ImageRgba8(
            RgbaImage::from_raw(1, 1, vec![77, 111, 206, 255]).expect("one pixel"),
        )
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .expect("encode test PNG");
        format!("{PNG_DATA_URL_PREFIX}{}", STANDARD.encode(png))
    }

    #[test]
    fn external_urls_accept_only_bounded_absolute_http_without_credentials() {
        for accepted in [
            "https://example.com/path?q=1#section",
            "HTTPS://Example.COM/Case",
            "http://127.0.0.1:8080/",
            "https://[::1]/",
        ] {
            assert!(validate_external_url(accepted).is_ok(), "{accepted}");
        }

        for rejected in [
            "",
            "example.com",
            "/relative",
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "https:///missing-host",
            "https://user@example.com/",
            "https://user:secret@example.com/",
            " https://example.com/",
            "https://example.com/\n",
            "https://example.com/\0tail",
        ] {
            assert!(validate_external_url(rejected).is_err(), "{rejected:?}");
        }

        let oversized = format!("https://example.com/{}", "x".repeat(MAX_URL_BYTES));
        assert!(validate_external_url(&oversized).is_err());
    }

    #[test]
    fn windows_paths_accept_only_canonical_drive_absolute_or_unc_syntax() {
        for accepted in [
            r"C:\Users\Alice\note.txt",
            r"z:\folder",
            r"\\server\share\folder\note.txt",
            r"\\server\share",
        ] {
            assert!(validate_windows_path_syntax(accepted).is_ok(), "{accepted}");
        }

        for rejected in [
            "",
            "note.txt",
            r"C:note.txt",
            r"\Windows\notepad.exe",
            "/Windows/notepad.exe",
            r"C:\folder\..\note.txt",
            r"C:\folder\.\note.txt",
            r"C:\folder\\note.txt",
            "C:\\folder\\",
            r"C:\bad|name.txt",
            r"C:\CON.txt",
            r"C:\aux",
            r"C:\COM¹.txt",
            r"C:\COM²",
            r"C:\COM³.log",
            r"C:\LPT¹.txt",
            r"C:\LPT²",
            r"C:\LPT³.log",
            r"\\server\share\\note.txt",
            r"C:\trailing.\note.txt",
            r"\\server",
            r"\\?\C:\Windows\notepad.exe",
            r"\\?\UNC\server\share\note.txt",
            r"\\.\pipe\QuickPaste",
            "C:\\bad\0name.txt",
        ] {
            assert!(
                validate_windows_path_syntax(rejected).is_err(),
                "{rejected:?}"
            );
        }

        let oversized = format!(r"C:\{}", "x".repeat(MAX_WINDOWS_PATH_UTF16));
        assert!(validate_windows_path_syntax(&oversized).is_err());
    }

    #[test]
    fn existing_path_resolution_normalizes_only_safe_canonicalize_prefixes() {
        let drive = resolve_existing_windows_path(r"C:\folder\note.txt", |_| {
            Ok(PathBuf::from(r"\\?\C:\folder\note.txt"))
        })
        .expect("canonical drive path");
        assert_eq!(drive, PathBuf::from(r"C:\folder\note.txt"));

        let unc = resolve_existing_windows_path(r"\\server\share\note.txt", |_| {
            Ok(PathBuf::from(r"\\?\UNC\server\share\note.txt"))
        })
        .expect("canonical UNC path");
        assert_eq!(unc, PathBuf::from(r"\\server\share\note.txt"));

        assert!(resolve_existing_windows_path(r"C:\missing.txt", |_| {
            Err("文件不存在".to_owned())
        })
        .is_err());
        assert!(resolve_existing_windows_path(r"C:\safe.txt", |_| {
            Ok(PathBuf::from(r"\\?\GLOBALROOT\Device\HarddiskVolume1"))
        })
        .is_err());
        assert!(resolve_existing_windows_path(r"C:\safe.txt", |_| {
            Ok(PathBuf::from(r"relative\escape.txt"))
        })
        .is_err());
    }

    #[test]
    fn existing_path_resolution_passes_the_validated_original_to_canonicalize() {
        let mut observed = None;
        let resolved = resolve_existing_windows_path(r"D:\clips\one.txt", |path: &Path| {
            observed = Some(path.to_path_buf());
            Ok(path.to_path_buf())
        })
        .expect("existing path");

        assert_eq!(observed, Some(PathBuf::from(r"D:\clips\one.txt")));
        assert_eq!(resolved, PathBuf::from(r"D:\clips\one.txt"));
    }

    #[test]
    fn png_data_urls_are_strictly_bounded_decoded_and_reencoded() {
        let normalized =
            decode_png_data_url(&tiny_png_data_url(), MAX_PNG_BYTES).expect("valid PNG data URL");
        assert_eq!(&normalized[..8], b"\x89PNG\r\n\x1a\n");
        let decoded = image::load_from_memory_with_format(&normalized, ImageFormat::Png)
            .expect("normalized PNG");
        assert_eq!((decoded.width(), decoded.height()), (1, 1));

        for rejected in [
            "",
            "iVBORw0KGgo=",
            "data:image/jpeg;base64,iVBORw0KGgo=",
            "data:image/png;base64,%%%",
            "data:image/png;base64,bm90IGEgcG5n",
            "DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=",
        ] {
            assert!(
                decode_png_data_url(rejected, MAX_PNG_BYTES).is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn png_payload_limit_is_checked_before_image_decode() {
        let valid = tiny_png_data_url();
        let decoded_len = STANDARD
            .decode(valid.strip_prefix(PNG_DATA_URL_PREFIX).expect("prefix"))
            .expect("base64")
            .len();
        assert!(decode_png_data_url(&valid, decoded_len - 1).is_err());
        assert!(decode_png_data_url(&valid, decoded_len).is_ok());
    }

    #[test]
    fn typed_open_actions_validate_before_calling_the_adapter() {
        let adapter = FakeSystemActions::default();
        assert!(open_external_link_with(&adapter, "https://example.com/docs").expect("open URL"));
        assert!(open_file_path_with(&adapter, r"C:\clips\one.txt").expect("open file"));
        assert!(reveal_file_path_with(&adapter, r"\\server\share\one.txt").expect("reveal file"));
        assert_eq!(
            adapter.calls.into_inner(),
            vec![
                "url:https://example.com/docs".to_owned(),
                r"open:C:\clips\one.txt".to_owned(),
                r"reveal:\\server\share\one.txt".to_owned(),
            ]
        );

        let invalid = FakeSystemActions::default();
        assert!(open_external_link_with(&invalid, "file:///C:/secret.txt").is_err());
        assert!(open_file_path_with(&invalid, r"..\secret.txt").is_err());
        assert!(invalid.calls.borrow().is_empty());

        let missing = FakeSystemActions {
            canonical_error: Some("文件不存在".to_owned()),
            ..FakeSystemActions::default()
        };
        assert!(open_file_path_with(&missing, r"C:\missing.txt").is_err());
        assert!(missing.calls.borrow().is_empty());
    }

    #[test]
    fn image_save_cancel_is_a_successful_no_op_with_camel_case_result() {
        let adapter = FakeSystemActions::default();
        let result = save_clipboard_image_with(&adapter, &tiny_png_data_url())
            .expect("dialog cancellation is not an error");

        assert_eq!(result, SaveImageResult::cancelled());
        assert_eq!(
            serde_json::to_value(result).expect("serialize result"),
            serde_json::json!({ "status": "cancelled" })
        );
        assert_eq!(adapter.calls.into_inner(), vec!["dialog"]);
    }

    #[test]
    fn invalid_image_is_rejected_before_opening_the_dialog() {
        let adapter = FakeSystemActions::default();
        assert!(save_clipboard_image_with(&adapter, "data:image/png;base64,bm90IGEgcG5n").is_err());
        assert!(adapter.calls.borrow().is_empty());
    }

    #[test]
    fn image_save_requires_a_png_destination_before_creating_any_file() {
        let directory = temporary_test_directory("wrong-extension");
        let destination = directory.join("clip.jpg");
        let adapter = FakeSystemActions {
            destination: Some(destination.clone()),
            ..FakeSystemActions::default()
        };

        assert!(save_clipboard_image_with(&adapter, &tiny_png_data_url()).is_err());
        assert!(!destination.exists());
        assert_eq!(adapter.calls.into_inner(), vec!["dialog"]);
        assert_eq!(
            fs::read_dir(&directory).expect("empty directory").count(),
            0
        );

        fs::remove_dir(directory).expect("remove isolated test directory");
    }

    #[test]
    fn atomic_replace_failure_preserves_destination_and_cleans_its_temporary_file() {
        let directory = temporary_test_directory("replace-failure");
        let destination = directory.join("clip.png");
        fs::write(&destination, b"existing file").expect("seed destination");
        let adapter = FakeSystemActions {
            destination: Some(destination.clone()),
            replace_error: Some("replace failed".to_owned()),
            ..FakeSystemActions::default()
        };

        assert!(save_clipboard_image_with(&adapter, &tiny_png_data_url()).is_err());
        assert_eq!(
            fs::read(&destination).expect("old destination remains"),
            b"existing file"
        );
        assert_eq!(
            fs::read_dir(&directory)
                .expect("read test directory")
                .count(),
            1,
            "temporary sibling must be cleaned"
        );

        fs::remove_file(destination).expect("remove test destination");
        fs::remove_dir(directory).expect("remove isolated test directory");
    }

    #[test]
    fn valid_png_is_saved_via_a_synced_temporary_sibling() {
        let directory = temporary_test_directory("save-success");
        let destination = directory.join("clip.png");
        let adapter = FakeSystemActions {
            destination: Some(destination.clone()),
            ..FakeSystemActions::default()
        };

        let result =
            save_clipboard_image_with(&adapter, &tiny_png_data_url()).expect("save valid PNG");
        assert_eq!(result, SaveImageResult::saved());
        assert_eq!(
            serde_json::to_value(result).expect("serialize result"),
            serde_json::json!({ "status": "saved" })
        );
        let png = fs::read(&destination).expect("saved PNG");
        image::load_from_memory_with_format(&png, ImageFormat::Png).expect("valid saved PNG");
        assert_eq!(
            adapter.calls.into_inner(),
            vec!["dialog".to_owned(), "replace".to_owned()]
        );

        fs::remove_file(destination).expect("remove test destination");
        fs::remove_dir(directory).expect("remove isolated test directory");
    }

    #[test]
    fn tauri_commands_offload_validation_and_native_work_from_the_caller() {
        tauri::async_runtime::block_on(async {
            assert!(open_external_link("file:///C:/secret.txt".to_owned())
                .await
                .is_err());
            assert!(open_file_path("relative.txt".to_owned()).await.is_err());
            assert!(reveal_file_path(r"\\?\C:\secret.txt".to_owned())
                .await
                .is_err());
            assert!(
                save_clipboard_image("data:image/png;base64,bm90IGEgcG5n".to_owned())
                    .await
                    .is_err()
            );
        });
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn sta_runner_uses_a_dedicated_initialized_com_apartment() {
        use windows::Win32::System::Com::{
            CoGetApartmentType, APTTYPEQUALIFIER_NONE, APTTYPE_MAINSTA, APTTYPE_STA,
        };

        let caller = std::thread::current().id();
        let (different_thread, is_sta) =
            run_in_sta_thread("STA 测试线程异常退出", move || {
                let mut apartment_type = APTTYPE_STA;
                let mut qualifier = APTTYPEQUALIFIER_NONE;
                unsafe { CoGetApartmentType(&mut apartment_type, &mut qualifier) }
                    .map_err(|_| "无法读取测试 COM 公寓".to_owned())?;
                Ok((
                    std::thread::current().id() != caller,
                    apartment_type == APTTYPE_STA || apartment_type == APTTYPE_MAINSTA,
                ))
            })
            .expect("initialized STA thread");

        assert!(different_thread);
        assert!(is_sta);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_adapter_canonicalizes_an_existing_path_without_leaving_the_safe_namespace() {
        let executable = std::env::current_exe().expect("current executable");
        let canonical = NativeSystemActions
            .canonicalize_existing(&executable)
            .expect("canonical existing executable");
        normalize_canonical_windows_path(&canonical).expect("safe canonical path");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_atomic_replace_overwrites_existing_file_and_consumes_the_temporary() {
        let directory = temporary_test_directory("native-replace");
        let destination = directory.join("clip.png");
        let temporary = directory.join(".clip.png.quickpaste-test.tmp");
        fs::write(&destination, b"old").expect("seed destination");
        fs::write(&temporary, b"new").expect("seed replacement");

        NativeSystemActions
            .replace_file(&temporary, &destination)
            .expect("atomic replacement");

        assert_eq!(fs::read(&destination).expect("replacement"), b"new");
        assert!(!temporary.exists());
        fs::remove_file(destination).expect("remove destination");
        fs::remove_dir(directory).expect("remove test directory");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn history_dialog_specs_lock_sqlite_names_filters_and_safe_options() {
        use windows::Win32::UI::Shell::{
            FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_OVERWRITEPROMPT,
            FOS_PATHMUSTEXIST, FOS_STRICTFILETYPES,
        };

        let backup = history_dialog_spec(HistoryDialogKind::Backup);
        assert_eq!(backup.default_file_name, Some("QuickPaste-backup.sqlite3"));
        assert_eq!(backup.default_extension, "sqlite3");
        assert_eq!(backup.filter_pattern, "*.sqlite3");
        assert_eq!(
            backup.options.0,
            (FOS_FORCEFILESYSTEM
                | FOS_PATHMUSTEXIST
                | FOS_OVERWRITEPROMPT
                | FOS_NOCHANGEDIR
                | FOS_STRICTFILETYPES)
                .0
        );

        let restore = history_dialog_spec(HistoryDialogKind::Restore);
        assert_eq!(restore.default_file_name, None);
        assert_eq!(restore.default_extension, "sqlite3");
        assert_eq!(restore.filter_pattern, "*.sqlite3");
        let required = FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST;
        assert_eq!(restore.options.0 & required.0, required.0);

        let _: fn() -> Result<Option<PathBuf>, String> = choose_history_backup_destination;
        let _: fn() -> Result<Option<PathBuf>, String> = choose_history_restore_source;
        let _: fn(&Path, &Path) -> Result<(), String> = atomic_replace_history_file;
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn history_publish_plan_uses_one_atomic_move_with_explicit_replace_semantics() {
        use windows::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        assert_eq!(atomic_publish_move_flags(false).0, MOVEFILE_WRITE_THROUGH.0);
        assert_eq!(
            atomic_publish_move_flags(true).0,
            (MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH).0
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn history_atomic_replace_reports_locked_destination_failure_without_changing_either_file() {
        use std::os::windows::fs::OpenOptionsExt;

        let directory = temporary_test_directory("history-native-replace-locked");
        let destination = directory.join("history.sqlite3");
        let temporary = directory.join(".history.locked.tmp");
        fs::write(&destination, b"original history").expect("seed locked destination");
        fs::write(&temporary, b"replacement history").expect("seed locked replacement");
        let locked_destination = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&destination)
            .expect("lock destination without delete sharing");

        let error = atomic_replace_history_file(&temporary, &destination)
            .expect_err("locked destination must fail closed");
        drop(locked_destination);

        assert_eq!(
            fs::read(&destination).expect("read unchanged locked destination"),
            b"original history"
        );
        assert_eq!(
            fs::read(&temporary).expect("read retained replacement after failed move"),
            b"replacement history"
        );
        assert!(!error.contains(destination.to_string_lossy().as_ref()));
        assert!(!error.contains(temporary.to_string_lossy().as_ref()));

        fs::remove_file(destination).expect("remove locked destination fixture");
        fs::remove_file(temporary).expect("remove locked replacement fixture");
        fs::remove_dir(directory).expect("remove locked replacement directory");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn history_atomic_replace_handles_existing_and_new_destinations_without_path_errors() {
        let directory = temporary_test_directory("history-native-replace");
        let destination = directory.join("history.sqlite3");
        let first_temporary = directory.join(".history.first.tmp");
        fs::write(&destination, b"old history").expect("seed history destination");
        fs::write(&first_temporary, b"replacement history").expect("seed replacement");

        atomic_replace_history_file(&first_temporary, &destination)
            .expect("replace existing history file");
        assert_eq!(
            fs::read(&destination).expect("read replaced history"),
            b"replacement history"
        );
        assert!(!first_temporary.exists());

        let new_destination = directory.join("new-history.sqlite3");
        let second_temporary = directory.join(".history.second.tmp");
        fs::write(&second_temporary, b"new history").expect("seed new history");
        atomic_replace_history_file(&second_temporary, &new_destination)
            .expect("move new history file");
        assert_eq!(
            fs::read(&new_destination).expect("read new history"),
            b"new history"
        );
        assert!(!second_temporary.exists());

        let private_temporary = r"relative\secret-temporary.sqlite3";
        let private_destination = r"relative\secret-destination.sqlite3";
        let error = atomic_replace_history_file(
            Path::new(private_temporary),
            Path::new(private_destination),
        )
        .expect_err("relative paths must be rejected");
        assert!(!error.contains(private_temporary));
        assert!(!error.contains(private_destination));

        let missing_temporary = directory.join("private-missing-source.tmp");
        let failed_destination = directory.join("private-failed-destination.sqlite3");
        let native_error = atomic_replace_history_file(&missing_temporary, &failed_destination)
            .expect_err("missing replacement must fail");
        assert!(!native_error.contains(missing_temporary.to_string_lossy().as_ref()));
        assert!(!native_error.contains(failed_destination.to_string_lossy().as_ref()));

        fs::remove_file(destination).expect("remove replacement destination");
        fs::remove_file(new_destination).expect("remove new destination");
        fs::remove_dir(directory).expect("remove test directory");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn history_file_dialogs_and_atomic_replace_fail_closed_off_windows() {
        assert!(choose_history_backup_destination()
            .expect_err("backup dialog unsupported")
            .contains("不支持"));
        assert!(choose_history_restore_source()
            .expect_err("restore dialog unsupported")
            .contains("不支持"));
        assert!(atomic_replace_history_file(Path::new("a"), Path::new("b"))
            .expect_err("atomic history replace unsupported")
            .contains("不支持"));
    }
}
