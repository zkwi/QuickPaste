# QuickPaste Two-Line Clip Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make quick-panel and manager rows use two lines for unique, useful clipboard information without increasing their current row heights.

**Architecture:** Keep clipboard data and search behavior unchanged. Generalize the existing `quickClipText` selection rules inside `App.vue`, expose a manager-specific summary through `LibraryManagerHelpers`, and replace the manager's duplicate title/body nodes with one clamped summary node. CSS owns two-line layout while existing component tests verify the selected text and existing size contracts.

**Tech Stack:** Vue 3, TypeScript, Vitest, CSS, Tauri 2, Rust, Playwright CLI, GitHub CLI.

## Global Constraints

- Windows remains the only delivery platform; the process stays at ordinary-user integrity.
- Quick-panel standard and compact row heights remain exactly 44px and 40px.
- The quick panel must continue to show at least 8 standard rows and 6 compact rows under the documented shell sizes.
- No database schema, capture, paste, history paging, search protocol, dependency, or permission changes.
- Search highlighting, OCR/phonetic/file badges, source/time metadata, checkboxes, keyboard navigation, and row actions remain available.
- Use failing tests before production changes; do not use Computer Use.
- Publish as minor version v0.19.0 with Windows x64 NSIS and portable ZIP only.

---

### Task 1: Prepare and verify the isolated workspace

**Files:**
- Existing worktree: `.worktrees/two-line-density-v0.19.0`
- Existing lockfile: `package-lock.json`

**Interfaces:**
- Consumes: branch `codex/two-line-density-v0.19.0` at design commit `550e4fb`.
- Produces: installed locked dependencies and a green baseline for frontend behavior.

- [ ] **Step 1: Install the exact dependency graph**

Run:

```powershell
npm ci
```

Expected: exit 0 and 140 locked packages installed.

- [ ] **Step 2: Verify the focused baseline**

Run:

```powershell
npm test -- src/App.quick-ux.test.ts src/App.native-settings.test.ts src/style.test.ts
```

Expected: all three test files pass before behavior changes.

### Task 2: Select one useful summary and remove manager duplication

**Files:**
- Modify: `src/App.quick-ux.test.ts`
- Modify: `src/App.vue`
- Modify: `src/components/LibraryManager.types.ts`
- Modify: `src/components/LibraryManager.vue`

**Interfaces:**
- Consumes: `SearchHighlighter` from `src/domain/searchHighlight.ts` and existing `ClipboardItem` fields.
- Produces: `clipSummaryText(clip, highlighter, phoneticOnly): string`, `managerClipText(clip): string`, and `LibraryManagerHelpers.managerClipText`.

- [ ] **Step 1: Write failing integration tests for deduplicated manager summaries**

Add focused tests to `src/App.quick-ux.test.ts` that mount records with repeated, distinct, image, link, and file content:

```ts
it('uses one useful manager summary instead of repeating generated titles', async () => {
  wrapper.unmount()
  const copiedAt = '2026-07-22T00:00:00.000Z'
  localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([
    { id: 'repeated', kind: 'text', title: '建议优化排版', content: '建议优化排版，将默认显示行数调整为两行，以提升信息密度', sourceApp: 'Chrome', copiedAt, pinned: false, searchTerms: [] },
    { id: 'snippet', kind: 'text', title: '常用地址', content: '上海市浦东新区', sourceApp: 'QuickPaste', copiedAt, pinned: true, permanent: true, searchTerms: [] },
    { id: 'image', kind: 'image', title: '剪贴板图片 · 1400 × 1013', content: 'data:image/png;base64,AA==', imageUrl: 'data:image/png;base64,AA==', sourceApp: 'Snipping Tool', copiedAt, pinned: false, searchTerms: [] },
    { id: 'link', kind: 'link', title: 'example.com/docs', content: 'https://example.com/docs', sourceApp: 'Edge', copiedAt, pinned: false, searchTerms: [] },
    { id: 'files', kind: 'file', title: '2 个文件', content: 'first.txt\nsecond.txt', files: [{ path: 'C:\\Fixtures\\first.txt', name: 'first.txt', directory: false, exists: true }, { path: 'C:\\Fixtures\\second.txt', name: 'second.txt', directory: false, exists: true }], sourceApp: 'Explorer', copiedAt, pinned: false, searchTerms: [] },
  ]))
  wrapper = mount(App, { attachTo: document.body })
  await wrapper.get('[data-testid="open-library"]').trigger('click')

  expect(wrapper.get('[data-manager-clip-id="repeated"] .manager-summary-text').text())
    .toBe('建议优化排版，将默认显示行数调整为两行，以提升信息密度')
  expect(wrapper.get('[data-manager-clip-id="snippet"] .manager-summary-text').text())
    .toBe('常用地址 · 上海市浦东新区')
  expect(wrapper.get('[data-manager-clip-id="image"] .manager-summary-text').text())
    .toBe('剪贴板图片 · 1400 × 1013')
  expect(wrapper.get('[data-manager-clip-id="link"] .manager-summary-text').text())
    .toBe('https://example.com/docs')
  expect(wrapper.get('[data-manager-clip-id="files"] .manager-summary-text').text())
    .toContain('2 个文件 · first.txt')
  expect(wrapper.findAll('.manager-title-text')).toHaveLength(0)
  expect(wrapper.get('[data-manager-clip-id="repeated"]').find('p').exists()).toBe(false)
})
```

