# Hover Content Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace mouse-hover direct-paste badges with a delayed, non-interactive preview card for text and image clipboard rows.

**Architecture:** QuickPanel.vue owns the 200ms hover-intent timer and renders one pointer-transparent overlay without changing row geometry. App.vue resolves native summary payloads through the existing payload cache so text previews can use the full body and image previews can use the original image when available.

**Tech Stack:** Vue 3, TypeScript, Vitest, Vue Test Utils, CSS.

## Global Constraints

- Keep the compact quick panel at seven visible rows and the standard panel at ten.
- Do not move keyboard focus or change the selected clip on mouse hover.
- Support light/dark themes and reduced motion with existing tokens and global rules.
- Add no dependency, service, or new native command.
- Preserve the existing uncommitted caret-position fix in src-tauri/src/lib.rs.
- Do not commit, push, tag, or publish without explicit maintainer authorization.

---

### Task 1: Hover intent and payload resolution

**Files:**
- Modify: src/components/QuickPanel.vue
- Modify: src/components/QuickPanel.types.ts
- Modify: src/App.vue
- Test: src/App.quick-ux.test.ts

**Interfaces:**
- QuickPanelState.hoverPreviewClip: ClipboardItem | null
- QuickPanel emits hoverPreviewClip: [id: string | null]
- App.vue exposes showHoverPreview(id: string | null): Promise<void>

- [x] **Step 1: Write failing interaction tests**

Use fake timers, trigger mouseenter on a text or image row, advance 199ms and assert no clip-hover-preview, then advance 1ms and assert the card contains the expected full text or image. Confirm clip-1 remains keyboard-selected. Trigger mouseleave and assert the preview is removed.

- [x] **Step 2: Run the focused test and verify RED**

    npm test -- src/App.quick-ux.test.ts

Expected: FAIL because the hover preview element does not exist.

- [x] **Step 3: Implement the minimal hover flow**

In QuickPanel.vue, start one 200ms timeout for text and image rows, cancel it on leave/unmount, and emit null when hiding. Render an aria-hidden, pointer-transparent card only while the list view is active.

In App.vue, keep an independent generation counter, show the summary immediately, call existing resolveClipPayload(clip), and replace the card payload only if the same row is still hovered.

- [x] **Step 4: Run the focused test and verify GREEN**

    npm test -- src/App.quick-ux.test.ts

Expected: all tests in the file pass.

### Task 2: Preview presentation and shortcut-hint behavior

**Files:**
- Modify: src/style.css
- Test: src/style.test.ts

**Interfaces:**
- .clip-hover-preview
- .clip-hover-preview-text
- .clip-hover-preview-image

- [x] **Step 1: Write failing style-contract tests**

Assert the card is absolutely positioned, pointer-transparent, width-bounded, and layered above the list. Assert text preserves line breaks with bounded overflow, image content uses object-fit: contain, and .quick-number is revealed only by .clip-row.is-selected rather than .clip-row:hover.

- [x] **Step 2: Run the style test and verify RED**

    npm test -- src/style.test.ts

Expected: FAIL because the hover-card rules are absent and the hover shortcut selector remains.

- [x] **Step 3: Implement the card styles**

Use existing surface, border, text, and shadow tokens. Anchor the overlay to the lower-right of .content-stage, cap text to approximately eight lines, give image previews a 280–320px presentation area, and keep pointer-events disabled.

- [x] **Step 4: Run focused and full verification**

    npm test -- src/style.test.ts src/App.quick-ux.test.ts
    npm run check

Then start the app and verify text/image hover behavior in compact and standard windows, both themes, keyboard navigation, and Chinese IME composition.

### Task 3: Minor version metadata

**Files:**
- Modify: package.json
- Modify: package-lock.json
- Modify: src-tauri/Cargo.toml
- Modify: src-tauri/Cargo.lock
- Modify: src-tauri/tauri.conf.json
- Modify: CHANGELOG.md

- [x] **Step 1: Update the version**

Run npm version 0.17.0 with Git tagging disabled, then update the Tauri package/config metadata and lockfile to the same version.

- [x] **Step 2: Record the user-visible change**

Add a concise 0.17.0 entry describing hover text/image previews and the caret-position fallback correction.

- [x] **Step 3: Verify version consistency**

    npm run check:versions

Expected: all project metadata reports QuickPaste 0.17.0.
