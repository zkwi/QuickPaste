# Day-Based History Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release QuickPaste v0.22.0 with ordinary clipboard history limited only by 7, 30, or 90-day retention, while preserving pinned/permanent items and the existing image-byte capacity protection.

**Architecture:** Keep `maxRecords` / `max_records` in TypeScript, IPC, SQLite, statistics, and backups as a compatibility field, but canonicalize it to `9_007_199_254_740_991` at every settings boundary and remove count-based deletion from native pruning. Treat legacy `retentionDays = null` as a grandfathered current-only state so upgrading or restoring never silently deletes data; the settings UI can leave that state only through the existing confirmed finite-retention mutation.

**Tech Stack:** Vue 3, TypeScript, Vitest, Tauri 2, Rust, SQLite/rusqlite, PowerShell, Playwright, GitHub CLI.

## Global Constraints

- Windows is the only delivery platform; keep the existing platform adapter and one-time elevated paste helper.
- Use settings schema `7`, native database schema `13`, and release version `0.22.0`.
- Canonical unlimited compatibility value is exactly `9_007_199_254_740_991` (`Number.MAX_SAFE_INTEGER`).
- New installations default to `30` retention days and `256 MiB` image logical capacity.
- The settings UI offers only `7`, `30`, and `90` days; legacy `null` is displayed only while it remains the current policy.
- Pinned records and permanent snippets are exempt from time and image-capacity pruning.
- Preserve existing image-capacity values during upgrades and restores; do not add custom-day controls or new dependencies.
- Keep `maxRecords` / `max_records` in settings, IPC, SQLite, statistics, and backup contracts.
- Package only Windows x64 NSIS plus the existing portable ZIP; do not reintroduce MSI.
- Do not commit clipboard databases, logs, screenshots, build products, signing material, or real user content.
- Run `npm ci`, `npm run check`, and `npm run build:windows` before publishing.
- Record unexecuted physical-machine endurance checks as `pending real-machine`.

---

## File Map

- `src/domain/settings.ts`: owns settings schema, defaults, strict parsing, and the canonical compatibility value.
- `src/domain/settings.test.ts`: proves default and legacy policy normalization.
- `src/domain/clipboard.ts`: keeps the browser/demo retention model; count limiting must no longer participate in application behavior.
- `src/App.vue`: separates the native capture queue bound from history policy and applies finite-retention choices.
- `src/components/SettingsPanel.vue`: renders finite choices plus the current-only legacy state.
- `src/i18n.ts`: supplies Chinese and English retention/migration copy without a 500-record promise.
- `src/App.test.ts`: covers visible options, confirmation cancellation/acceptance, focus, keyboard, and composition regressions.
- `src/App.native-settings.test.ts`: covers IPC normalization, restore adoption, and policy synchronization.
- `src-tauri/src/history.rs`: owns schema migration, policy persistence, native pruning, restore, statistics, and Rust tests.
- `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`: carry version `0.22.0`.
- `README.md`, `README.en.md`, `CHANGELOG.md`, `docs/architecture.md`: document the changed retention contract.
- `docs/release-notes-v0.22.0.md`, `docs/release-verification-v0.22.0.md`: hold publish copy and measured release evidence.

### Task 1: Canonicalize the Frontend Policy Without Unbounding Capture Queues

**Files:**
- Modify: `src/domain/settings.ts`
- Modify: `src/domain/settings.test.ts`
- Modify: `src/App.vue`
- Test: `src/domain/settings.test.ts`
- Test: `src/domain/clipboard.test.ts`

**Interfaces:**
- Produces: `export const UNLIMITED_HISTORY_RECORDS = Number.MAX_SAFE_INTEGER`.
- Produces: `parsePersistedSettings(value: unknown): AppSettings | null` that preserves valid image bytes and `retentionDays`, but always returns the unlimited `maxRecords` value.
- Preserves: `HistoryPolicy` and IPC field names; no nullable count field is introduced.

- [ ] **Step 1: Add failing policy-normalization tests**

Add assertions equivalent to:

