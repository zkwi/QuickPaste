# QuickPaste v0.21.0 Clipboard Lifecycle and Bilingual README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining clipboard lifecycle gap, establish regression coverage for equivalent ordering defects, replace the oversized Chinese project overview with a task-oriented README, add a semantically equivalent English README, and publish QuickPaste 0.21.0.

**Architecture:** Keep the existing `clipboard-win` and `arboard` division. Add one small lifecycle helper for the sensitive-history early return so every terminal sequence observation happens after the explicit Windows clipboard guard is released. Extend the existing version-governance script to treat both README files as versioned release surfaces. Do not broaden paste authorization, replace clipboard libraries, or change persisted data.

**Tech Stack:** Vue 3, TypeScript, Vitest, Tauri 2, Rust, Node.js test runner, PowerShell, GitHub CLI.

## Global Constraints

- Windows remains the only delivery platform; publish one current-user NSIS installer and one portable ZIP.
- Do not use Computer Use.
- The normal application remains unprivileged; elevated paste keeps the existing one-shot helper and exact sequence checks.
- Follow RED–GREEN for both the Rust lifecycle boundary and README governance.
- Keep `README.md` as the default Chinese landing page and add `README.en.md` with the same factual scope.
- Product version is exactly `0.21.0` in npm, Cargo, Tauri, README links, CHANGELOG, release notes, and verification records.
- Pause the installed QuickPaste process while real Windows clipboard tests and installation checks run; restore the released candidate afterward.

---

### Task 1: Prove and fix the sensitive-history early-return lifecycle

**Files:**
- Modify: `src-tauri/src/clipboard_formats.rs`

**Interfaces:**
- Add: `ignored_package_after_guard<G>(guard: G, before: Option<u64>, observe_after: impl FnOnce() -> Option<u64>) -> PackageReadOutcome`
- Consume: the existing `read_format_package` sensitive-history exclusion branch.
- Preserve: `PackageReadOutcome::Ignored` only when pre/post sequence values are equal; otherwise return `Retryable`.

- [ ] **Step 1: Add the failing lifecycle test**

Add a unit test next to `file_metadata_runs_only_after_guard_drop_and_stable_sequence_observation`. Use a drop probe backed by `Rc<Cell<bool>>`; the observation closure must assert that the probe is no longer open. Call the not-yet-implemented helper with equal sequences and assert an ignored empty package with the observed sequence.

```rust
#[test]
fn excluded_history_observes_sequence_only_after_guard_drop() {
    struct GuardProbe(Rc<Cell<bool>>);

    impl Drop for GuardProbe {
        fn drop(&mut self) {
            self.0.set(false);
        }
    }

    let open = Rc::new(Cell::new(true));
    let outcome = ignored_package_after_guard(
        GuardProbe(open.clone()),
        Some(41),
        || {
            assert!(!open.get(), "sequence observed before clipboard guard drop");
            Some(41)
        },
    );

    assert!(matches!(
        outcome,
        PackageReadOutcome::Ignored {
            package,
            sequence: Some(41)
        } if package == FormatPackage::default()
    ));
}
```

- [ ] **Step 2: Run the targeted test and verify RED**

Stop the installed QuickPaste process if it is running, then run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml excluded_history_observes_sequence_only_after_guard_drop -- --exact --nocapture
```

Expected: compilation fails because `ignored_package_after_guard` does not exist yet. This proves that the intended lifecycle boundary is not represented by production code.

- [ ] **Step 3: Implement the minimal post-drop helper**

Place the helper near `read_package_with_guard`:

```rust
fn ignored_package_after_guard<G>(
    guard: G,
    before: Option<u64>,
    observe_after: impl FnOnce() -> Option<u64>,
) -> PackageReadOutcome {
    drop(guard);
    let after = observe_after();
    if after == before {
        PackageReadOutcome::Ignored {
            package: FormatPackage::default(),
            sequence: after,
        }
    } else {
        PackageReadOutcome::Retryable
    }
}
```

Replace the sensitive-history branch in `read_format_package` so it passes the live guard, `before`, and `seq_num` closure into this helper. Do not alter the ordinary read path or any paste authorization check.

- [ ] **Step 4: Run the lifecycle tests and verify GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml excluded_history_observes_sequence_only_after_guard_drop -- --exact --nocapture
cargo test --manifest-path src-tauri/Cargo.toml file_metadata_runs_only_after_guard_drop_and_stable_sequence_observation -- --exact --nocapture
cargo test --manifest-path src-tauri/Cargo.toml windows_writer_round_trips_chrome_style_multiblock_html_before_paste -- --exact --nocapture
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected: all three tests pass, including the real Windows multi-block HTML round trip.

### Task 2: Audit equivalent clipboard paths and codify the invariant

**Files:**
- Modify: `docs/architecture.md`
- Verify: `src-tauri/src/lib.rs`
- Verify: `src-tauri/src/clipboard_formats.rs`

**Interfaces:**
- Document: `clipboard-win` guards must close before sequence observations used as stable terminal state.
- Preserve: `arboard` operations complete their system access before the method returns.

- [ ] **Step 1: Re-scan all sequence observations**

Run:

```powershell
rg -n "seq_num|Clipboard::new|Clipboard::new_attempts|verified_clipboard_sequence|read_package_with_guard|write_format_package" src-tauri/src
```

Classify each result as explicit `clipboard-win` lifetime, completed `arboard` call, or paste-time comparison. Confirm no other explicit guard observes a terminal sequence before release.

- [ ] **Step 2: Add the architecture invariant**

In the clipboard architecture section, state that:

- explicit Windows clipboard guards own `OpenClipboard` / `CloseClipboard`;
- a sequence used for deduplication, write verification, or paste authorization is stable only after the guard is dropped;
- `arboard` method return marks the end of its individual system access;
- a sequence change during readback produces retry/failure, never permissive paste.

- [ ] **Step 3: Run relevant native regressions**

Run the clipboard-focused Rust tests plus direct/elevated paste sequence tests identified by `cargo test -- --list`. Expected: no test weakens exact sequence matching or converts changes into success.

### Task 3: Add a bilingual README release contract using TDD

**Files:**
- Modify: `scripts/check-versions.test.mjs`
- Modify: `scripts/check-versions.mjs`

**Interfaces:**
- Extend `readProjectMetadata(root)` with `readme` and `readmeEnglish`.
- Require both READMEs to link to each other.
- Require both READMEs to contain `https://github.com/zkwi/QuickPaste/releases/tag/v${expectedVersion}`.

