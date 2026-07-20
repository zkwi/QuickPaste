use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, State};

const MAX_INSTALLER_BYTES: u64 = 128 * 1024 * 1024;
const RELEASES_API: &str = "https://api.github.com/repos/zkwi/QuickPaste/releases?per_page=10";
const TRUSTED_DOWNLOAD_PREFIX: &str = "https://github.com/zkwi/QuickPaste/releases/download/";
const USER_AGENT: &str = concat!("QuickPaste/", env!("CARGO_PKG_VERSION"));
static UPDATE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct UpdateRuntime {
    operation_in_flight: Arc<AtomicBool>,
    prepared: Arc<Mutex<Option<PreparedUpdate>>>,
}

impl Default for UpdateRuntime {
    fn default() -> Self {
        Self {
            operation_in_flight: Arc::new(AtomicBool::new(false)),
            prepared: Arc::new(Mutex::new(None)),
        }
    }
}

struct UpdateOperationGuard(Arc<AtomicBool>);

impl UpdateRuntime {
    fn begin_operation(&self) -> Result<UpdateOperationGuard, String> {
        self.operation_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| UpdateOperationGuard(self.operation_in_flight.clone()))
            .map_err(|_| "已有更新操作正在进行，请稍后重试。".to_string())
    }

    fn store_prepared(&self, update: PreparedUpdate) -> Result<Option<PreparedUpdate>, String> {
        let mut prepared = self
            .prepared
            .lock()
            .map_err(|_| "更新状态不可用，请重启 QuickPaste 后重试。".to_string())?;
        Ok(prepared.replace(update))
    }

    fn prepared_for(&self, token: &str) -> Result<PreparedUpdate, String> {
        let prepared = self
            .prepared
            .lock()
            .map_err(|_| "更新状态不可用，请重启 QuickPaste 后重试。".to_string())?;
        prepared
            .as_ref()
            .filter(|update| update.token == token)
            .cloned()
            .ok_or_else(|| "已下载的更新不存在或已失效，请重新下载。".to_string())
    }

    fn clear_prepared(&self, token: &str) -> Result<PreparedUpdate, String> {
        let mut prepared = self
            .prepared
            .lock()
            .map_err(|_| "更新状态不可用，请重启 QuickPaste 后重试。".to_string())?;
        if prepared
            .as_ref()
            .is_some_and(|update| update.token == token)
        {
            return prepared
                .take()
                .ok_or_else(|| "已下载的更新不存在或已失效，请重新下载。".to_string());
        }
        Err("已下载的更新不存在或已失效，请重新下载。".to_string())
    }
}

impl Drop for UpdateOperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
    state: Option<String>,
}

struct SelectedRelease<'a> {
    release: &'a GitHubRelease,
    version: String,
}

#[derive(Clone)]
struct ReleaseAsset {
    name: String,
    url: String,
    size: u64,
    sha256: [u8; 32],
}

#[derive(Clone)]
struct PreparedUpdate {
    token: String,
    version: String,
    asset_name: String,
    installer_path: PathBuf,
    size: u64,
    sha256: [u8; 32],
}

struct DownloadedInstaller {
    token: String,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    latest_version: String,
    update_available: bool,
    prerelease: bool,
    release_name: String,
    release_notes: String,
    release_url: String,
    published_at: Option<String>,
    asset_name: Option<String>,
    asset_size: Option<u64>,
    automatic_install_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    phase: &'static str,
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallUpdateResult {
    version: String,
    asset_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedUpdateResult {
    token: String,
    version: String,
    asset_name: String,
}

fn clean_version(value: &str) -> &str {
    value.trim().trim_start_matches(['v', 'V'])
}

fn select_newest_release<'a>(
    releases: &'a [GitHubRelease],
    current_version: &str,
) -> Option<SelectedRelease<'a>> {
    let current = Version::parse(clean_version(current_version)).ok()?;
    releases
        .iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = Version::parse(clean_version(&release.tag_name)).ok()?;
            (version > current).then_some((release, version))
        })
        .max_by(|(_, left), (_, right)| left.cmp(right))
        .map(|(release, version)| SelectedRelease {
            release,
            version: version.to_string(),
        })
}

fn choose_nsis_asset(release: &GitHubRelease, version: &str) -> Option<ReleaseAsset> {
    let expected_name = format!("QuickPaste_{version}_x64-setup.exe");
    let mut matching_assets = release
        .assets
        .iter()
        .filter(|asset| asset.name == expected_name);
    let asset = matching_assets.next()?;
    if matching_assets.next().is_some()
        || asset.size == 0
        || asset.size > MAX_INSTALLER_BYTES
        || !asset
            .browser_download_url
            .starts_with(TRUSTED_DOWNLOAD_PREFIX)
        || asset.state.as_deref() != Some("uploaded")
    {
        return None;
    }
    let sha256 = parse_sha256_digest(asset.digest.as_deref()?)?;
    Some(ReleaseAsset {
        name: asset.name.clone(),
        url: asset.browser_download_url.clone(),
        size: asset.size,
        sha256,
    })
}

