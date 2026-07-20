# Windows 发布检查清单

`0.14.1` 是当前 GitHub Release。发布页固定为 <https://github.com/zkwi/QuickPaste/releases/tag/v0.14.1>。本清单把“GitHub 发布渠道”和“验证完成度”分开：本地代码、隐私、许可证、构建和产物核验均为发布阻断项；真实机长循环未完成时必须保留 `pending real-machine`，不得宣称已经全面验收。是否使用 Pre-release 由维护者在发布时明确决定，不能用渠道标签替代验证证据。

## 版本定级

- 新功能、显著 UI/交互调整，或一组用户可感知的体验改进，默认提升 minor 版本；不要为了显得“稳妥”而降为 patch。
- patch 只用于范围明确、不会改变主要流程或布局结构的修复。
- 一次候选版本包含多类变更时，按影响最高的一项定级。`1.0.0` 前的破坏性变化至少提升 minor，并在发布说明中写明迁移影响。

## 1. 发布前置条件

- `main` 上的目标修改已评审，工作区只包含本次发布内容。
- `CHANGELOG.md` 中的 `Unreleased` 已归入目标版本和日期。
- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 使用相同版本。
- 已选定公开源码许可证，或明确以 `UNLICENSED`/保留全部权利方式公开源码；未选择许可证时不得对外宣称开源。
- `SECURITY.md` 已提供真实、可验证的私密漏洞报告渠道和响应时间。
- 更新界面和 GitHub Release 只突出版本、功能与 SHA-256 完整性校验，不把代码签名状态作为面向用户的重点提示。
- 已运行 `npm run check:privacy`，确认当前候选文件不包含真实用户路径、邮箱、剪贴板数据、数据库、日志、截图、Token、证书或构建产物。
- `THIRD_PARTY_NOTICES.md`、npm/Rust/native 三份完整许可证清单与两个锁文件一致，并由 `npm run check:licenses` 验证均已配置为 Tauri bundle resources；完整 NSIS 归档仍按产物核验步骤独立检查。

## 2. 构建环境与质量门禁

在 Windows x64 标准构建机确认主机目标：

```powershell
node --version
npm --version
rustc -vV
```

`rustc -vV` 的 host 必须是 `x86_64-pc-windows-msvc`。随后执行：

若锁文件或依赖发生变化，先安装固定的发布期许可证工具并重新生成三份声明：

```powershell
cargo install cargo-about --version 0.9.1 --locked --features cli
npm run licenses:npm
npm run licenses:rust
npm run licenses:native
```

`cargo-about` 只用于生成发布材料，不属于 QuickPaste 构建或运行时依赖。常规质量门禁与构建命令为：

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

## 4. 产物完整性校验

构建后记录主程序与安装包的 SHA-256、大小和版本；代码签名状态只作为内部产物追溯信息，不写入面向用户的 Release 摘要：

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
- 100%、125%、150%、175%、200%、225%、250% DPI，多显示器不同缩放、负坐标和四个任务栏边界。
- 文本/图片历史、重启恢复、固定项、保留期限和安全清理。
- 安装版和绿色版都只在可执行文件同级的 `data` 文件夹创建数据库；完全退出后复制目录可恢复历史，开发阶段旧应用数据目录不会被读取或迁移。
- 普通窗口、管理员窗口、UAC 取消、目标失效和手动粘贴降级。
- 中文输入法、全局快捷键冲突、开机启动、托盘和单实例。
- 敏感应用排除以及受支持捕获路径中的窗口排除。
- 卸载不意外删除历史；需要彻底删除时，文档指向 `SECURITY.md` 的数据生命周期说明。

任一关键场景明确失败都必须阻止发布，不能只记录为“已知问题”后继续上传。尚未执行的真实机长循环必须保留 `pending real-machine` 并在发布说明中醒目标注；即使维护者选择标准 GitHub Release，也不得表述为稳定版已全面验收。

### 证据分级与长循环门槛

- **automated proof** 只证明测试覆盖的规则和安全边界；**synthetic benchmark** 只证明固定种子受控负载。两者都不能替代 **pending real-machine** 项目的真实机记录。
- 按 [验收脚手架协议](../scripts/acceptance/README.md) 分别使用新的临时 profile 完成：50 次预热 + 500 次暖唤起采样、10,000 次外部普通权限目标验证粘贴、100,000 次独立 writer/expected-ID ledger 捕获与 DB/事件对账，以及 1.0–2.5 七档混合 DPI 矩阵。
- metrics 只在显式 `--acceptance-metrics` 与有效临时 `QUICKPASTE_ACCEPTANCE_PROFILE` 同时存在时启用；缺少 profile 必须失败，不能回落真实 app-data。paste/capture counters 是诊断信息，不能作为普通目标确实收到内容或 100k 写入无遗漏的唯一证据。
- 未执行、样本不足、helper 不独立、临时 profile 边界不确定、账本/哈希缺失或 DPI 行不完整时，结果必须保留 **pending real-machine**，不得在发布说明中写成“达到阈值”。

对每个 `<run-root>\result.json` 运行：

```powershell
Test-Json -LiteralPath '<run-root>\result.json' `
  -SchemaFile 'scripts\acceptance\acceptance-result.schema.json'
node scripts/acceptance/acceptance.mjs validate-result --file '<run-root>\result.json'
```

只有 schema 和算术校验均通过、且独立原始证据可追溯到同一候选程序 SHA-256 时，才记录真实机 pass/fail。运行产生的 `result.json`、metrics、数据库、日志、账本和截图只留在系统临时验收目录，不得提交到仓库或打入安装包。

## 6. 发布纪律

- 推送、合并、版本标签和上传产物必须由维护者明确发起。
- 先验证候选产物与隐私扫描，再创建不可变版本标签；标签应指向产生该产物的提交。
- 不提交 `dist`、`target`、`output`、日志、数据库、WAL/SHM 或签名材料。
- 发布后从下载入口重新获取安装包，再次核对 SHA-256、大小和版本，避免上传过程选错文件。

## 7. GitHub Actions 异步复核

- 发布是否继续，以本机 `npm run check`、`npm run build:windows`、隐私扫描和产物校验结果为准。
- 推送后记录对应 GitHub Actions 链接与当时状态，不在发布任务中阻塞等待远端 Runner 完成。
- CI 后续失败时创建修复提交并重新验证；若失败影响已发布安装包的正确性或安全性，应撤下或明确标记对应 Release。
