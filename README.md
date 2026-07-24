[English](README.en.md) | 简体中文

# QuickPaste（闪电剪贴板）

QuickPaste 是一款面向 Windows 10/11 x64 的本地优先剪贴板历史工具。按下 `Ctrl + Shift + V`，即可在当前输入位置附近搜索历史并粘贴文本、富文本、图片或文件。

当前版本：[v0.21.1](https://github.com/zkwi/QuickPaste/releases/tag/v0.21.1) · [更新记录](CHANGELOG.md)

## 快速开始

1. 从 [v0.21.1 Release](https://github.com/zkwi/QuickPaste/releases/tag/v0.21.1) 下载 Windows x64 NSIS 安装包或绿色版 ZIP。
2. 运行安装包，或把绿色版解压到可写目录后启动 `QuickPaste.exe`。
3. 正常复制文本、富文本、图片或文件。
4. 在目标输入框中按 `Ctrl + Shift + V`，输入关键词、拼音或来源，选择记录后按 `Enter` 粘贴。

首次启动会提供可跳过的快捷粘贴练习。关闭主窗口后，QuickPaste 默认留在系统托盘继续记录。

## 界面预览

### 快速面板

![闪电剪贴板快速面板](docs/product-preview/quick-panel.png)

### 设置页面

![闪电剪贴板设置页面](docs/product-preview/settings.png)

## 核心能力

### 快速检索

- 使用 SQLite FTS5 搜索正文、中文子串、拼音/首字母、OCR、文件名和来源应用。
- 支持文本、代码、链接、图片、文件、集合和固定状态组合筛选。
- 输入 `@` 选择来源应用；输入 `;` 或 `；` 只看永久片段。
- 结果按稳定游标分页，大正文、原图、HTML 和 RTF 只在预览或粘贴时加载。

### 原生格式

- 捕获 Windows 文本、HTML/RTF 富文本、图片和 `CF_HDROP` 文件/多文件列表。
- 同一条富文本记录同时保留纯文本、HTML 与 RTF，可选择保留格式或纯文本粘贴。
- 图片和文件按原生类型写回；文件记录只保存路径与元数据，不复制文件正文。
- 对超限或不可安全持久化的格式明确省略，不把不透明 OLE 对象写入数据库。

### 可靠的 Windows 粘贴

- 唤起时记录目标顶层窗口和实际输入焦点子窗口，面板优先靠近文本插入点显示。
- 粘贴前回读内容并校验稳定的 Windows 剪贴板序列；内容或序列变化时停止自动回贴并保留手动 `Ctrl + V` 副本。
- 兼容 Codex 等输入界面由协作进程承载的桌面应用。
- 管理员窗口仅使用带时限、进程互认、绑定目标和剪贴板版本的一次性 UAC helper；主程序始终保持普通用户权限。

### 本地数据与管理

- 历史、固定项、永久文本/代码片段、集合、OCR 结果和搜索索引保存在本机 SQLite。
- 支持固定、删除、撤销、跨页批量操作、保留期限、数量和图片容量限制。
- 提供安全压缩、SQLite 备份、原子恢复和损坏数据库隔离恢复。
- 安装版与绿色版都把历史数据库放在 `QuickPaste.exe` 同级的 `data` 目录，便于显式迁移。

### 本地识别与类型化动作

- 使用 Windows 已安装语言执行本地图片 OCR，不下载模型，也不上传图片或识别文字。
- 在本机识别二维码；只有通过校验的 HTTP/HTTPS 地址才提供系统打开入口。
- 链接、图片和文件提供明确的打开、另存或定位操作，并在 Rust 边界重新校验。
- 代码预览按需加载语法高亮模块，失败或超限时回退为转义纯文本。

### 日常工作流

- 浅色/深色主题、紧凑面板、中文/英文界面、管理页、设置页和系统托盘。
- 支持暂停/恢复记录、开机静默启动、单实例唤回、敏感应用排除和可选屏幕捕获保护。
- 每天第一次启动时静默检查 GitHub Release；设置页和托盘也可随时手动检查。
- 新版安装包下载后会核对 GitHub 提供的 SHA-256 摘要，再启动当前用户范围的 NSIS 安装。

## 常用快捷键

| 操作 | 快捷键 |
| --- | --- |
| 打开快速面板 | `Ctrl + Shift + V`（可在设置中修改） |
| 移动选择 | `↑` / `↓`，`Page Up` / `Page Down` |
| 粘贴当前记录 | `Enter` 或双击 |
| 直接粘贴第 1–10 条 | `Alt + 1…0` 或 `Ctrl + 1…0` |
| 预览当前记录 | `Space` |
| 聚焦快速搜索 | `Ctrl + K` |
| 打开管理页 | `Ctrl + L` |
| 暂停或恢复记录 | `Ctrl + P` |
| 清除当前条件、关闭预览或返回 | `Esc` |
| 管理页搜索 | `Ctrl + F` 或 `Ctrl + K` |
| 管理页删除当前记录 | `Delete` |

键盘交互会避开中文输入法组合态；快捷键录制区会提示常见粘贴组合冲突。

## 安装与数据

- **系统要求：** Windows 10/11 x64 与 Microsoft Edge WebView2 Runtime。
- **安装版：** NSIS 只安装到当前用户范围，不请求把主程序永久提升为管理员。
- **绿色版：** 解压到当前用户可写目录后运行，首次启动会创建同级 `data` 目录。
- **历史文件：** `data\history.sqlite3`，运行期间可能同时存在 SQLite 的 `-wal` 和 `-shm` 文件。
- **迁移：** 完全退出 QuickPaste 后复制整个 `data` 目录。该目录包含历史、集合、永久片段和 OCR 数据；主题、语言、快捷键等界面偏好由当前 WebView 配置保存，需要在新环境重新确认。
- **WebView2：** 安装器使用在线 Bootstrapper；目标机器缺少 Runtime 时需要访问 Microsoft 下载服务，当前不声明离线安装支持。

## 隐私与安全

- 剪贴板正文、图片、文件路径、OCR 结果和搜索词不上传；项目没有云同步或远程遥测。
- 自动更新只访问固定的公开 GitHub Releases API，并发送常规网络元数据与 `QuickPaste/<version>` User-Agent。
- 普通运行不记录含正文的验收指标；维护者显式启用的隔离验收模式也只允许内容无关的本地计数和耗时。
- 敏感剪贴板标记、敏感应用识别和屏幕捕获保护都属于尽力而为的防护，不能视为 DRM 或绝对防泄漏能力。
- 数据库与导出备份目前没有由 QuickPaste 提供的应用层加密，请自行保护包含敏感历史的文件。

QuickPaste 不提供截图、云 OCR、翻译、代码执行、嵌套集合、标签系统或跨平台版本，也不捆绑 OCR/翻译模型或 FFmpeg。

更多边界与报告方式见 [SECURITY.md](SECURITY.md)。

## 开发

需要 `.nvmrc` 指定的 Node.js、`package.json` 指定的 npm、`rust-toolchain.toml` 指定的 Rust，以及 Microsoft C++ Build Tools、Windows SDK 和 WebView2 Runtime。

```powershell
npm ci
npm run tauri dev
```

运行完整质量门禁：

```powershell
npm run check
```

构建 Windows x64 NSIS 候选包：

```powershell
npm run build:windows
```

`npm run check` 包含治理脚本、版本/隐私/许可证检查、前端测试与构建、Rust 格式检查、Clippy 和 Rust 测试。测试分层见 [docs/testing.md](docs/testing.md)，发布门槛见 [docs/release.md](docs/release.md)。

## 项目结构与文档

- `src/domain/`：纯 TypeScript 的剪贴板、搜索、高亮、动作和快捷键规则。
- `src/platform/`：前端与 Tauri IPC、系统剪贴板、窗口、设置和历史能力之间的适配层。
- `src/App.vue`：快速面板、管理页、设置页、模态框和焦点生命周期编排。
- `src-tauri/`：Tauri 2 + Rust 的 Windows API、SQLite、WinRT OCR、托盘和粘贴实现。
- `scripts/`：版本、隐私、许可证、仓库卫生、构建边界和本地验收检查。

深入阅读：

- [架构与数据流](docs/architecture.md)
- [测试策略](docs/testing.md)
- [质量与缺陷闭环](docs/quality.md)
- [贡献指南](CONTRIBUTING.md)
- [v0.21.1 发布说明](docs/releases/v0.21.1.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

## 许可证

项目当前标记为 `UNLICENSED`，尚未选择开源许可证；源码公开可见不等于获得复制、修改或分发授权。第三方组件按各自许可证使用，完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
