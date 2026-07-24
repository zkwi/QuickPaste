English | [简体中文](README.md)

# QuickPaste

QuickPaste is a local-first clipboard history tool for Windows 10/11 x64. Press `Ctrl + Shift + V` to search your history near the active input and paste text, rich text, images, or files.

Current release: [v0.21.1](https://github.com/zkwi/QuickPaste/releases/tag/v0.21.1) · [Changelog](CHANGELOG.md)

## Quick Start

1. Download the Windows x64 NSIS installer or portable ZIP from the [v0.21.1 Release](https://github.com/zkwi/QuickPaste/releases/tag/v0.21.1).
2. Run the installer, or extract the portable build to a writable folder and launch `QuickPaste.exe`.
3. Copy text, rich text, an image, or one or more files as usual.
4. In the target input, press `Ctrl + Shift + V`, search by text, pinyin, or source, select an item, and press `Enter` to paste.

The first launch offers an optional quick-paste exercise. Closing the main window leaves QuickPaste in the system tray by default so it can keep recording.

## Screenshots

### Quick Panel

![QuickPaste quick panel](docs/product-preview/quick-panel.png)

### Settings

![QuickPaste settings](docs/product-preview/settings.png)

## Core Capabilities

### Fast Retrieval

- Search content, Chinese substrings, pinyin/initials, OCR text, filenames, and source applications through SQLite FTS5.
- Combine text, code, link, image, file, collection, and pinned-state filters.
- Type `@` to choose a source application; type `;` or `；` to show permanent snippets only.
- Results use stable cursor pagination. Large bodies, original images, HTML, and RTF load only for preview or paste.

### Native Formats

- Capture Windows text, HTML/RTF rich text, images, and `CF_HDROP` file lists.
- Keep plain text, HTML, and RTF representations together, with explicit preserve-format and plain-text paste choices.
- Write images and files back as native clipboard types. File entries store paths and metadata, never file contents.
- Mark oversized or unsafe formats as omitted instead of persisting opaque OLE objects.

### Dependable Windows Paste

- Remember both the target top-level window and the actual focused child input, and place the panel near the text caret when Windows exposes one.
- Read content back and verify a stable Windows clipboard sequence before pasting. If content or sequence changes, automatic paste stops while the copied value remains available for manual `Ctrl + V`.
- Support desktop applications such as Codex whose input surface may be hosted by a cooperating process.
- Use a time-limited, mutually authenticated, target- and clipboard-bound one-shot UAC helper for elevated windows. The main process always remains unprivileged.

### Local Data and Management

- Store history, pinned items, permanent text/code snippets, collections, OCR results, and search indexes in local SQLite.
- Support pin, delete, undo, cross-page bulk actions, retention periods, item limits, and image-storage limits.
- Provide safe compaction, SQLite backup, atomic restore, and damaged-database quarantine recovery.
- Keep the history database in a `data` folder beside `QuickPaste.exe` for both installed and portable builds.

### Local Recognition and Typed Actions

- Run image OCR locally with languages already installed in Windows. No model, image, or recognized text is downloaded or uploaded.
- Detect QR codes locally. Only validated HTTP/HTTPS results receive an open-in-system action.
- Offer explicit open, save, or locate actions for links, images, and files, with inputs revalidated at the Rust boundary.
- Load syntax-highlighting language modules on demand and fall back to escaped plain text on failure or oversized content.

### Daily Workflow

- Light/dark themes, compact quick panel, Chinese/English UI, manager, settings, and system tray.
- Pause/resume capture, silent startup, single-instance activation, sensitive-app exclusions, and optional screen-capture protection.
- Check GitHub Releases silently on the first launch of each local day; manual checks remain available from Settings and the tray.
- Verify the downloaded installer against GitHub's SHA-256 digest before launching the current-user NSIS update.

## Keyboard Shortcuts

| Action | Shortcut |
| --- | --- |
| Open the quick panel | `Ctrl + Shift + V` (customizable in Settings) |
| Move selection | `↑` / `↓`, `Page Up` / `Page Down` |
| Paste the selected item | `Enter` or double-click |
| Paste item 1–10 directly | `Alt + 1…0` or `Ctrl + 1…0` |
| Preview the selected item | `Space` |
| Focus quick search | `Ctrl + K` |
| Open the manager | `Ctrl + L` |
| Pause or resume capture | `Ctrl + P` |
| Clear the current condition, close preview, or go back | `Esc` |
| Search in the manager | `Ctrl + F` or `Ctrl + K` |
| Delete the current manager item | `Delete` |

Keyboard handling protects active IME composition. The shortcut recorder also warns about common paste-shortcut conflicts.

## Installation and Data

- **System requirements:** Windows 10/11 x64 and Microsoft Edge WebView2 Runtime.
- **Installed build:** NSIS installs for the current user only and does not keep the main application elevated.
- **Portable build:** Extract to a user-writable folder and run it. The first launch creates a sibling `data` folder.
- **History file:** `data\history.sqlite3`; SQLite `-wal` and `-shm` files may also exist while QuickPaste is running.
- **Migration:** Fully exit QuickPaste, then copy the entire `data` folder. It contains history, collections, permanent snippets, and OCR data. UI preferences such as theme, language, and shortcut live in the current WebView profile and should be confirmed again in a new environment.
- **WebView2:** The installer uses the online Bootstrapper. A machine without the Runtime needs access to Microsoft's download service; offline installation is not currently a supported claim.

## Privacy and Security

- Clipboard bodies, images, file paths, OCR results, and search terms stay local. The project has no cloud sync or remote telemetry.
- Automatic update checks access only the fixed public GitHub Releases API and send ordinary network metadata plus a `QuickPaste/<version>` User-Agent.
- Normal use records no content-bearing acceptance metrics. Maintainer-enabled isolated acceptance mode allows only content-free local counters and timings.
- Sensitive clipboard flags, sensitive-app recognition, and screen-capture protection are best-effort safeguards, not DRM or an absolute data-loss-prevention guarantee.
- QuickPaste does not currently provide application-layer encryption for its database or exported backups. Protect files that contain sensitive history.

QuickPaste does not provide screenshots, cloud OCR, translation, code execution, nested collections, tags, or cross-platform builds, and it does not bundle OCR/translation models or FFmpeg.

See [SECURITY.md](SECURITY.md) for the full boundary and reporting process.

## Development

Development requires the Node.js version in `.nvmrc`, the npm version in `package.json`, the Rust toolchain in `rust-toolchain.toml`, Microsoft C++ Build Tools, Windows SDK, and WebView2 Runtime.

```powershell
npm ci
npm run tauri dev
```

Run the complete quality gate:

```powershell
npm run check
```

Build the Windows x64 NSIS candidate:

```powershell
npm run build:windows
```

`npm run check` covers governance tests, version/privacy/license checks, frontend tests and production build, Rust formatting, Clippy, and Rust tests. See [docs/testing.md](docs/testing.md) for test layers and [docs/release.md](docs/release.md) for release gates.

## Project Layout and Documentation

- `src/domain/`: pure TypeScript clipboard, search, highlighting, action, and shortcut rules.
- `src/platform/`: adapters between the frontend and Tauri IPC, system clipboard, windows, settings, and history.
- `src/App.vue`: orchestration for the quick panel, manager, settings, dialogs, and focus lifecycle.
- `src-tauri/`: Tauri 2 + Rust implementation for Windows APIs, SQLite, WinRT OCR, tray, and paste.
- `scripts/`: version, privacy, license, repository hygiene, build-boundary, and local acceptance checks.

Further reading:

- [Architecture and data flow](docs/architecture.md)
- [Testing strategy](docs/testing.md)
- [Quality and defect lifecycle](docs/quality.md)
- [Contributing guide](CONTRIBUTING.md)
- [v0.21.1 release notes](docs/releases/v0.21.1.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

The project is currently marked `UNLICENSED` and has not selected an open-source license. Publicly visible source code does not by itself grant permission to copy, modify, or distribute it. Third-party components remain under their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete notices.