```ts
expect(DEFAULT_HISTORY_POLICY).toEqual({
  maxRecords: Number.MAX_SAFE_INTEGER,
  maxImageBytes: 256 * 1024 * 1024,
  retentionDays: 30,
})

expect(parsePersistedSettings({
  schemaVersion: 6,
  historyPolicy: { maxRecords: 500, maxImageBytes: 123456, retentionDays: null },
})?.historyPolicy).toEqual({
  maxRecords: Number.MAX_SAFE_INTEGER,
  maxImageBytes: 123456,
  retentionDays: null,
})
```

Also cover schema `7`, retention days `7`, `30`, and `90`, and rejection of unsafe numeric input.

In `src/domain/clipboard.test.ts`, construct 501 unexpired ordinary text records and assert that applying the default policy's `maxRecords` leaves all 501 records in the browser/demo history:

```ts
const retained = limitHistory(items, DEFAULT_HISTORY_POLICY.maxRecords)
expect(retained).toHaveLength(501)
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- src/domain/settings.test.ts src/domain/clipboard.test.ts
```

Expected: failures show the old schema/default count and old persisted `maxRecords` values.

- [ ] **Step 3: Implement the minimal settings migration**

In `src/domain/settings.ts`, define and use:

```ts
export const SETTINGS_SCHEMA_VERSION = 7
export const UNLIMITED_HISTORY_RECORDS = Number.MAX_SAFE_INTEGER

export const DEFAULT_HISTORY_POLICY: HistoryPolicy = {
  maxRecords: UNLIMITED_HISTORY_RECORDS,
  maxImageBytes: 256 * 1024 * 1024,
  retentionDays: 30,
}
```

Keep strict validation of the incoming compatibility field, then return `UNLIMITED_HISTORY_RECORDS` while preserving the parsed `maxImageBytes` and `retentionDays`. In `src/App.vue`, replace the policy-derived pending queue bound with an independent constant:

```ts
const MAX_PENDING_NATIVE_CAPTURES = 500
```

Do not allocate arrays or fetch pages sized to `Number.MAX_SAFE_INTEGER`; keep native query paging unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
npm test -- src/domain/settings.test.ts src/domain/clipboard.test.ts
npm run typecheck
```

Expected: settings tests pass and TypeScript reports no errors.

- [ ] **Step 5: Inspect and commit the frontend policy boundary**

Run:

```powershell
git diff --check
git diff -- src/domain/settings.ts src/domain/settings.test.ts src/App.vue
git add src/domain/settings.ts src/domain/settings.test.ts src/App.vue
git commit -m "取消前端历史条数限制"
```

Expected: the commit contains only settings normalization, its tests, and the independent capture-queue guard.

### Task 2: Remove Native Count Pruning and Migrate Existing Databases

**Files:**
- Modify: `src-tauri/src/history.rs`
- Test: `src-tauri/src/history.rs`

**Interfaces:**
- Consumes: compatibility value `9_007_199_254_740_991` from Task 1.
- Produces: native schema `13` and `UNLIMITED_HISTORY_RECORDS: u64`.
- Produces: `prune_capacity` behavior ordered as time expiry followed by image-byte pruning, with no total-row deletion.
- Preserves: existing mutation, restore, statistics, backup, and serialized policy shapes.

- [ ] **Step 1: Rewrite native tests to express no-count semantics**

Replace the count-pruning test with a case that writes `max_records = 1`, inserts 501 unexpired ordinary text rows, applies pruning, and asserts:

```rust
assert!(pruned_ids.is_empty());
assert_eq!(history_count(&connection), 501);
assert_eq!(stats.policy.max_records, JS_MAX_SAFE_INTEGER_U64);
```

Update migration, storage-statistics, backup round-trip, and restore expectations so `max_records` always reads as the canonical unlimited value. Keep exact assertions for custom image bytes and `Some(7)`, `Some(30)`, `Some(90)`, or `None` retention values.

Refactor count-dependent rollback/deduplication tests to trigger deletion through image-byte pruning, and change copied-timestamp normalization to expect every unexpired text row to remain.

- [ ] **Step 2: Run focused Rust tests and verify RED**

Run:

```powershell
Push-Location src-tauri
cargo test history::tests --lib
Pop-Location
```

Expected: failures identify schema `12`, stored finite counts, and count-pruning behavior.

- [ ] **Step 3: Add schema 13 and canonical policy persistence**

Implement these constants and migration behavior in `src-tauri/src/history.rs`:

```rust
const SCHEMA_VERSION: i64 = 13;
const UNLIMITED_HISTORY_RECORDS: u64 = JS_MAX_SAFE_INTEGER_U64;