fn parse_sha256_digest(value: &str) -> Option<[u8; 32]> {
    let encoded = value.strip_prefix("sha256:")?;
    if encoded.len() != 64 || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut digest = [0_u8; 32];
    for (index, output) in digest.iter_mut().enumerate() {
        *output = u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(digest)
}

fn nsis_update_args() -> [&'static str; 2] {
    ["/S", "/R"]
}

#[cfg(test)]
fn sha256_matches(bytes: &[u8], expected: &[u8; 32]) -> bool {
    Sha256::digest(bytes).as_slice() == expected
}

fn trusted_redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("更新下载重定向次数过多");
        }
        let url = attempt.url();
        let trusted_host = matches!(
            url.host_str(),
            Some("github.com")
                | Some("api.github.com")
                | Some("objects.githubusercontent.com")
                | Some("release-assets.githubusercontent.com")
        );
        if url.scheme() == "https" && trusted_host {
            attempt.follow()
        } else {
            attempt.error("更新下载被重定向到不受信任的地址")
        }
    })
}

fn build_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .redirect(trusted_redirect_policy())
        .build()
        .map_err(|error| format!("无法初始化更新连接：{error}"))
}

async fn fetch_releases() -> Result<Vec<GitHubRelease>, String> {
    let response = build_client(Duration::from_secs(20))?
        .get(RELEASES_API)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| friendly_network_error("连接 GitHub 更新服务失败", &error))?;

    if response.status() == StatusCode::NOT_FOUND {
        return Err("尚未找到可用的 QuickPaste Release。".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "GitHub 更新服务返回 HTTP {}。",
            response.status().as_u16()
        ));
    }
    response
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|error| format!("无法解析 GitHub Release 信息：{error}"))
}

fn friendly_network_error(prefix: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("{prefix}：请求超时，请稍后重试。")
    } else if error.is_connect() {
        format!("{prefix}：请检查网络、代理或防火墙设置。")
    } else {
        format!("{prefix}：{error}")
    }
}

fn release_notes(value: Option<&str>) -> String {
    const MAX_CHARS: usize = 4_000;
    value
        .unwrap_or_default()
        .chars()
        .take(MAX_CHARS)
        .collect::<String>()
}

#[tauri::command]
pub async fn check_for_update(runtime: State<'_, UpdateRuntime>) -> Result<UpdateStatus, String> {
    let _operation = runtime.begin_operation()?;
    let releases = fetch_releases().await?;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let Some(selected) = select_newest_release(&releases, &current_version) else {
        return Ok(UpdateStatus {
            current_version: current_version.clone(),
            latest_version: current_version,
            update_available: false,
            prerelease: false,
            release_name: String::new(),
            release_notes: String::new(),
            release_url: "https://github.com/zkwi/QuickPaste/releases".to_string(),
            published_at: None,
            asset_name: None,
            asset_size: None,
            automatic_install_available: false,
        });
    };
    let asset = choose_nsis_asset(selected.release, &selected.version);
    Ok(UpdateStatus {
        current_version,
        latest_version: selected.version,
        update_available: true,
        prerelease: selected.release.prerelease,
        release_name: selected
            .release
            .name
            .clone()
            .unwrap_or_else(|| selected.release.tag_name.clone()),
        release_notes: release_notes(selected.release.body.as_deref()),
        release_url: selected.release.html_url.clone(),
        published_at: selected.release.published_at.clone(),
        asset_name: asset.as_ref().map(|asset| asset.name.clone()),
        asset_size: asset.as_ref().map(|asset| asset.size),
        automatic_install_available: asset.is_some(),
    })
}

fn update_temp_path(asset_name: &str) -> Result<(String, PathBuf, PathBuf), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间异常，无法创建更新临时目录。".to_string())?
        .as_nanos();
    let sequence = UPDATE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let token = format!("{:x}-{timestamp:x}-{sequence:x}", std::process::id());
    let directory = std::env::temp_dir()
        .join("QuickPaste")
        .join("updates")
        .join(&token);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建更新临时目录：{error}"))?;
    Ok((
        token,
        directory.join(format!("{asset_name}.part")),
        directory.join(asset_name),
    ))
}

