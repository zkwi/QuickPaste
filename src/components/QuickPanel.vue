<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CircleHelp, Database, Eye, Keyboard, LayoutList, Minus, Moon, PanelTopClose, PanelTopOpen, Pin, Search, Settings2, ShieldCheck, Sun, X } from 'lucide-vue-next'
import { formatRelativeTime, type ClipboardItem, type ClipKindFilter } from '../domain/clipboard'
import { displayShortcut } from '../domain/shortcut'
import type { WindowAction } from '../platform/window'
import ClipImageThumbnail from './ClipImageThumbnail.vue'
import SourceAppIcon from './SourceAppIcon.vue'
import type { QuickPanelHelpers, QuickPanelState } from './QuickPanel.types'

const props = defineProps<{ state: QuickPanelState; helpers: QuickPanelHelpers }>()
const emit = defineEmits<{
  togglePin: []
  toggleTheme: []
  openLibrary: [section?: 'settings']
  windowAction: [action: WindowAction]
  resumeCapture: []
  updateQuery: [value: string]
  compositionStart: []
  compositionEnd: []
  compositionBlur: []
  clearSearch: [resetFilter?: boolean]
  clearSource: []
  selectSource: [source: string]
  setFilter: [filter: ClipKindFilter]
  filterKeydown: [event: KeyboardEvent, index: number]
  dismissPractice: []
  focusContent: []
  retryHistory: []
  selectClip: [id: string]
  useClip: [clip: ClipboardItem]
  previewClip: [id: string]
  hoverPreviewClip: [id: string | null]
  pinClip: [id: string]
  loadMore: []
  searchElement: [element: HTMLInputElement | null]
}>()

const searchInput = ref<HTMLInputElement | null>(null)
const searchHelpOpen = ref(false)
const HOVER_PREVIEW_DELAY_MS = 400
const HOVER_PREVIEW_TEXT_LIMIT = 4_096
let hoverPreviewTimer: ReturnType<typeof setTimeout> | undefined
let pendingHoverClipId: string | null = null

onMounted(() => {
  emit('searchElement', searchInput.value)
  window.addEventListener('blur', clearHoverPreview)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', clearHoverPreview)
  clearHoverPreview()
  emit('searchElement', null)
})

function clearHoverPreview() {
  if (hoverPreviewTimer) clearTimeout(hoverPreviewTimer)
  hoverPreviewTimer = undefined
  pendingHoverClipId = null
  emit('hoverPreviewClip', null)
}

function scheduleHoverPreview(clip: ClipboardItem, event: MouseEvent) {
  clearHoverPreview()
  if (props.state.previewActive || !['text', 'image'].includes(clip.kind)) return
  if (clip.kind === 'text') {
    const row = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    const text = row?.querySelector<HTMLElement>('.clip-content-text')
    if (!text || (text.scrollWidth <= text.clientWidth && text.scrollHeight <= text.clientHeight)) return
  }

  pendingHoverClipId = clip.id
  hoverPreviewTimer = setTimeout(() => {
    hoverPreviewTimer = undefined
    if (pendingHoverClipId === clip.id) emit('hoverPreviewClip', clip.id)
  }, HOVER_PREVIEW_DELAY_MS)
}

function hoverPreviewText(clip: ClipboardItem) {
  const text = clip.content || clip.title
  return text.length > HOVER_PREVIEW_TEXT_LIMIT
    ? `${text.slice(0, HOVER_PREVIEW_TEXT_LIMIT)}…`
    : text
}

watch(
  [
    () => props.state.previewActive,
    () => props.state.query,
    () => props.state.activeFilter,
    () => props.state.quickSourceFilter,
  ],
  clearHoverPreview,
)

watch(() => props.state.query, closeSearchHelp)

function updateQuery(event: Event) {
  if (event.target instanceof HTMLInputElement) emit('updateQuery', event.target.value)
}

function closeSearchHelp() {
  searchHelpOpen.value = false
}

function toggleSearchHelp() {
  searchHelpOpen.value = !searchHelpOpen.value
}
</script>