fn migrate_to_v13(transaction: &Transaction<'_>) -> Result<(), HistoryError> {
    transaction.execute(
        "UPDATE history_settings SET max_records = ?1 WHERE singleton = 1",
        [UNLIMITED_HISTORY_RECORDS as i64],
    )?;
    Ok(())
}
```

Wire migration `12 => migrate_to_v13`. Make fresh defaults, settings writes, policy reads, restore adoption, and storage statistics return/persist `UNLIMITED_HISTORY_RECORDS` after validating incoming safe integers.

- [ ] **Step 4: Remove only the total-record pruning stage**

Delete the `oldest_unprotected_ids` helper if it has no remaining callers. In `prune_capacity`, retain this transaction order:

```rust
let expired_ids = expired_unprotected_ids(transaction, policy.retention_days, now_ms)?;
delete_history_ids(transaction, &expired_ids)?;

let image_ids = oldest_unprotected_image_ids_over_budget(
    transaction,
    policy.max_image_bytes,
)?;
delete_history_ids(transaction, &image_ids)?;
```

Return one stable, deduplicated list across the retained pruning stages. Do not alter pinned/permanent predicates.

- [ ] **Step 5: Run native tests and verify GREEN**

Run:

```powershell
Push-Location src-tauri
cargo fmt -- --check
cargo test history::tests --lib
Pop-Location
```

Expected: formatting succeeds and all history tests pass, including rollback, restore, migration, retention protection, and image-capacity cases.

- [ ] **Step 6: Inspect and commit the native behavior**

Run:

```powershell
git diff --check
git diff -- src-tauri/src/history.rs
git add src-tauri/src/history.rs
git commit -m "改为按期限清理原生历史"
```

Expected: the commit keeps the compatibility column but removes every row-count deletion path.

### Task 3: Expose Only Finite Retention Choices and Preserve the Legacy State

**Files:**
- Modify: `src/domain/clipboard.ts`
- Modify: `src/App.vue`
- Modify: `src/components/SettingsPanel.vue`
- Modify: `src/i18n.ts`
- Modify: `src/App.test.ts`
- Modify: `src/App.native-settings.test.ts`
- Test: `src/App.test.ts`
- Test: `src/App.native-settings.test.ts`

**Interfaces:**
- Consumes: `UNLIMITED_HISTORY_RECORDS` and normalized `HistoryPolicy` from Task 1.
- Produces: `FiniteRetentionPeriod = Exclude<RetentionPeriod, 'forever'>` for user-selectable values.
- Produces: a current-only `forever` option when `retentionDays === null`; confirmed transitions write only `7`, `30`, or `90`.
- Preserves: existing destructive-change confirmation, focus restoration, keyboard navigation, and IME composition guards.

- [ ] **Step 1: Add failing visible-option and legacy-transition tests**

In `src/App.test.ts`, assert a normal 30-day policy has these options and no ordinary forever option:

```ts
expect(retentionOptions()).toEqual(['7', '30', '90'])
expect(wrapper.text()).not.toContain('不过期（仍保留最近 500 条普通记录）')
```

For a legacy `retentionDays: null` policy, assert the current-only migration copy appears, then cover both paths:

```ts
await chooseRetention('7')
expect(confirmDialogIsVisible()).toBe(true)
await cancelRetentionChange()
expect(currentRetention()).toBe('forever')