fn emit_progress(
    channel: &Channel<UpdateProgress>,
    phase: &'static str,
    downloaded_bytes: u64,
    total_bytes: u64,
) {
    let percent = if total_bytes == 0 {
        0
    } else {
        ((downloaded_bytes.saturating_mul(100) / total_bytes).min(100)) as u8
    };
    let _ = channel.send(UpdateProgress {
        phase,
        downloaded_bytes,
        total_bytes,
        percent,
    });
}

async fn download_asset(
    asset: &ReleaseAsset,
    on_progress: &Channel<UpdateProgress>,
) -> Result<DownloadedInstaller, String> {
    let response = build_client(Duration::from_secs(300))?
        .get(&asset.url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| friendly_network_error("下载安装包失败", &error))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载安装包失败，HTTP {}。",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != asset.size)
    {
        return Err("安装包响应大小与 Release 元数据不一致。".to_string());
    }

    let (token, partial_path, installer_path) = update_temp_path(&asset.name)?;
    let result = async {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial_path)
            .map_err(|error| format!("无法创建更新临时文件：{error}"))?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0_u64;
        let mut hasher = Sha256::new();
        let mut last_progress_percent = 0_u8;
        let mut last_progress_at = Instant::now();
        emit_progress(on_progress, "downloading", 0, asset.size);

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("读取更新下载内容失败：{error}"))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > asset.size || downloaded > MAX_INSTALLER_BYTES {
                return Err("安装包下载大小超过 Release 声明或安全上限。".to_string());
            }
            file.write_all(&chunk)
                .map_err(|error| format!("写入更新临时文件失败：{error}"))?;
            hasher.update(&chunk);
            let percent = ((downloaded.saturating_mul(100) / asset.size).min(100)) as u8;
            if percent > last_progress_percent
                || last_progress_at.elapsed() >= Duration::from_millis(100)
            {
                emit_progress(on_progress, "downloading", downloaded, asset.size);
                last_progress_percent = percent;
                last_progress_at = Instant::now();
            }
        }
        file.flush()
            .map_err(|error| format!("刷新更新临时文件失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步更新临时文件失败：{error}"))?;
        drop(file);
        if downloaded != asset.size {
            return Err("安装包下载未完成，实际大小与 Release 声明不一致。".to_string());
        }
        emit_progress(on_progress, "verifying", downloaded, asset.size);
        let actual: [u8; 32] = hasher.finalize().into();
        if actual != asset.sha256 {
            return Err("安装包 SHA-256 与 GitHub Release 摘要不一致。".to_string());
        }
        fs::rename(&partial_path, &installer_path)
            .map_err(|error| format!("无法完成更新临时文件：{error}"))?;
        Ok(DownloadedInstaller {
            token,
            path: installer_path.clone(),
        })
    }
    .await;

    if result.is_err() {
        let _ = fs::remove_file(&partial_path);
        if let Some(directory) = partial_path.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
    result
}

fn launch_installer(path: &Path) -> Result<(), String> {
    let mut child = Command::new(path)
        .args(nsis_update_args())
        .spawn()
        .map_err(|error| format!("无法启动更新安装程序：{error}"))?;

    // 捕获缺少执行权限、损坏文件等立即失败；后续安装由独立 NSIS 进程负责。
    thread::sleep(Duration::from_millis(350));
    match child.try_wait() {
        Ok(Some(status)) if !status.success() => Err(format!(
            "更新安装程序启动后立即退出（代码 {}）。",
            status
                .code()
                .map_or_else(|| "未知".to_string(), |code| code.to_string())
        )),
        Ok(_) => Ok(()),
        Err(error) => Err(format!("无法确认更新安装程序状态：{error}")),
    }
}

fn verify_downloaded_installer(
    path: &Path,
    expected_size: u64,
    expected_sha256: &[u8; 32],
) -> Result<(), String> {
    if expected_size == 0 || expected_size > MAX_INSTALLER_BYTES {
        return Err("安装包声明大小无效。".to_string());
    }
    let mut file = File::open(path).map_err(|error| format!("无法重新打开更新安装包：{error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取更新安装包信息：{error}"))?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err("更新安装包大小已发生变化，请重新下载。".to_string());
    }

    let mut hasher = Sha256::new();
    let mut verified_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("重新校验更新安装包失败：{error}"))?;
        if read == 0 {
            break;
        }
        verified_bytes = verified_bytes.saturating_add(read as u64);
        if verified_bytes > expected_size || verified_bytes > MAX_INSTALLER_BYTES {
            return Err("更新安装包大小已发生变化，请重新下载。".to_string());
        }
        hasher.update(&buffer[..read]);
    }

    let actual: [u8; 32] = hasher.finalize().into();
    if verified_bytes != expected_size || actual != *expected_sha256 {
        return Err("更新安装包 SHA-256 已发生变化，请重新下载。".to_string());
    }
    Ok(())
}