Add a second test proving title-only manager searches remain visible and highlighted:

```ts
it('shows a title-only manager search match in the unified summary', async () => {
  wrapper.unmount()
  localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
    id: 'named', kind: 'text', title: '专用标题', content: '正文没有查询词', sourceApp: 'QuickPaste',
    copiedAt: '2026-07-22T00:00:00.000Z', pinned: true, permanent: true, searchTerms: [],
  }]))
  wrapper = mount(App, { attachTo: document.body })
  await wrapper.get('[data-testid="open-library"]').trigger('click')
  await wrapper.get('[data-testid="manager-search-input"]').setValue('专用标题')

  const summary = wrapper.get('[data-manager-clip-id="named"] .manager-summary-text')
  expect(summary.text()).toBe('专用标题')
  expect(summary.get('mark.search-highlight').text()).toBe('专用标题')
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm test -- src/App.quick-ux.test.ts
```

Expected: FAIL because `.manager-summary-text` and `managerClipText` do not exist and the old title/body nodes remain.

- [ ] **Step 3: Generalize the existing summary selection logic**

Change the import and functions in `src/App.vue` to use one selector for both search surfaces:

```ts
import { createSearchHighlighter, type SearchHighlighter } from './domain/searchHighlight'

function clipSummaryText(
  clip: ClipboardItem,
  highlighter: SearchHighlighter,
  phoneticOnly: boolean,
): string {
  const title = clip.title.trim()
  const content = clip.content.trim()
  if (!content) return title
  if (phoneticOnly) return title || content

  const titleMatches = highlighter.segments(title).some((segment) => segment.matched)
  const contentMatches = highlighter.segments(content).some((segment) => segment.matched)
  if (highlighter.hasTerms) {
    return highlighter.preview(titleMatches && !contentMatches ? title : content)
  }

  if (clip.kind === 'image') return title
  if (clip.kind === 'link') return highlighter.preview(content)
  if (clip.kind === 'file') {
    return (clip.files?.length ?? 0) > 1
      ? `${title} · ${highlighter.preview(content)}`
      : highlighter.preview(content)
  }

  const comparableTitle = title.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ')
  const comparableContent = content.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ')
  const titleRepeatsContent = !comparableTitle
    || comparableTitle === comparableContent
    || comparableContent.startsWith(comparableTitle)
    || comparableTitle.startsWith(comparableContent)
  return titleRepeatsContent ? highlighter.preview(content) : `${title} · ${highlighter.preview(content)}`
}

function quickClipText(clip: ClipboardItem): string {
  return clipSummaryText(clip, directSearchHighlighter.value, isPhoneticOnlyMatch(clip))
}

function managerClipText(clip: ClipboardItem): string {
  return clipSummaryText(clip, managerSearchHighlighter.value, isPhoneticOnlyMatch(clip, true))
}
```

Add the helper to `LibraryManagerHelpers` and `libraryManagerHelpers`:

```ts
managerClipText: (clip: ClipboardItem) => string
```

- [ ] **Step 4: Render one manager summary and keep badges outside its clamp**

Replace the old `<strong>` plus `<p>` block in `src/components/LibraryManager.vue` with:

```vue
<div class="manager-copy">
  <span class="manager-summary-text">
    <template v-for="(segment, segmentIndex) in helpers.managerHighlightSegments(helpers.managerClipText(clip))" :key="`manager-summary-${segmentIndex}`">
      <mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark>
      <template v-else>{{ segment.text }}</template>
    </template>
  </span>
  <span v-if="helpers.isOcrOnlyMatch(clip)" class="ocr-match">{{ helpers.t('ocrMatch') }}</span>
  <span v-else-if="helpers.isPhoneticOnlyMatch(clip)" class="phonetic-match">{{ helpers.t(state.nativeRuntime ? 'indexMatch' : 'pinyinMatch') }}</span>
  <span v-else-if="clip.kind === 'image' && clip.ocrStatus" :data-testid="`manager-ocr-status-${clip.id}`" class="ocr-status compact">{{ helpers.ocrStatusLabel(clip) }}</span>
  <span v-if="helpers.hasMissingFiles(clip)" :data-testid="`manager-file-availability-${clip.id}`" class="file-availability">{{ helpers.fileAvailabilityLabel(clip) }}</span>
</div>
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
npm test -- src/App.quick-ux.test.ts src/App.native-settings.test.ts
```

Expected: both files pass; manager selection, badges, search and actions remain green.

- [ ] **Step 6: Commit the behavior change**

```powershell
git add src/App.quick-ux.test.ts src/App.vue src/components/LibraryManager.types.ts src/components/LibraryManager.vue
git commit -m "优化剪贴条目摘要去重"
```

### Task 3: Clamp both surfaces to two lines without changing row heights

**Files:**
- Modify: `src/style.test.ts`
- Modify: `src/style.css`
- Modify: `docs/testing.md`

**Interfaces:**
- Consumes: `.clip-content-text`, `.manager-copy`, and `.manager-summary-text` nodes.
- Produces: two-line clamp CSS while preserving `--quick-row-height: 44px` and compact `40px`.

- [ ] **Step 1: Write the failing CSS contract test**

Add to `src/style.test.ts`:

```ts
it('uses two unique-content lines without increasing quick or manager rows', () => {
  const quickSummary = cssRule('.clip-content-text')
  const managerSummary = cssRule('.manager-summary-text')

  for (const rule of [quickSummary, managerSummary]) {
    expect(rule).toMatch(/display:\s*-webkit-box/)
    expect(rule).toMatch(/-webkit-box-orient:\s*vertical/)
    expect(rule).toMatch(/-webkit-line-clamp:\s*2/)
    expect(rule).toMatch(/white-space:\s*normal/)
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
  }
  expect(quickPanelMetric('--quick-row-height', 'standard')).toBe(44)
  expect(quickPanelMetric('--quick-row-height', 'compact')).toBe(40)
  expect(cssRule('.manager-row')).toMatch(/min-height:\s*54px/)
  expect(testingGuide).toContain('条目摘要默认显示两行')
})
```

- [ ] **Step 2: Run the CSS test and verify RED**

Run:

```powershell
npm test -- src/style.test.ts
```

Expected: FAIL because both summary selectors lack the two-line contract and the testing guide lacks the statement.

- [ ] **Step 3: Implement the two-line CSS**

Update `src/style.css`:

```css
.clip-content-text {
  display: -webkit-box;
  flex: 1 1 auto;
  min-width: 0;
  max-height: 36px;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.manager-copy {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.manager-summary-text {
  display: -webkit-box;
  flex: 1 1 auto;
  min-width: 0;
  max-height: 32px;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--text);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 16px;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
```

Remove the obsolete `.manager-title-text` and `.manager-row strong, .manager-row p` rules. Add “条目摘要默认显示两行” to the quick-panel layout checklist in `docs/testing.md` without changing the 44px/40px thresholds.

- [ ] **Step 4: Run focused UI contracts and verify GREEN**

Run:

```powershell
npm test -- src/style.test.ts src/App.quick-ux.test.ts src/App.native-settings.test.ts
```

Expected: all three files pass; the hover-preview truncation tests remain green.

- [ ] **Step 5: Commit the layout change**

```powershell
git add src/style.test.ts src/style.css docs/testing.md
git commit -m "将剪贴摘要调整为两行显示"
```

### Task 4: Version v0.19.0 and prepare release documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock` (only the `quickpaste` package entry)
- Modify: `src-tauri/tauri.conf.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/release.md`
- Create: `docs/releases/v0.19.0.md`
- Create: `docs/releases/v0.19.0-verification.md`
- Regenerate: `THIRD_PARTY_LICENSES_NPM.md`
- Modify generated lock hashes: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: completed layout behavior and test counts.
- Produces: internally consistent v0.19.0 metadata and release candidate documentation.

- [ ] **Step 1: Bump every QuickPaste version field to 0.19.0**

Set exact version `0.19.0` in both package manifests, the QuickPaste Cargo package entry, and Tauri config. Do not replace unrelated crates whose versions happen to be `0.18.0`.

- [ ] **Step 2: Update public documentation**

Add a 2026-07-22 `0.19.0` changelog section describing two-line quick summaries and manager deduplication. Point README and `docs/release.md` at v0.19.0. Create release notes with:

```markdown
# QuickPaste v0.19.0 发布说明

v0.19.0 提升快速面板与管理页的条目信息密度：快速面板在原有行高内默认显示两行，管理页不再重复展示由正文生成的标题。
```

State that there is no database migration, NSIS remains current-user x64 only, the binaries are unsigned, and real-machine installation/DPI/long-loop matrices remain pending.

- [ ] **Step 3: Regenerate license metadata and lock hashes**

Run:

```powershell
npm run licenses:npm
npm run licenses:rust
npm run licenses:native
```

Update only the package-lock and Cargo.lock SHA-256 values in `THIRD_PARTY_NOTICES.md` using `Get-FileHash` output.

- [ ] **Step 4: Verify metadata and governance**

Run:

```powershell
npm run check:governance
git diff --check
```

Expected: all governance, version, repository, privacy, runtime-boundary, and license checks pass.

- [ ] **Step 5: Commit the release candidate metadata**

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md README.md docs/release.md docs/releases/v0.19.0.md docs/releases/v0.19.0-verification.md THIRD_PARTY_LICENSES_NPM.md THIRD_PARTY_LICENSES_RUST.md THIRD_PARTY_LICENSES_NATIVE.md THIRD_PARTY_NOTICES.md
git commit -m "准备 v0.19.0 发布资料"
```

### Task 5: Verify, build, publish, and record evidence

**Files:**
- Modify after build: `docs/releases/v0.19.0.md`
- Modify after release: `docs/releases/v0.19.0-verification.md`
- Build only, never stage: `src-tauri/target/x86_64-pc-windows-msvc/release/**`

**Interfaces:**
- Consumes: clean v0.19.0 branch and ignored build output.
- Produces: verified x64 NSIS installer, five-file portable ZIP, Git tag `v0.19.0`, public Latest Release, and verification record.

- [ ] **Step 1: Run the full local release gate**

Run:

```powershell
$env:CARGO_BUILD_JOBS='1'
npm ci
npm run check
$env:npm_config_registry='https://registry.npmjs.org/'
npm audit --omit=dev --audit-level=high
cargo audit --file src-tauri/Cargo.lock
```

Expected: `npm run check` exits 0; npm reports no high-severity production vulnerability. Record RustSec allowed warnings separately instead of describing them as zero findings.

- [ ] **Step 2: Run Playwright CLI visual checks**

Start Vite on `127.0.0.1:4173` and use `C:\Users\zkwi\.codex\skills\playwright\scripts\playwright_cli.sh` through Git Bash. Check 800×580 light standard mode, 640×440 dark compact mode, and the manager page. Verify computed 44px/40px row heights, two-line clamps, 8/6 visible-row thresholds, manager summary deduplication, keyboard focus, badges, and zero console errors. Do not use Computer Use.

- [ ] **Step 3: Build and verify Windows artifacts**

Run:

```powershell
$env:CARGO_BUILD_JOBS='1'
npm run build:windows
```

Require exactly one `QuickPaste_0.19.0_x64-setup.exe`, no MSI/MSIX/APPX, PE machine `0x8664`, file/product version `0.19.0`, and expected `NotSigned` Authenticode status. Package `QuickPaste.exe` plus the four third-party license files as `QuickPaste_0.19.0_x64-portable.zip`, then record exact byte counts and SHA-256 values in both release documents.

- [ ] **Step 4: Finish the branch and push the release commit**

Read and follow `superpowers:finishing-a-development-branch`. Review `git status`, staged paths, privacy output and full diff. Push `codex/two-line-density-v0.19.0`, fast-forward `main`, rerun `npm run check` on merged `main`, create annotated tag `v0.19.0`, then push `main` and the tag.

- [ ] **Step 5: Publish and independently verify GitHub assets**

Create a draft GitHub Release from `docs/releases/v0.19.0.md`, upload exactly the NSIS and portable ZIP, redownload both through authenticated GitHub API, and compare filename, size, SHA-256 and `asset.digest`. Publish with `draft=false`, `prerelease=false`, mark Latest, then redownload the public assets by tag and compare again.

- [ ] **Step 6: Record asynchronous CI and final release evidence**

Add the Release ID, public URL, remote asset verification and the `main` CI run URL/status to `docs/releases/v0.19.0-verification.md`. Commit with:

```powershell
git add docs/releases/v0.19.0-verification.md
git commit -m "记录 v0.19.0 发布校验"
git push origin main
```

Confirm local/remote `main`, the tag target, both working trees, Latest Release and public asset hashes before reporting completion.