await chooseRetention('7')
await confirmRetentionChange()
expect(currentRetention()).toBe('7')
expect(retentionOptions()).toEqual(['7', '30', '90'])
```

Keep or add assertions that focus returns to the select after cancellation/confirmation, arrow-key selection works, and `isComposing: true` key events do not trigger an action.

In `src/App.native-settings.test.ts`, change all policy sync/restore expectations to `Number.MAX_SAFE_INTEGER`, retain exact custom image capacities, and replace finite-to-forever mutation coverage with finite-to-finite coverage.

- [ ] **Step 2: Run the Vue tests and verify RED**

Run:

```powershell
npm test -- src/App.test.ts src/App.native-settings.test.ts
```

Expected: failures identify the still-selectable forever option, old 500-record copy, and finite count values sent over IPC.

- [ ] **Step 3: Restrict the selection type and render the legacy current value**

In `src/domain/clipboard.ts`, keep the persisted union and add the selectable subtype:

```ts
export type RetentionPeriod = '7' | '30' | '90' | 'forever'
export type FiniteRetentionPeriod = Exclude<RetentionPeriod, 'forever'>
```

Make the change handler in `src/App.vue` accept only `FiniteRetentionPeriod`. In `SettingsPanel.vue`, render `7`, `30`, and `90` for every user; prepend a disabled/current-only `forever` option only when the bound current value is `forever`. Do not silently choose 30 days on mount.

Use copy with these meanings in both locales:

```ts
// zh-CN
retentionDescription: '普通历史按所选期限清理；固定内容和永久片段不会自动删除。'
retentionLegacyForever: '旧版永不过期，请选择保留期限'

// en-US
retentionDescription: 'Ordinary history is cleared after the selected period; pinned items and permanent snippets are never removed automatically.'
retentionLegacyForever: 'Legacy no-expiry policy — choose a retention period'
```

Reuse the existing projected-removal count and irreversible confirmation flow. On cancellation, retain `null`; on success, persist first through the existing mutation and only then update UI state and prune/reload.

- [ ] **Step 4: Run Vue tests and verify GREEN**

Run:

```powershell
npm test -- src/domain/settings.test.ts src/App.test.ts src/App.native-settings.test.ts
npm run typecheck
```

Expected: focused tests pass; TypeScript proves no user path can submit `forever`.

- [ ] **Step 5: Inspect and commit the settings experience**

Run:

```powershell
git diff --check
git diff -- src/domain/clipboard.ts src/App.vue src/components/SettingsPanel.vue src/i18n.ts src/App.test.ts src/App.native-settings.test.ts
git add src/domain/clipboard.ts src/App.vue src/components/SettingsPanel.vue src/i18n.ts src/App.test.ts src/App.native-settings.test.ts
git commit -m "限制历史保留期限选项"
```

Expected: the commit contains finite choices, grandfathered display behavior, copy, and regression coverage.

### Task 4: Update Product Metadata and Documentation for v0.22.0

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/architecture.md`
- Create: `docs/release-notes-v0.22.0.md`
- Create: `docs/release-verification-v0.22.0.md`

**Interfaces:**
- Consumes: completed frontend/native behavior from Tasks 1–3.
- Produces: consistent product version `0.22.0` and user-facing release copy.
- Produces: a verification record whose measured fields are filled only from Task 5 command output.

- [ ] **Step 1: Set every version source to 0.22.0**

Make these values exact:

```json
// package.json, package-lock.json, src-tauri/tauri.conf.json
"version": "0.22.0"
```

```toml
# src-tauri/Cargo.toml and the QuickPaste package entry in Cargo.lock
version = "0.22.0"
```

Use the existing lockfile/package-manager workflow; do not change dependency versions.

- [ ] **Step 2: Document the new contract and migration behavior**

Add a `0.22.0` changelog entry and update both READMEs and architecture documentation to state:

```text
Ordinary history has no item-count cap and is retained for 7, 30, or 90 days.
New installations default to 30 days; pinned items and permanent snippets never expire.
Images still use the configured logical-byte capacity, defaulting to 256 MiB on new installations.
Legacy no-expiry policies remain untouched until the user confirms a finite period.
```

Remove current documentation that promises a 500-record ordinary-history limit or a selectable no-expiry option.

- [ ] **Step 3: Draft release notes and a verification evidence structure**