fn cleanup_prepared_update(update: &PreparedUpdate) {
    let _ = fs::remove_file(&update.installer_path);
    if let Some(directory) = update.installer_path.parent() {
        let _ = fs::remove_dir(directory);
    }
}

#[tauri::command]
pub async fn download_update(
    runtime: State<'_, UpdateRuntime>,
    version: String,
    on_progress: Channel<UpdateProgress>,
) -> Result<PreparedUpdateResult, String> {
    let _operation = runtime.begin_operation()?;
    let requested =
        Version::parse(clean_version(&version)).map_err(|_| "更新版本格式无效。".to_string())?;
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "当前应用版本格式无效。".to_string())?;
    if requested <= current {
        return Err("目标版本不高于当前版本。".to_string());
    }
    let releases = fetch_releases().await?;
    let release = releases
        .iter()
        .filter(|release| !release.draft)
        .find(|release| {
            Version::parse(clean_version(&release.tag_name))
                .ok()
                .as_ref()
                == Some(&requested)
        })
        .ok_or_else(|| "目标 Release 已不存在或不可用，请重新检查更新。".to_string())?;
    let asset = choose_nsis_asset(release, &requested.to_string())
        .ok_or_else(|| "目标 Release 没有可验证的 QuickPaste x64 NSIS 安装包。".to_string())?;
    let downloaded = download_asset(&asset, &on_progress).await?;
    let prepared = PreparedUpdate {
        token: downloaded.token.clone(),
        version: requested.to_string(),
        asset_name: asset.name.clone(),
        installer_path: downloaded.path,
        size: asset.size,
        sha256: asset.sha256,
    };
    if let Some(previous) = runtime.store_prepared(prepared)? {
        cleanup_prepared_update(&previous);
    }

    Ok(PreparedUpdateResult {
        token: downloaded.token,
        version: requested.to_string(),
        asset_name: asset.name,
    })
}

