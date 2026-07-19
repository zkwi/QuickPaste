# 安全策略

QuickPaste（闪电剪贴板）会接触高敏感度的剪贴板数据。安全问题优先于功能便利性。

## 支持与报告状态

请通过 [GitHub Private Vulnerability Reporting](https://github.com/zkwi/QuickPaste/security/advisories/new) 私密提交安全问题。维护者目标是在 7 个自然日内首次响应；不要使用公开 Issue 披露尚未修复的漏洞，也不要发送真实剪贴板内容。

报告应只包含脱敏复现步骤、影响范围、Windows 版本和 QuickPaste 版本。数据库、日志、用户名、本机路径、聊天记录和签名材料不得作为附件直接发送。

当前维护 `main` 与最新的 `0.1.x` 预发布版本；更早候选版本不保证获得安全修复。

## 数据生命周期

- 桌面端历史写入 Tauri 应用数据目录中的 `history.sqlite3`，Windows 上通常位于 `%APPDATA%\com.quickpaste.desktop\`；同时可能存在 `history.sqlite3-wal` 和 `history.sqlite3-shm`。
- 文本和元数据存为 SQLite 中的 JSON，图片主体存为 BLOB。QuickPaste 当前不提供应用层数据库加密。
- 主题、语言、快捷键等轻量 UI 偏好保存在 WebView localStorage；浏览器演示模式也会把构造历史写入 localStorage。
- 默认没有遥测、云同步或剪贴板网络上传。自动检查更新会访问固定的 GitHub Releases API；安装器在机器缺少 WebView2 Runtime 时会使用 Microsoft 在线 Bootstrapper 下载运行时。
- 当前用户范围的 NSIS 卸载不承诺删除历史。需要彻底清理时，应先退出 QuickPaste，再删除应用数据目录中的 `history.sqlite3`、`history.sqlite3-wal` 和 `history.sqlite3-shm`；操作前自行确认是否需要备份。

## 安全不变量

- 主程序保持普通用户权限，检测到管理员权限时必须提示并退出；管理员窗口粘贴只能使用短时、单用途授权 helper。目标请求不得写入文件或命令行，主进程与 helper 必须通过本地命名管道核对双方 PID、权限状态和可执行文件身份后再传输请求。请求还必须绑定写入后已读回验证的剪贴板序列，helper 在输入注入前失败关闭地重复核对。
- 读取、保存或迁移失败时保护已有历史，不得以空数据覆盖。
- 持久化历史进入 UI 前必须通过运行时 schema 校验；损坏或重复记录不得静默混入。
- 粘贴目标失效、焦点恢复失败、UAC 取消或权限不足时必须安全降级为保留可手动粘贴的副本。
- 签名密钥、证书、环境变量、SQLite/WAL/SHM 和真实用户数据不得进入 Git。
- 自动更新只允许固定仓库、严格 NSIS 文件名、HTTPS、大小上限与 GitHub SHA-256 摘要校验；只自动检查，下载和安装必须由用户明确点击。SHA-256 不是发布者签名，GitHub 账户或 Release 同时失陷仍属于已接受风险。

## 尽力防护的限制

- 敏感应用排除依赖 Windows 能提供的剪贴板所有者和应用名，不能保证识别所有密码框、浏览器子进程或快速切换场景。
- 屏幕捕获排除使用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`。该值从 Windows 10 2004 起受支持，只对部分系统捕获路径有效；微软明确说明它不是严格内容保护或 DRM。参见 [Microsoft SetWindowDisplayAffinity 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)。
- 管理员窗口自动粘贴仍依赖目标复核、焦点切换和系统输入链路，不能保证所有第三方应用都接受模拟输入。

发布前必须完成 [docs/release.md](docs/release.md) 中的完整性、安全降级和数据生命周期验收。