In `docs/release-notes-v0.22.0.md`, include the four user-visible bullets from the design, upgrade safety, Windows x64 scope, and `pending real-machine` endurance status.

In `docs/release-verification-v0.22.0.md`, create explicit sections for:

```text
Source revision and clean-tree state
npm ci / npm run check / npm run build:windows results
Light/dark, standard/compact, keyboard, and Chinese IME checks
NSIS and portable ZIP filenames, byte sizes, and SHA-256 values
Authenticode, executable version, ZIP inventory, privacy scan, and license checks
GitHub Actions run URL and asynchronous state at publication
Public Release URL and post-upload redownload digest comparison
Pending real-machine checks
```

Do not invent measurements; Task 5 replaces every evidence marker before the release commit.

- [ ] **Step 4: Run metadata and stale-copy checks**

Run:

```powershell
npm install --package-lock-only --ignore-scripts
rg -n '0\.21\.1|最近 ?500|latest 500|最多 ?500|up to 500|value="forever"' package.json package-lock.json src-tauri README.md README.en.md CHANGELOG.md docs src
git diff --check
```

Expected: version `0.21.1` remains only in historical changelog/release records; active product copy has no 500-record limit and the only forever option is conditionally rendered for a current legacy policy.

- [ ] **Step 5: Commit the release metadata and documentation**

Run:

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md README.md README.en.md docs/architecture.md docs/release-notes-v0.22.0.md docs/release-verification-v0.22.0.md
git commit -m "准备 QuickPaste v0.22.0"
```

Expected: one reviewable commit contains only version metadata and documentation derived from implemented behavior.

### Task 5: Run the Full Release Gate and Fill Measured Evidence

**Files:**
- Modify: `docs/release-verification-v0.22.0.md`
- Inspect: `src-tauri/target/release/bundle/nsis/`
- Create locally, do not commit: the portable ZIP assembled by the existing release procedure.

**Interfaces:**
- Consumes: versioned candidate from Task 4.
- Produces: verified NSIS installer and portable ZIP with recorded size and SHA-256.
- Produces: complete local verification evidence suitable for a release decision.

- [ ] **Step 1: Reinstall exactly from the lockfile**

Run:

```powershell
npm ci
```

Expected: exit code `0`, with no lockfile changes.

- [ ] **Step 2: Run the project-wide check gate**

Run:

```powershell
npm run check
```

Expected: exit code `0` for formatting, lint/type checks, Vitest, Rust tests, and project governance checks configured by the repository.

- [ ] **Step 3: Perform real-page UI regression checks**

Start the existing development command documented by the repository, then use the Playwright skill and the installed Playwright runtime to inspect the settings page at standard and compact window sizes. Check light and dark themes, use keyboard navigation to choose each finite period, and dispatch composition-state key events matching Chinese IME behavior.

Record this exact matrix with pass/fail results in the verification document:

```text
light × standard
light × compact
dark × standard
dark × compact
keyboard: Tab, ArrowUp/ArrowDown, Enter, Escape
IME: keydown with isComposing=true causes no retention mutation
legacy null: cancel preserves policy; confirm finite choice removes legacy option
```

Expected: controls remain visible and operable, no horizontal clipping occurs, focus is restored, and composition events are ignored.

- [ ] **Step 4: Build the Windows release candidate**

Run:

```powershell
npm run build:windows
```

Expected: exit code `0`, exactly one x64 NSIS candidate for version `0.22.0`, and no MSI output added by configuration.

- [ ] **Step 5: Assemble and inspect the portable ZIP**

Follow `docs/release.md` exactly. The archive must contain exactly:

```text
QuickPaste.exe
THIRD_PARTY_NOTICES.md
THIRD_PARTY_LICENSES_NPM.md
THIRD_PARTY_LICENSES_RUST.md
THIRD_PARTY_LICENSES_NATIVE.md
```

Use an explicitly resolved temporary staging directory under the project release-output location. Verify the resolved path before removing any stale staging directory, and never recursively delete the repository root or a broad computed path.

- [ ] **Step 6: Measure and verify candidate artifacts**

For both artifacts, record `Length` and `Get-FileHash -Algorithm SHA256`. Inspect the executable/installer product version and Authenticode status, expand the ZIP to a fresh validated temporary directory, compare its inventory exactly, and run the repository privacy/license checks from `docs/release.md`.

Expected: version fields equal `0.22.0`, inventories match, privacy scan finds no user content or secrets, all required notices are present, and every observed signature state is recorded without claiming a signature that is absent.

- [ ] **Step 7: Replace evidence markers and commit the verified candidate record**

Fill every measured field in `docs/release-verification-v0.22.0.md`, then run:

```powershell
rg -n '<[^>]+>|\[[A-Z_]+\]|待填.' docs/release-verification-v0.22.0.md
git diff --check
git status --short
git add docs/release-verification-v0.22.0.md
git commit -m "记录 v0.22.0 发布验证"
```

Expected: the search returns no evidence markers, build artifacts remain untracked/ignored, and the commit contains only measured verification evidence.

### Task 6: Publish and Independently Verify the GitHub Release

**Files:**
- Modify after publication: `docs/release-verification-v0.22.0.md`
- Publish: the verified NSIS installer and portable ZIP from Task 5.

**Interfaces:**
- Consumes: clean verified commit, two measured assets, and release notes from Tasks 4–5.
- Produces: annotated tag `v0.22.0`, standard non-draft/non-prerelease GitHub Release, pushed source branch/main state, and public redownload verification.

- [ ] **Step 1: Confirm publication authority and exact scope**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -8
git diff main...HEAD --stat
gh auth status
```