#[tauri::command]
pub async fn install_downloaded_update(
    app: AppHandle,
    runtime: State<'_, UpdateRuntime>,
    token: String,
) -> Result<InstallUpdateResult, String> {
    let _operation = runtime.begin_operation()?;
    let token = token.trim();
    if token.is_empty() {
        return Err("已下载的更新不存在或已失效，请重新下载。".to_string());
    }
    let prepared = runtime.prepared_for(token)?;
    if let Err(error) =
        verify_downloaded_installer(&prepared.installer_path, prepared.size, &prepared.sha256)
    {
        if let Ok(invalid) = runtime.clear_prepared(token) {
            cleanup_prepared_update(&invalid);
        }
        return Err(error);
    }

    // 校验后立即启动，尽量缩短本地文件被替换的竞态窗口。
    launch_installer(&prepared.installer_path)?;
    let _ = runtime.clear_prepared(token);
    crate::request_app_quit(&app);

    Ok(InstallUpdateResult {
        version: prepared.version,
        asset_name: prepared.asset_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(
        tag: &str,
        draft: bool,
        prerelease: bool,
        assets: Vec<GitHubAsset>,
    ) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_string(),
            name: Some(format!("QuickPaste {tag}")),
            body: Some("更新说明".to_string()),
            html_url: format!("https://github.com/zkwi/QuickPaste/releases/tag/{tag}"),
            published_at: Some("2026-07-19T00:00:00Z".to_string()),
            draft,
            prerelease,
            assets,
        }
    }

    fn asset(name: &str, size: u64, digest: Option<&str>) -> GitHubAsset {
        GitHubAsset {
            name: name.to_string(),
            browser_download_url: format!(
                "https://github.com/zkwi/QuickPaste/releases/download/v0.2.0/{name}"
            ),
            size,
            digest: digest.map(str::to_string),
            state: Some("uploaded".to_string()),
        }
    }

    #[test]
    fn newest_published_release_includes_preview_versions_but_ignores_drafts() {
        let releases = vec![
            release("v0.2.0", true, false, vec![]),
            release("v0.2.0-beta.2", false, true, vec![]),
            release("v0.1.1", false, false, vec![]),
            release("broken", false, false, vec![]),
        ];

        let selected = select_newest_release(&releases, "0.1.0").expect("new release");

        assert_eq!(selected.version, "0.2.0-beta.2");
        assert!(selected.release.prerelease);
    }

    #[test]
    fn exact_nsis_asset_requires_expected_name_size_and_github_digest() {
        let digest = format!("sha256:{}", "ab".repeat(32));
        let release = release(
            "v0.2.0",
            false,
            false,
            vec![
                asset("QuickPaste_0.2.0_x64-setup.exe", 3_200_000, Some(&digest)),
                asset("QuickPaste_0.2.0_x64.msi", 3_000_000, Some(&digest)),
            ],
        );

        let selected = choose_nsis_asset(&release, "0.2.0").expect("strict NSIS asset");

        assert_eq!(selected.name, "QuickPaste_0.2.0_x64-setup.exe");
        assert_eq!(selected.sha256, [0xab; 32]);
    }

    #[test]
    fn automatic_install_rejects_ambiguous_oversized_or_unverified_assets() {
        let digest = format!("sha256:{}", "cd".repeat(32));
        let mut asset_without_uploaded_state =
            asset("QuickPaste_0.2.0_x64-setup.exe", 3_200_000, Some(&digest));
        asset_without_uploaded_state.state = None;
        for candidate in [
            asset("QuickPaste-windows-x64-setup.exe", 3_200_000, Some(&digest)),
            asset(
                "QuickPaste_0.2.0_x64-setup.exe",
                MAX_INSTALLER_BYTES + 1,
                Some(&digest),
            ),
            asset("QuickPaste_0.2.0_x64-setup.exe", 3_200_000, None),
            asset_without_uploaded_state,
        ] {
            let release = release("v0.2.0", false, false, vec![candidate]);
            assert!(choose_nsis_asset(&release, "0.2.0").is_none());
        }

        let duplicate = asset("QuickPaste_0.2.0_x64-setup.exe", 3_200_000, Some(&digest));
        let release = release("v0.2.0", false, false, vec![duplicate.clone(), duplicate]);
        assert!(choose_nsis_asset(&release, "0.2.0").is_none());
    }

    #[test]
    fn silent_nsis_update_installs_and_reopens_the_app() {
        assert_eq!(nsis_update_args(), ["/S", "/R"]);
    }

    #[test]
    fn sha256_verification_detects_download_tampering() {
        let expected = parse_sha256_digest(
            "sha256:548bfeabf66c77c655d69d1879ee74056631b2ced9e96cca5948321c299e4045",
        )
        .expect("valid digest");

        assert!(sha256_matches(b"quickpaste", &expected));
        assert!(!sha256_matches(b"QuickPaste", &expected));
    }

    #[test]
    fn downloaded_installer_is_rehashed_immediately_before_launch() {
        let (_token, _partial_path, installer_path) =
            update_temp_path("QuickPaste_0.2.0_x64-setup.exe").expect("temporary path");
        let original = b"verified installer";
        let expected: [u8; 32] = Sha256::digest(original).into();
        fs::write(&installer_path, original).expect("write installer");

        assert!(
            verify_downloaded_installer(&installer_path, original.len() as u64, &expected).is_ok()
        );

        fs::write(&installer_path, b"tampered installer").expect("tamper installer");
        assert!(
            verify_downloaded_installer(&installer_path, original.len() as u64, &expected).is_err()
        );

        let directory = installer_path.parent().expect("installer directory");
        let _ = fs::remove_file(&installer_path);
        let _ = fs::remove_dir(directory);
    }

    #[test]
    fn updater_operation_gate_rejects_overlap_and_recovers_after_drop() {
        let runtime = UpdateRuntime::default();
        let first = runtime.begin_operation().expect("first operation");

        assert!(runtime.begin_operation().is_err());
        drop(first);
        assert!(runtime.begin_operation().is_ok());
    }

    #[test]
    fn prepared_update_requires_matching_opaque_token_and_clears_explicitly() {
        let runtime = UpdateRuntime::default();
        let prepared = PreparedUpdate {
            token: "opaque-token".to_string(),
            version: "0.2.0".to_string(),
            asset_name: "QuickPaste_0.2.0_x64-setup.exe".to_string(),
            installer_path: PathBuf::from("prepared-installer.exe"),
            size: 18,
            sha256: [0xab; 32],
        };

        assert!(runtime.prepared_for("opaque-token").is_err());
        assert!(runtime.store_prepared(prepared).expect("store").is_none());
        assert!(runtime.prepared_for("wrong-token").is_err());
        assert_eq!(
            runtime
                .prepared_for("opaque-token")
                .expect("prepared update")
                .version,
            "0.2.0"
        );
        assert!(runtime.clear_prepared("wrong-token").is_err());
        assert!(runtime.clear_prepared("opaque-token").is_ok());
        assert!(runtime.prepared_for("opaque-token").is_err());
    }
}