<template>
  <section class="quick-panel" :aria-label="`${helpers.t('productName')} ${helpers.t('quickPanel')}`" :inert="state.inert">
    <header class="panel-chrome" data-tauri-drag-region="deep">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
        <span class="brand-name">{{ helpers.t('productName') }}</span>
        <span class="capture-state" :class="{ paused: state.capturePaused, unavailable: state.captureAvailability === 'unavailable' }"><span class="state-dot"></span>{{ state.captureStatusText }}</span>
        <div data-testid="paste-target" class="chrome-target" aria-live="polite" aria-atomic="true" :title="`${helpers.t('pasteTo')} ${state.targetApp ?? helpers.t('currentApp')}`">
          <SourceAppIcon class="target-icon" :source="state.targetApp ?? helpers.t('currentApp')" :icon="state.targetAppIcon ?? undefined" />
          <span class="sr-only">{{ helpers.t('pasteTo') }}</span><strong>{{ state.targetApp ?? helpers.t('currentApp') }}</strong>
          <span v-if="state.targetElevated" class="target-admin" :title="helpers.t('administratorWindow')"><ShieldCheck :size="11" /><span class="sr-only">{{ helpers.t('administratorWindow') }}</span></span>
        </div>
      </div>
      <div class="chrome-actions">
        <button data-testid="pin-quick-panel" class="icon-button" :class="{ active: state.quickPanelPinned }" type="button" :disabled="state.quickPanelPinInFlight || (state.nativeRuntime && !state.nativeSettingsReady)" :aria-label="state.quickPanelPinned ? helpers.t('unpinQuickPanel') : helpers.t('pinQuickPanel')" :title="state.quickPanelPinned ? helpers.t('unpinQuickPanel') : helpers.t('pinQuickPanel')" :aria-pressed="state.quickPanelPinned" @click="emit('togglePin')"><PanelTopClose v-if="state.quickPanelPinned" :size="16" /><PanelTopOpen v-else :size="16" /></button>
        <button data-testid="toggle-theme" class="icon-button" type="button" :aria-label="state.theme === 'light' ? helpers.t('toggleDarkTheme') : helpers.t('toggleLightTheme')" :title="state.theme === 'light' ? helpers.t('toggleDarkTheme') : helpers.t('toggleLightTheme')" @click="emit('toggleTheme')"><Moon v-if="state.theme === 'light'" :size="16" /><Sun v-else :size="16" /></button>
        <button data-testid="open-library" class="icon-button" type="button" :aria-label="helpers.t('manageClipboardShort')" :title="helpers.t('manageClipboardShort')" @click="emit('openLibrary')"><LayoutList :size="16" /></button>
        <button data-testid="open-settings" class="icon-button" type="button" :aria-label="helpers.t('openSettings')" :title="helpers.t('openSettings')" @click="emit('openLibrary', 'settings')"><Settings2 :size="16" /></button>
        <span class="window-divider" aria-hidden="true"></span>
        <button data-testid="window-minimize" class="icon-button window-control" type="button" :disabled="state.windowModeTransitioning || state.windowActionInFlight" :aria-label="helpers.t('minimizeWindow')" :title="helpers.t('minimizeWindow')" @click="emit('windowAction', 'minimize')"><Minus :size="16" /></button>
        <button data-testid="window-close" class="icon-button window-control close" type="button" :disabled="state.windowModeTransitioning || state.windowActionInFlight" :aria-label="helpers.t('closeWindow')" :title="helpers.t('closeWindow')" @click="emit('windowAction', 'close')"><X :size="16" /></button>
      </div>
    </header>

    <Transition name="notice">
      <div v-if="state.nativeRuntime && !state.quitSubscriptionReady" class="privacy-banner" role="alert"><ShieldCheck :size="17" /><span>{{ helpers.t('desktopExitUnavailable') }}</span></div>
      <div v-else-if="state.captureAvailability === 'unavailable'" class="privacy-banner" role="status"><ShieldCheck :size="17" /><span>{{ helpers.t('captureUnavailableNotice') }}</span></div>
      <div v-else-if="state.capturePaused" class="privacy-banner" role="status"><ShieldCheck :size="17" /><span>{{ helpers.t('pausedNotice') }}</span><button type="button" @click="emit('resumeCapture')">{{ helpers.t('resume') }}</button></div>
    </Transition>

    <div class="search-area" :class="{ 'has-source-filter': state.quickSourceFilter, 'has-snippet-mode': state.permanentSearch, 'has-both-prefixes': state.quickSourceFilter && state.permanentSearch }">
      <Search class="search-icon" :size="19" aria-hidden="true" />
      <span v-if="state.quickSourceFilter || state.permanentSearch" class="search-prefixes">
        <span v-if="state.quickSourceFilter" data-testid="source-filter-chip" class="search-mode-chip source">@{{ state.quickSourceFilter }}<button type="button" :aria-label="helpers.t('clearSourceFilter', { source: state.quickSourceFilter })" @click="emit('clearSource')"><X :size="11" /></button></span>
        <span v-if="state.permanentSearch" data-testid="snippet-mode-indicator" class="search-mode-chip snippet">; {{ helpers.t('permanentSnippets') }}</span>
      </span>
      <input ref="searchInput" :value="state.query" data-testid="search-input" class="search-input" type="search" role="combobox" autocomplete="off" spellcheck="false" aria-autocomplete="list" :aria-controls="state.sourceSuggestions.length > 0 ? 'source-suggestions' : undefined" :aria-expanded="state.sourceSuggestions.length > 0" aria-haspopup="listbox" :aria-activedescendant="state.activeDescendant" :aria-label="helpers.t('searchClipboard')" :placeholder="helpers.t('searchClipboard')" @input="updateQuery" @compositionstart="emit('compositionStart')" @compositionend="emit('compositionEnd')" @blur="emit('compositionBlur')" />
      <button v-if="state.query" class="clear-search" type="button" :aria-label="helpers.t('clearSearch')" @click="emit('clearSearch')"><X :size="15" /></button><span v-else class="search-hint">Ctrl K</span>
      <button data-testid="search-help-toggle" class="search-help-toggle" type="button" aria-controls="quick-search-help" :aria-expanded="searchHelpOpen" :aria-label="helpers.t('searchHelp')" :title="helpers.t('searchHelp')" @click="toggleSearchHelp" @keydown.esc.stop.prevent="closeSearchHelp"><CircleHelp :size="15" /></button>
      <div v-if="searchHelpOpen" id="quick-search-help" data-testid="quick-search-help" class="quick-search-help" role="note">
        <strong>{{ helpers.t('searchHelpTitle') }}</strong>
        <dl><div><dt>@</dt><dd>{{ helpers.t('searchHelpSource') }}</dd></div><div><dt>;</dt><dd>{{ helpers.t('searchHelpSnippets') }}</dd></div><div><dt>Space</dt><dd>{{ helpers.t('searchHelpPreview') }}</dd></div><div><dt>Enter</dt><dd>{{ helpers.t('searchHelpPaste') }}</dd></div><div><dt>Alt + 1…0</dt><dd>{{ helpers.t('searchHelpDirectPaste') }}</dd></div></dl>
      </div>
      <div v-if="state.sourceSuggestions.length" id="source-suggestions" data-testid="source-suggestions" class="source-suggestions" role="listbox" :aria-label="helpers.t('sourceSuggestions')">
        <button v-for="(sourceApp, index) in state.sourceSuggestions" :id="`source-suggestion-${index}`" :key="sourceApp" :data-testid="`source-suggestion-${index}`" type="button" role="option" :aria-selected="state.sourceSuggestionIndex === index" :class="{ selected: state.sourceSuggestionIndex === index }" @mousedown.prevent @click="emit('selectSource', sourceApp)"><SourceAppIcon class="source-suggestion-icon" :source="sourceApp" /> <span>{{ sourceApp }}</span><kbd v-if="state.sourceSuggestionIndex === index">Enter</kbd></button>
      </div>
    </div>

    <nav class="filter-strip" :aria-label="helpers.t('contentTypes')">
      <button v-for="(filter, index) in state.filters" :key="filter.id" :data-testid="`filter-${filter.id}`" class="filter-chip" :class="{ active: state.activeFilter === filter.id }" type="button" :tabindex="state.activeFilter === filter.id ? 0 : -1" :aria-pressed="state.activeFilter === filter.id" @click="emit('setFilter', filter.id)" @keydown="emit('filterKeydown', $event, index)">{{ filter.label }}<span v-if="filter.id === 'pinned'" class="chip-count">{{ state.pinnedCount }}</span></button>
    </nav>

    <Transition name="notice">
      <aside v-if="state.onboardingPracticeVisible" data-testid="onboarding-practice" class="onboarding-practice" role="status" aria-live="polite"><Keyboard :size="17" aria-hidden="true" /><span><strong>{{ helpers.t('onboardingPracticeTitle') }}</strong>{{ helpers.t('onboardingPracticeDescription', { shortcut: displayShortcut(state.globalShortcut) }) }}</span><button type="button" :aria-label="helpers.t('dismissOnboardingPractice')" @click="emit('dismissPractice')"><X :size="14" /></button></aside>
    </Transition>

    <div class="content-stage">
      <Transition name="preview-swap" mode="out-in" @after-enter="emit('focusContent')">
        <slot v-if="state.previewActive" name="preview"></slot>
        <div v-else key="list" class="results-panel" :aria-busy="state.historyState === 'loading'">
          <p v-if="state.historyState === 'ready'" data-testid="quick-results-status" class="selection-announcement sr-only" aria-live="polite" aria-atomic="true">{{ state.selectionAnnouncement }}</p>
          <p v-if="state.nativeRuntime && state.historyState === 'ready'" data-testid="quick-history-page-status" class="sr-only">{{ helpers.t('showingHistoryPage', { loaded: state.visibleItems.length, total: state.nativeHistoryTotalCount }) }}</p>
          <div v-if="state.historyState === 'loading'" data-testid="history-loading" class="empty-state history-state" role="status"><span class="history-loader" aria-hidden="true"><span></span><span></span><span></span></span><h2>{{ helpers.t('historyLoading') }}</h2><p>{{ helpers.t('historyLoadingHint') }}</p></div>
          <div v-else-if="state.historyState === 'error'" data-testid="history-error" class="empty-state history-state error" role="alert"><span class="empty-symbol"><ShieldCheck :size="25" /></span><h2>{{ helpers.t('historyUnavailable') }}</h2><p>{{ helpers.t('historyLoadFailed') }}</p><button data-testid="history-retry" class="secondary-button" type="button" @click="emit('retryHistory')">{{ helpers.t('retryHistory') }}</button></div>
          <template v-else-if="state.visibleItems.length">
            <div id="clipboard-results" class="clip-list" role="list" :aria-label="helpers.t('clipboardResults')" @scroll.passive="clearHoverPreview" @keydown="clearHoverPreview" @pointerdown="clearHoverPreview">
              <article v-for="(clip, index) in state.visibleItems" :id="helpers.clipResultId(clip.id)" :key="clip.id" :data-clip-id="clip.id" class="clip-row" :class="{ 'is-selected': state.selectedId === clip.id }" role="listitem" :aria-current="state.selectedId === clip.id ? 'true' : undefined" @mouseenter="scheduleHoverPreview(clip, $event)" @mouseleave="clearHoverPreview">
                <button class="clip-primary" type="button" :tabindex="state.selectedId === clip.id ? 0 : -1" :aria-keyshortcuts="helpers.directPasteAriaShortcuts(index)" @mousedown.left.prevent @click="emit('selectClip', clip.id)" @dblclick="emit('useClip', clip)">
                  <span v-if="index < 10" class="quick-number" aria-hidden="true">{{ helpers.directPasteLabel(index) }}</span>
                  <span class="kind-icon" :style="{ '--source-color': clip.color }"><ClipImageThumbnail v-if="clip.kind === 'image'" :clip-id="clip.id" :image-url="clip.imageUrl" :image-hash="clip.imageHash" /><component v-else :is="helpers.kindIcon(clip.kind)" :size="18" /></span>
                  <span class="clip-copy"><span class="clip-content"><span class="clip-content-text"><template v-for="(segment, segmentIndex) in helpers.highlightSegments(helpers.quickClipText(clip))" :key="`content-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span><span v-if="helpers.isOcrOnlyMatch(clip)" class="ocr-match">{{ helpers.t('ocrMatch') }}</span><span v-else-if="helpers.isPhoneticOnlyMatch(clip)" class="phonetic-match">{{ helpers.t(state.nativeRuntime ? 'indexMatch' : 'pinyinMatch') }}</span><span v-else-if="clip.kind === 'image' && clip.ocrStatus" class="ocr-status compact">{{ helpers.ocrStatusLabel(clip) }}</span><span v-if="helpers.hasMissingFiles(clip)" :data-testid="`quick-file-availability-${clip.id}`" class="file-availability">{{ helpers.fileAvailabilityLabel(clip) }}</span></span></span>
                  <span class="clip-meta"><span class="source-app"><SourceAppIcon class="app-dot" :source="clip.sourceApp" :icon="clip.sourceAppIcon" :fallback-color="clip.color" /><span class="source-name"><template v-for="(segment, segmentIndex) in helpers.highlightSegments(clip.sourceApp)" :key="`source-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span></span><span class="clip-time">{{ formatRelativeTime(clip.copiedAt, state.relativeTimeNow, state.locale) }}</span></span>
                </button>
                <div class="row-actions">
                  <button :data-testid="`preview-clip-${clip.id}`" type="button" :tabindex="state.selectedId === clip.id ? 0 : -1" :aria-label="helpers.t('previewWithShortcut')" :title="helpers.t('previewWithShortcut')" @focus="emit('selectClip', clip.id)" @pointerdown="emit('selectClip', clip.id)" @click="emit('previewClip', clip.id)"><Eye :size="15" /></button>
                  <button :data-testid="`pin-clip-${clip.id}`" type="button" :tabindex="state.selectedId === clip.id ? 0 : -1" :aria-label="`${clip.pinned ? helpers.t('unpin') : helpers.t('pinClip')}: ${clip.title}`" :title="clip.pinned ? helpers.t('unpin') : helpers.t('pinClip')" :aria-pressed="clip.pinned" :class="{ active: clip.pinned }" @focus="emit('selectClip', clip.id)" @pointerdown="emit('selectClip', clip.id)" @click="emit('pinClip', clip.id)"><Pin :size="15" :fill="clip.pinned ? 'currentColor' : 'none'" /></button>
                </div>
              </article>
              <button v-if="state.nativeRuntime && state.nativeHistoryNextCursor" data-testid="history-load-more" class="secondary-button history-load-more" type="button" :disabled="state.nativeHistoryPageLoading" @click="emit('loadMore')">{{ state.nativeHistoryPageLoading ? helpers.t('loadingMoreHistory') : helpers.t('loadMoreHistory') }}</button>
            </div>
          </template>
          <div v-else-if="state.itemsCount === 0 && !state.query && state.activeFilter === 'all'" data-testid="empty-history" class="empty-state"><span class="empty-symbol"><Database :size="25" /></span><h2>{{ helpers.t('emptyHistory') }}</h2><p>{{ helpers.t('emptyHistoryHint') }}</p></div>
          <div v-else data-testid="no-results" class="empty-state"><span class="empty-symbol"><Search :size="25" /></span><h2>{{ helpers.t('noResults') }}</h2><p>{{ helpers.t('noResultsHint') }}</p><button class="secondary-button" type="button" @click="emit('clearSearch', true)">{{ helpers.t('clearFilters') }}</button></div>
        </div>
      </Transition>
      <Transition name="hover-preview">
        <aside
          v-if="!state.previewActive && state.hoverPreviewClip"
          data-testid="clip-hover-preview"
          class="clip-hover-preview"
          :data-hover-clip-id="state.hoverPreviewClip.id"
          :style="{ '--source-color': state.hoverPreviewClip.color }"
          aria-hidden="true"
        >
          <div class="clip-hover-preview-heading">
            <component :is="helpers.kindIcon(state.hoverPreviewClip.kind)" :size="15" />
            <span>{{ state.hoverPreviewClip.title }}</span>
          </div>
          <div v-if="state.hoverPreviewClip.kind === 'image'" data-testid="clip-hover-preview-image" class="clip-hover-preview-image">
            <ClipImageThumbnail :clip-id="state.hoverPreviewClip.id" :image-url="state.hoverPreviewClip.imageUrl" :image-hash="state.hoverPreviewClip.imageHash" />
          </div>
          <p v-else data-testid="clip-hover-preview-text" class="clip-hover-preview-text">{{ hoverPreviewText(state.hoverPreviewClip) }}</p>
        </aside>
      </Transition>
    </div>
  </section>
</template>