Expected: worktree is clean, all changes are limited to this feature/release, and GitHub CLI reports authenticated access to `zkwi/QuickPaste`.

- [ ] **Step 2: Integrate the verified branch without rewriting history**

Fetch origin, verify that local `main` can be fast-forwarded safely, then fast-forward `main` to the verified feature tip and push it. Do not reset, force-push, or discard unrelated work.

Run the repository's final pre-push status/diff checks and then:

```powershell
git push origin main
```

Expected: origin accepts a normal fast-forward push.

- [ ] **Step 3: Record the asynchronous GitHub Actions run**

Use GitHub CLI to identify the run triggered by the pushed commit and record its URL and current state in the verification document. Do not wait for completion; project policy treats Actions as asynchronous follow-up.

- [ ] **Step 4: Create and push the annotated release tag**

Run:

```powershell
git tag -a v0.22.0 -m "发布 QuickPaste v0.22.0"
git push origin v0.22.0
```

Expected: local and remote tag objects resolve to the verified release commit.

- [ ] **Step 5: Publish exactly two release assets**

Create a standard GitHub Release from `v0.22.0`, using `docs/release-notes-v0.22.0.md` as the body and uploading only the measured x64 NSIS installer and portable ZIP.

Expected: `isDraft=false`, `isPrerelease=false`, release title identifies QuickPaste v0.22.0, and the asset list has exactly two entries.

- [ ] **Step 6: Redownload and compare public artifacts**

Download both assets from the public Release into a new validated temporary directory. Compute SHA-256 values and compare them with Task 5. Query the public Release metadata and verify tag, target commit, draft/prerelease flags, asset count, filenames, and sizes.

Expected: both public digests and sizes are byte-for-byte identical to the local verified candidates.

- [ ] **Step 7: Record publication facts and push the follow-up evidence commit**

Add the public Release URL, tag target, Actions URL/state, public asset metadata, and redownload digest comparison to `docs/release-verification-v0.22.0.md`. Preserve `pending real-machine` for unexecuted endurance checks.

Run:

```powershell
git diff --check
git add docs/release-verification-v0.22.0.md
git commit -m "记录 v0.22.0 发布结果"
git push origin main
git status --short --branch
```

Expected: follow-up commit is on `origin/main`, the worktree is clean, and the public Release remains attached to the earlier verified tag commit.

## Completion Evidence

The work is complete only when all task checkboxes have corresponding command output or recorded evidence, all required tests and Windows builds pass, `v0.22.0` is public with exactly two verified assets, and any unexecuted physical-machine endurance work remains explicitly marked `pending real-machine`.
