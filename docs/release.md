# Windows 发布检查清单

当前 `0.1.0` 仍是开发候选版。以下所有阻断项完成后，才可把某个构建称为正式发布版本。

## 1. 发布前置条件

- `main` 上的目标修改已评审，工作区只包含本次发布内容。
- `CHANGELOG.md` 中的 `Unreleased` 已归入目标版本和日期。
- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 使用相同版本。
- 已选定公开源码许可证，或明确以 `UNLICENSED`/保留全部权利方式公开源码；未选择许可证时不得对外宣称开源。
- `SECURITY.md` 已提供真实、可验证的私密漏洞报告渠道和响应时间。
- 当前个人项目阶段明确发布未签名的 GitHub Pre-release，并在下载页、安装提示和更新界面清楚标注；不得把 SHA-256 描述为发布者签名。
- 已运行 `npm run check:privacy`，确认候选文件和 Git 历史不包含真实用户路径、邮箱、剪贴板数据、数据库、日志、截图、Token、证书或构建产物。

## 2. 构建环境与质量门禁

在 Windows x64 标准构建机确认主机目标：

```powershell
node --version
npm --version
rustc -vV
```

`rustc -vV` 的 host 必须是 `x86_64-pc-windows-msvc`。随后执行：

```powershell
npm ci
npm run check
npm run build:windows
```

`npm run build:windows` 显式使用 `--bundles nsis --target x86_64-pc-windows-msvc`，避免在其他架构主机上误产非 x64 安装包。候选安装包只能来自：

```text
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\
```

发布目录中不得混入旧构建或 `.msi`。如无法证明产物来自本次质量门禁后的构建，应重新在干净环境生成。

## 3. WebView2 分发约束

当前 `tauri.conf.json` 使用 `downloadBootstrapper`。目标机器缺少 WebView2 Runtime 时，安装器需要访问 Microsoft 下载服务；这不是离线安装方案。

- 在已有 WebView2 的机器验证安装不会重复阻塞。
- 在缺少 WebView2 且网络可用的机器验证 Bootstrapper。
- 在网络不可用时验证错误可理解且不会留下错误的“安装成功”状态。
- 若要声明离线安装支持，必须改用并验收 Evergreen Standalone 或其他明确方案。参见 [Microsoft WebView2 分发文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。

## 4. 完整性和未签名状态校验

当前方案不配置 Authenticode。构建后确认产物确实为未签名状态，并记录安装包 SHA-256、大小和版本，避免误以为已签名：

```powershell
$releaseExe = Resolve-Path -LiteralPath 'src-tauri\target\x86_64-pc-windows-msvc\release\quickpaste.exe'
$installer = Get-ChildItem -LiteralPath 'src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis' -Filter '*-setup.exe'
if ($installer.Count -ne 1) { throw "NSIS 候选安装包数量异常：$($installer.Count)" }

$artifacts = @($releaseExe.Path, $installer[0].FullName)
foreach ($artifact in $artifacts) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact
  if ($signature.Status -ne 'NotSigned') { throw "未签名发布状态异常：$artifact ($($signature.Status))" }
  Get-FileHash -Algorithm SHA256 -LiteralPath $artifact
}
```

把最终安装包的文件名、大小、版本和 SHA-256 写入发布说明。上传后从 GitHub 下载入口重新获取安装包，再核对本地 SHA-256、GitHub `asset.digest` 和大小完全一致。

## 5. Windows 人工验收

完整执行 [测试与验收矩阵](testing.md)，发布至少覆盖：

- Windows 10/11 x64 标准用户的安装、覆盖安装、启动、卸载和重装。
- 100%、125%、150% DPI，多显示器不同缩放和任务栏边界。
- 文本/图片历史、重启恢复、固定项、保留期限和安全清理。
- 普通窗口、管理员窗口、UAC 取消、目标失效和手动粘贴降级。
- 中文输入法、全局快捷键冲突、开机启动、托盘和单实例。
- 敏感应用排除以及受支持捕获路径中的窗口排除。
- 卸载不意外删除历史；需要彻底删除时，文档指向 `SECURITY.md` 的数据生命周期说明。

任一关键场景失败都必须阻止发布，不能只记录为“已知问题”后继续上传。

## 6. 发布纪律

- 推送、合并、版本标签和上传产物必须由维护者明确发起。
- 先验证候选产物与隐私扫描，再创建不可变版本标签；标签应指向产生该产物的提交。
- 不提交 `dist`、`target`、`output`、日志、数据库、WAL/SHM 或签名材料。
- 发布后从下载入口重新获取安装包，再次核对 SHA-256、大小和未签名状态，避免上传过程选错文件。

## 7. GitHub Actions 异步复核

- 发布是否继续，以本机 `npm run check`、`npm run build:windows`、隐私扫描和产物校验结果为准。
- 推送后记录对应 GitHub Actions 链接与当时状态，不在发布任务中阻塞等待远端 Runner 完成。
- CI 后续失败时创建修复提交并重新验证；若失败影响已发布安装包的正确性或安全性，应撤下或明确标记对应 Release。
