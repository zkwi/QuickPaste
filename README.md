# QuickPaste（闪电剪贴板）

**闪电剪贴板 QuickPaste** 是一款专为 Windows 打造的剪贴板历史管理工具，主打一个“快”字。
`Ctrl + Shift + V` 一键唤起，搜索结果保留原文并高亮命中，选中后自动帮你切回原来的输入框完成粘贴——
把“复制 → 切窗口 → 粘贴”一步搞定。支持按中文原文和拼音搜索，所有历史只存在本机 SQLite 中，
没有云同步，没有遥测。

> 当前状态：`0.1.0` 未签名预发布版。个人项目阶段明确不使用 Authenticode 或 Tauri updater 签名；安装时可能触发 SmartScreen 提示，请只从本仓库 Release 下载。

## 当前能力

- 监听 Windows 文本与图片剪贴板，基于剪贴板序列号避免无效轮询。
- 按中文原文、内容、来源应用和类型搜索；新捕获的中文内容会生成全拼与首字母索引。
- 文本、代码、链接、图片分类及预览，搜索结果保留原文并高亮可见命中。
- 固定、删除、撤销、保留期限、暂停记录，以及保留固定项的安全批量清理。
- 默认使用 `Ctrl + Shift + V` 唤起；快速面板优先靠近文本插入点右下方，并受当前显示器工作区约束。
- 记住并复核原窗口后尽力自动回贴；目标失效或修饰键未释放时安全降级为仅复制。
- 管理员窗口使用带时限、进程互认且绑定剪贴板版本的一次性 UAC helper，目标请求不落盘；主程序若被以管理员身份启动会提示并退出。
- Enter、双击和 Alt + 数字快速粘贴，支持键盘导航和中文输入法组合态保护。
- 浅色/深色主题、紧凑快速面板、管理页、设置页和首次启动引导。
- 简体中文为默认语言，主要界面可即时切换英文。
- SQLite 本地历史持久化，图片以 BLOB 保存，普通历史默认上限 500 条。
- 在设置页或托盘检查 GitHub Release，经用户确认后下载严格命名的 NSIS 安装包；下载会核对 GitHub SHA-256 摘要，但这不是发布者签名。
- 关闭隐藏到系统托盘、托盘暂停/恢复、单实例唤回和开机静默启动。
- 敏感应用排除，以及可选的屏幕捕获保护；默认允许截图，用户开启保护后才在 Windows 支持的捕获路径中尽力隐藏闪电剪贴板窗口。
- 轻量级、当前用户范围的 NSIS 安装包；项目不生成 MSI。

## 系统与开发环境

目标运行环境是 Windows 10/11 x64 和 Microsoft Edge WebView2 Runtime。安装器当前使用在线 WebView2 Bootstrapper：目标机器缺少 Runtime 时，安装过程需要访问 Microsoft 下载服务；离线安装尚未作为发布能力验收。

开发环境还需要：

- Node.js：版本见 `.nvmrc`；npm 版本见 `package.json` 的 `packageManager`。
- Rust：版本与组件见 `rust-toolchain.toml`。
- Microsoft C++ Build Tools，并选择“Desktop development with C++”。
- Windows SDK、MSVC Rust target 和 WebView2 Runtime。

完整环境说明见 [Tauri Windows 前置要求](https://v2.tauri.app/start/prerequisites/)。

## 开发与验证

```powershell
npm ci
npm run check
npm run tauri dev
```

`npm run check` 会执行治理脚本测试、版本同步、公共仓库隐私扫描、仓库卫生和文档链接检查、前端测试与生产构建、Rust 格式检查、Clippy 及 Rust 单元测试。测试分层和人工验收范围见 [docs/testing.md](docs/testing.md)。

构建 Windows NSIS 候选包：

```powershell
npm run build:windows
```

产物位于 `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis`。公开预发布前必须完成标准用户安装、升级/卸载、哈希核对和真实 Windows 场景验收，详见 [docs/release.md](docs/release.md)。

## 项目结构

- `src/domain/`：可独立测试的剪贴板、搜索、高亮和快捷键规则。
- `src/platform/`：前端与 Tauri IPC、系统剪贴板、窗口、设置和历史能力的适配层。
- `src/App.vue`：快速面板、管理页、设置页、模态框及焦点生命周期编排。
- `src-tauri/`：Tauri 2 + Rust 的 Windows API、SQLite、全局快捷键、托盘和粘贴实现。
- `scripts/`：无额外运行时依赖的仓库治理检查。

## 文档

- [CONTRIBUTING.md](CONTRIBUTING.md)：开发环境、变更方式和质量门禁。
- [docs/architecture.md](docs/architecture.md)：真实架构、数据流和必须保持的行为。
- [docs/testing.md](docs/testing.md)：自动化与人工测试矩阵。
- [docs/quality.md](docs/quality.md)：缺陷分级、回归闭环和持续改进机制。
- [docs/release.md](docs/release.md)：Windows 发布清单。
- [SECURITY.md](SECURITY.md)：数据生命周期、安全边界和报告策略。
- [CHANGELOG.md](CHANGELOG.md)：版本历史与用户可感知变化。
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：随安装包分发的第三方组件许可证。

## 隐私与发布边界

剪贴板历史默认只写入本机 SQLite，不包含遥测或云端同步；数据库目前没有由 QuickPaste 提供的应用层加密。自动检查更新只访问固定的公开 GitHub Releases API，并发送常规网络元数据与 `QuickPaste/<version>` User-Agent，不上传剪贴板、设置或设备标识。屏幕捕获保护默认关闭，以保证截图工具可正常捕获界面；开启后窗口可能在部分截图或共享中隐藏或显示空白。屏幕捕获排除和敏感应用识别都是尽力而为的防护，不应被表述为 DRM 或绝对防泄漏能力。

当前包标记为私有并禁止发布到 npm/crates.io。仓库尚未选择开源许可证，因此源码公开可见不等于获得开源许可；在明确许可证前保留全部权利。

## 后续方向

优先补齐 HTML/文件等更多剪贴板格式、标签与集合、大历史全文索引、更多语言和崩溃诊断；云同步仅在有明确需求时再设计，并必须默认关闭且端到端加密。