- [ ] **Step 1: Write the failing governance test**

Extend `validMetadata()` with:

```js
const cnReadme = "[English]" + "(README.en.md)\n[v0.1.0](https://github.com/zkwi/QuickPaste/releases/tag/v0.1.0)";
const enReadme = "[简体中文]" + "(README.md)\n[v0.1.0](https://github.com/zkwi/QuickPaste/releases/tag/v0.1.0)";
```

Assign these strings to the `readme` and `readmeEnglish` fields of `validMetadata()`. Add a test that first confirms the fixture is valid, then independently removes each reciprocal link and changes each release URL to `v0.0.9`. Assert the returned issues name the affected file and the exact missing contract.

- [ ] **Step 2: Run the Node test and verify RED**

Run:

```powershell
node --test scripts/check-versions.test.mjs
```

Expected: the new negative assertions fail because `validateProjectMetadata` ignores README content.

- [ ] **Step 3: Implement the minimal README checks**

Read `README.md` and `README.en.md` in `readProjectMetadata`. In `validateProjectMetadata`, append clear issues when:

```js
!metadata.readme.includes("(README.en.md)")
!metadata.readmeEnglish.includes("(README.md)")
!metadata.readme.includes(expectedReleaseUrl)
!metadata.readmeEnglish.includes(expectedReleaseUrl)
```

Treat missing README text as an empty string so the script emits governance issues instead of an opaque type error.

- [ ] **Step 4: Run governance tests and verify GREEN**

Run:

```powershell
node --test scripts/check-versions.test.mjs
npm run check:versions
```

Expected: unit tests and live project validation pass after the README/version work in Task 4.

### Task 4: Rewrite the Chinese README and add the English README

**Files:**
- Modify: `README.md`
- Create: `README.en.md`

**Interfaces:**
- Chinese switch: an `English` link targeting repository-root `README.en.md`, followed by plain `简体中文`.
- English switch: plain `English`, followed by a `简体中文` link targeting repository-root `README.md`.
- Current release link in both files: `[v0.21.0](https://github.com/zkwi/QuickPaste/releases/tag/v0.21.0)`
- Preserve screenshots: `docs/product-preview/quick-panel.png`, `docs/product-preview/settings.png`

- [ ] **Step 1: Replace the Chinese landing page**

Use this section order:

1. Language switch, `QuickPaste（闪电剪贴板）`, one-sentence local-first positioning, current release.
2. “快速开始”: download the NSIS or portable ZIP, launch, copy, press `Ctrl + Shift + V`, search/select, paste.
3. “界面预览”: quick panel and settings screenshots.
4. “核心能力”: six compact groups—retrieval, native formats, dependable Windows paste, local data, OCR/QR, management/update.
5. “常用快捷键”: global open, navigation, paste, search focus, pin/delete/undo, preview, settings.
6. “安装与数据”: current-user NSIS, portable folder, database/settings/log locations, migration behavior, WebView2 runtime.
7. “隐私与安全”: local-first, no sync/telemetry, no clipboard payload in logs, helper boundary, explicit non-goals.
8. “开发”: `npm ci`, `npm run dev`, `npm run check`, `npm run build:windows`.
9. “项目结构与深入文档”: architecture, testing, security, changelog, release notes.
10. “许可证”: current project license state and third-party notices.

Keep implementation details in linked documentation rather than restoring the previous long flat capability list.

- [ ] **Step 2: Write the English landing page**

Use the identical section order and facts with natural English headings: Quick Start, Screenshots, Core Capabilities, Keyboard Shortcuts, Installation and Data, Privacy and Security, Development, Project Layout and Documentation, License. Do not translate product boundaries into broader claims.

- [ ] **Step 3: Check links and semantic parity**

