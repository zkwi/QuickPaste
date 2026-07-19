# 参与 QuickPaste 开发

QuickPaste（闪电剪贴板）是 Windows 优先的个人桌面项目。每次修改应容易理解、容易验证，并且不能把真实剪贴板数据带入仓库。

## 准备环境

- Windows 10/11 x64。
- Node.js：见 `.nvmrc`；npm 见 `package.json` 的 `packageManager`，依赖必须使用仓库中的 `package-lock.json`。
- Rust：通过 rustup 安装 MSVC target；仓库版本与组件见 `rust-toolchain.toml`。
- Microsoft C++ Build Tools，选择“Desktop development with C++”并安装 Windows SDK。
- Microsoft Edge WebView2 Runtime。

安装细节以 [Tauri Windows 前置要求](https://v2.tauri.app/start/prerequisites/) 为准。本项目只构建 NSIS，因此不需要为 MSI 启用 VBSCRIPT/WiX。

先确认 `npm --version` 与 `package.json` 的 `packageManager` 一致；不一致时使用系统 npm 在全局模式安装声明版本。随后安装依赖并启动桌面开发环境：

```powershell
npm ci
npm run tauri dev
```

## 统一质量门禁

```powershell
npm run check
```

该命令依次执行：

1. 治理脚本单元测试。
2. 版本、NSIS、工具链和 Tauri 窗口权限契约检查。
3. 候选文件、敏感文件、单文件体积和 Markdown 相对链接检查。
4. 公共仓库隐私扫描，拦截个人路径、邮箱、Token、数据库、日志、截图和构建产物。
5. 前端 Vitest、TypeScript 检查与生产构建。
6. Rustfmt、Clippy（警告视为错误）和 Rust 单元测试。

常用单项命令：

- `npm test`：运行前端测试。
- `npm run test:watch`：监听前端测试。
- `npm run test:governance`：运行仓库治理脚本测试。
- `npm run check:repository`：检查仓库卫生和文档链接。
- `npm run check:privacy`：检查公开内容是否可能泄露个人或用户数据。
- `npm run build`：TypeScript 检查与前端生产构建。
- `npm run check:rust`：Rust 完整质量检查。
- `npm run format:rust`：格式化 Rust 代码。
- `npm run build:windows`：生成 NSIS 候选安装包。

自动化覆盖范围与需要人工检查的 Windows 场景见 [docs/testing.md](docs/testing.md)，缺陷分级和回归闭环见 [docs/quality.md](docs/quality.md)。

## 版本定级

- 新功能、显著 UI/交互调整，或一组用户可感知的体验改进，默认提升 minor 版本。
- patch 只用于范围明确、不会改变主要流程或布局结构的修复。
- 同一版本按影响最高的变更定级；`1.0.0` 前的破坏性变化至少提升 minor，并记录迁移影响。

## 代码边界

- 可独立测试且不依赖 UI 的规则放在 `src/domain/`。
- Tauri IPC 或浏览器/系统能力适配放在 `src/platform/`。
- `App.vue` 只保留界面状态与生命周期编排；不要继续堆入纯搜索、解析或迁移规则。
- Windows、SQLite、全局快捷键和输入模拟保留在 Rust 原生层。
- 新抽象必须解决当前重复或测试困难，不为假设需求预建框架。

## 变更方式

1. 从 `main` 创建短生命周期分支，例如 `feature/search-ranking` 或 `fix/popup-position`。
2. 每次只解决一个明确问题，避免顺手升级依赖或格式化无关文件。
3. 行为变更先增加会失败的回归测试，再实施最小修复。
4. 提交信息建议使用 `feat:`、`fix:`、`test:`、`docs:`、`refactor:`、`chore:` 前缀。
5. 合并前运行 `npm run check`；涉及 UI、原生窗口或安装时执行对应人工矩阵。
6. 仅在 `CHANGELOG.md` 的 `Unreleased` 下记录用户可感知变化。

提交、推送、标签和发布必须由维护者明确发起；自动化或协作者不得自行执行。

## 数据与安全

- 测试只能使用构造数据，禁止提交真实剪贴板、聊天记录、用户名、本机路径截图或数据库。
- 不得提交 `.env`、私钥、PFX/P12/PVK、代码签名口令、SQLite/WAL/SHM 或管理员授权材料。
- 原生层失败必须安全降级，不能静默扩大权限或用空历史覆盖已有数据。
- 屏幕捕获排除与敏感应用识别都是尽力防护，文案和测试不得扩大其安全承诺。
- 发布前遵循 [docs/release.md](docs/release.md)，核对未签名状态、SHA-256、安装包大小和公开历史隐私扫描结果。

更多项目约束见 [AGENTS.md](AGENTS.md) 和 [docs/architecture.md](docs/architecture.md)。
