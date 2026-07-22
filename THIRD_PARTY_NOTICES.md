# 第三方软件声明

QuickPaste 自身当前为 `UNLICENSED`、保留全部权利；下列许可证只适用于对应第三方组件，不会把 QuickPaste 变成开源软件。

Windows x64 安装包随附以下完整、锁文件驱动的第三方清单和许可证原文：

- [npm production 依赖](THIRD_PARTY_LICENSES_NPM.md)：28 个包；`package-lock.json` SHA-256 `3ABC82AB047F2104AD95AF225783D0160C3FD47B78542AD0CCCA62AFF0E97936`。
- [Rust Windows normal/build 依赖](THIRD_PARTY_LICENSES_RUST.md)：316 个第三方 crate；`src-tauri/Cargo.lock` SHA-256 `CC702F56E96238E295D638BF541860DD2B621EA76FA45698E00C974ADE1040F0`。
- [原生安装与数据库组件](THIRD_PARTY_LICENSES_NATIVE.md)：NSIS 3.11（含 LZMA special exception）和 bundled SQLite 3.50.2 public-domain blessing。

常规质量门禁会把以上组件表与 npm production dependency closure、Windows Cargo normal/build 图、两个锁文件哈希和 Tauri bundle resources 逐项核对；依赖变化而声明未更新时构建检查会失败。

## MPL-2.0 组件源码

候选包使用以下未修改、来自 crates.io registry 的 MPL-2.0 组件；仓库没有对它们使用 Cargo patch 或 git override。精确 Source Code Form 可由下列版本化地址取得：

- [`cssparser 0.36.0`](https://crates.io/api/v1/crates/cssparser/0.36.0/download)
- [`cssparser-macros 0.6.1`](https://crates.io/api/v1/crates/cssparser-macros/0.6.1/download)
- [`dtoa-short 0.3.5`](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download)
- [`option-ext 0.2.0`](https://crates.io/api/v1/crates/option-ext/0.2.0/download)
- [`selectors 0.36.1`](https://crates.io/api/v1/crates/selectors/0.36.1/download)

## WebView2 安装边界

核心安装包不嵌入 Microsoft Edge WebView2 Runtime 或其 bootstrapper。目标机缺少 Runtime 时，NSIS 安装流程按照 [Microsoft Evergreen WebView2 分发方式](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) 从 Microsoft URL 下载 bootstrapper，再由 Microsoft 安装对应架构的 Runtime。

## 生成方式

npm 与原生声明使用仓库内标准库脚本生成：

```powershell
npm run licenses:npm
npm run licenses:rust
npm run licenses:native
```

Rust 声明使用固定发布工具 `cargo-about 0.9.1`、[`src-tauri/about.toml`](src-tauri/about.toml) 和 [`scripts/licenses/rust-notices.hbs`](scripts/licenses/rust-notices.hbs) 生成；三个脚本都会把上游许可证正文规范化为 LF、移除行尾空格并保留单一末尾换行。`cargo-about` 只是发布期工具，不属于 QuickPaste 的运行时或构建依赖。