Run:

```powershell
node scripts/check-repository.mjs
node scripts/check-privacy.mjs
node scripts/check-versions.mjs
```

Manually compare both heading sequences, shortcut rows, paths, version links, privacy boundaries, and build commands.

### Task 5: Synchronize v0.21.0 metadata and release documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `CHANGELOG.md`
- Modify: `docs/release.md`
- Create: `docs/releases/v0.21.0.md`
- Create: `docs/releases/v0.21.0-verification.md`
- Regenerate: third-party notice hash metadata required by repository checks.

**Interfaces:**
- Produce synchronized `0.21.0` product metadata.
- Release notes describe the post-close lifecycle invariant, sensitive-history early-return fix, bilingual README, governance check, compatibility, and remaining real-machine scope.

- [ ] **Step 1: Bump only the QuickPaste product version**

Use the existing repository version-update process to change `0.20.2` to `0.21.0` across npm, Cargo, Tauri, lockfiles, and README Release links. Do not update unrelated dependencies.

- [ ] **Step 2: Update changelog and release instructions**

Add a `0.21.0` entry with Added/Changed/Fixed/Testing facts. Update release procedure text only where the bilingual README contract or artifact verification requires it.

- [ ] **Step 3: Write release and verification records**

The release notes must include:

- lifecycle cause and fixed early-return ordering;
- multi-block rich-text Windows regression coverage;
- audited paths that intentionally remain unchanged;
- bilingual documentation and version contract;
- unchanged data/settings compatibility and security boundaries.

The verification record starts with exact commands and local results, then receives artifact filenames, byte counts, SHA-256 values, GitHub IDs/digests, authenticated/public download checks, and asynchronous CI URL/status during Task 7. Real-machine long-cycle observations stay explicitly `pending real-machine`.

- [ ] **Step 4: Run metadata and repository gates**

Run:

```powershell
npm run check:versions
npm run check:repository
npm run check:privacy
npm run check:licenses
git diff --check
```

Expected: every command exits 0 and no real clipboard content, screenshot, database, log, secret, or build output is tracked.

### Task 6: Full local verification and Windows artifact build

**Files:**
- Update: `docs/releases/v0.21.0-verification.md`

**Interfaces:**
- Produce: one x64 NSIS installer and one portable ZIP containing `QuickPaste.exe` plus four notice files.

- [ ] **Step 1: Run clean dependency and project gates**

Run:

```powershell
npm ci
npm run check
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
cargo audit --file src-tauri/Cargo.lock
```

Expected: project gates exit 0. Record any allowed RustSec warning separately without calling it a pass when it is not.

- [ ] **Step 2: Build Windows deliverables**

Run:

```powershell
npm run build:windows
```

Expected: x64 application and current-user NSIS complete successfully; the project packaging script creates the portable ZIP.

- [ ] **Step 3: Validate local artifacts**

Verify:

- PE machine is `0x8664`;
- product/file version is `0.21.0`;
- signing state is accurately recorded;
- exactly one NSIS installer and one portable ZIP are selected;
- ZIP contains exactly `QuickPaste.exe` and the four expected notice files;
- byte counts and SHA-256 hashes are recorded;
- a local install/uninstall and installed launch check succeeds without changing user clipboard data.

- [ ] **Step 4: Review the release diff**

Run:

```powershell
git status --short
git diff --stat
git diff --check
git diff -- src-tauri/src/clipboard_formats.rs scripts/check-versions.mjs scripts/check-versions.test.mjs README.md README.en.md
```

Confirm only v0.21.0 work is included and no generated artifact is staged.

### Task 7: Commit, push, publish, verify, and clean merged branches

**Files:**
- Update: `docs/releases/v0.21.0-verification.md`

**Interfaces:**
- Produce: pushed `main`, annotated tag `v0.21.0`, public Latest GitHub Release, and final verification commit.

- [ ] **Step 1: Commit the implementation**

Stage only reviewed source, tests, docs, and metadata. Commit with a concise Simplified Chinese message such as:

```text
完善剪贴板生命周期并发布 v0.21.0
```

- [ ] **Step 2: Push source and create the release tag**

Push `main`, create annotated tag `v0.21.0` at the release commit, and push the tag. Verify remote refs point at the expected commits before uploading assets.

- [ ] **Step 3: Create a draft Release and verify authenticated downloads**

Create the GitHub Release as draft/non-prerelease with `docs/releases/v0.21.0.md`. Upload only the reviewed NSIS and portable ZIP. Download both through authenticated GitHub access and compare names, bytes, SHA-256, and GitHub digest against local values.

- [ ] **Step 4: Publish Latest and verify public downloads**

Publish the Release as non-draft/non-prerelease/Latest. Download both assets anonymously, compare hashes again, record release/asset IDs and the current asynchronous GitHub Actions URL/status, then commit and push the completed verification record.

- [ ] **Step 5: Audit and remove merged obsolete branches**

List local and remote branches, identify only branches fully merged into `main` and already represented by the release, protect `main` and the active branch, delete obsolete local branches, then delete corresponding remote branches. Re-list refs and confirm `main`, the release tag, and required long-lived branches remain.
