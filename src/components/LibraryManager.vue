<script setup lang="ts">
import { onBeforeUnmount, onMounted, onUpdated, ref } from 'vue'
import { ChevronLeft, Clock3, Copy, Image as ImageIcon, Maximize2, Minimize2, Minus, Moon, Pin, Plus, Search, Settings2, ShieldCheck, Sun, Trash2, X } from 'lucide-vue-next'
import { formatRelativeTime, type ClipboardItem, type ClipKind } from '../domain/clipboard'
import type { WindowAction } from '../platform/window'
import ClipImageThumbnail from './ClipImageThumbnail.vue'
import ManagerBulkToolbar from './ManagerBulkToolbar.vue'
import ManagerFilters from './ManagerFilters.vue'
import SourceAppIcon from './SourceAppIcon.vue'
import type { BatchAction, Collection, LibraryManagerHelpers, LibraryManagerState, LibrarySection, ManagerCollectionFilter } from './LibraryManager.types'

defineProps<{ state: LibraryManagerState; helpers: LibraryManagerHelpers }>()
const emit = defineEmits<{
  selectSection: [section: LibrarySection]
  selectCollection: [filter: ManagerCollectionFilter]
  createCollection: []
  renameCollection: [collection: Collection]
  deleteCollection: [collection: Collection, event: Event]
  updateCollectionName: [event: Event]
  saveCollection: []
  closeCollectionEditor: []
  returnQuick: []
  toggleTheme: []
  windowAction: [action: WindowAction]
  updateManagerQuery: [value: string]
  updateManagerKinds: [value: ClipKind[]]
  managerSearchArrowDown: [event: KeyboardEvent]
  compositionStart: []
  compositionEnd: []
  compositionBlur: []
  clearManagerSearch: []
  newSnippet: []
  clearHistory: []
  selectAll: []
  clearSelection: []
  applyBatch: [action: BatchAction]
  retryHistory: []
  focusManagerClip: [id: string]
  toggleManagerClipSelection: [clip: ClipboardItem]
  managerRowClick: [event: MouseEvent, clip: ClipboardItem]
  managerRowKeydown: [event: KeyboardEvent, index: number, id: string]
  editSnippet: [clip: ClipboardItem]
  copyClip: [clip: ClipboardItem]
  pinClip: [id: string]
  deleteClip: [id: string]
  loadMore: []
  managerSearchElement: [element: HTMLInputElement | null]
  libraryContentElement: [element: HTMLElement | null]
  backButtonElement: [element: HTMLButtonElement | null]
  clearHistoryElement: [element: HTMLButtonElement | null]
}>()

const managerSearchInput = ref<HTMLInputElement | null>(null)
const libraryContent = ref<HTMLElement | null>(null)
const backButton = ref<HTMLButtonElement | null>(null)
const clearHistoryButton = ref<HTMLButtonElement | null>(null)

function publishElements() {
  emit('managerSearchElement', managerSearchInput.value)
  emit('libraryContentElement', libraryContent.value)
  emit('backButtonElement', backButton.value)
  emit('clearHistoryElement', clearHistoryButton.value)
}

onMounted(publishElements)
onUpdated(publishElements)
onBeforeUnmount(() => {
  emit('managerSearchElement', null)
  emit('libraryContentElement', null)
  emit('backButtonElement', null)
  emit('clearHistoryElement', null)
})

function updateQuery(event: Event) {
  if (event.target instanceof HTMLInputElement) emit('updateManagerQuery', event.target.value)
}
</script>

<template>
  <section data-testid="library-view" class="library-shell" :aria-label="helpers.t('clipboardManager')" :inert="state.inert">
    <aside class="library-sidebar">
      <div class="sidebar-brand"><span class="brand-mark" aria-hidden="true"><span></span><span></span></span><span>{{ helpers.t('productName') }}</span></div>
      <nav :aria-label="helpers.t('managerCategories')">
        <button data-testid="library-section-all" :class="{ active: state.section === 'all' }" type="button" :title="helpers.t('allHistory')" :aria-current="state.section === 'all' ? 'page' : undefined" @click="emit('selectSection', 'all')"><Clock3 :size="17" />{{ helpers.t('allHistory') }}<span>{{ state.nativeRuntime ? state.nativeHistoryTotalCount : state.itemsCount }}</span></button>
        <button data-testid="library-section-pinned" :class="{ active: state.section === 'pinned' }" type="button" :title="helpers.t('pinned')" :aria-current="state.section === 'pinned' ? 'page' : undefined" @click="emit('selectSection', 'pinned')"><Pin :size="17" />{{ helpers.t('pinned') }}<span v-if="!state.nativeRuntime">{{ state.pinnedCount }}</span></button>
        <button data-testid="library-section-images" :class="{ active: state.section === 'images' }" type="button" :title="helpers.t('images')" :aria-current="state.section === 'images' ? 'page' : undefined" @click="emit('selectSection', 'images')"><ImageIcon :size="17" />{{ helpers.t('images') }}<span v-if="!state.nativeRuntime">{{ state.imageCount }}</span></button>
      </nav>
      <section v-if="state.nativeRuntime" data-testid="manager-collections" class="manager-collections" :aria-label="helpers.t('managerCollections')">
        <header><strong>{{ helpers.t('managerCollections') }}</strong><button data-testid="manager-create-collection" type="button" :disabled="state.managerOperationBusy" @click="emit('createCollection')">{{ helpers.t('managerNewCollection') }}</button></header>
        <nav :aria-label="helpers.t('managerCollectionFilters')">
          <button data-testid="manager-collection-all" type="button" :aria-current="state.managerCollectionFilter === 'any' ? 'page' : undefined" @click="emit('selectCollection', 'any')">{{ helpers.t('managerAllCollections') }}</button>
          <button data-testid="manager-collection-unfiled" type="button" :aria-current="state.managerCollectionFilter === 'unfiled' ? 'page' : undefined" @click="emit('selectCollection', 'unfiled')">{{ helpers.t('managerUnfiled') }}</button>
          <div v-for="collection in state.collections" :key="collection.id" class="manager-collection-row">
            <button :data-testid="`manager-collection-${collection.id}`" type="button" :aria-current="state.managerCollectionFilter === `collection:${collection.id}` ? 'page' : undefined" @click="emit('selectCollection', `collection:${collection.id}`)">{{ collection.name }}</button>
            <button :data-testid="`manager-rename-collection-${collection.id}`" type="button" :disabled="state.managerOperationBusy" :aria-label="helpers.t('managerRenameCollection', { name: collection.name })" @click="emit('renameCollection', collection)">{{ helpers.t('managerEdit') }}</button>
            <button :data-testid="`manager-delete-collection-${collection.id}`" type="button" :disabled="state.managerOperationBusy" :aria-label="helpers.t('managerDeleteCollectionLabel', { name: collection.name })" @click="emit('deleteCollection', collection, $event)">{{ helpers.t('managerDeleteShort') }}</button>
          </div>
        </nav>
        <form v-if="state.collectionEditor" data-testid="manager-collection-editor" @submit.prevent="emit('saveCollection')">
          <input data-testid="manager-collection-name" type="text" :value="state.collectionEditor.name" :disabled="state.managerOperationBusy" :aria-label="helpers.t('managerCollectionName')" @input="emit('updateCollectionName', $event)" />
          <button data-testid="manager-save-collection" type="submit" :disabled="state.managerOperationBusy" @click.prevent="emit('saveCollection')">{{ helpers.t('managerSave') }}</button><button data-testid="manager-cancel-collection" type="button" :disabled="state.managerOperationBusy" @click="emit('closeCollectionEditor')">{{ helpers.t('cancel') }}</button>
        </form>
        <p v-if="state.collectionError" data-testid="manager-collection-error" role="alert">{{ state.collectionError }}</p>
      </section>
      <div class="sidebar-divider"></div>
      <nav :aria-label="helpers.t('appSettings')"><button data-testid="library-section-settings" :class="{ active: state.section === 'settings' }" type="button" :title="helpers.t('settings')" :aria-current="state.section === 'settings' ? 'page' : undefined" @click="emit('selectSection', 'settings')"><Settings2 :size="17" />{{ helpers.t('settings') }}</button></nav>
      <div class="sidebar-privacy"><ShieldCheck :size="15" /><span>{{ helpers.t('localOnly') }}</span></div>
    </aside>

    <main class="library-main">
      <header class="library-header" data-tauri-drag-region="deep">
        <div><button ref="backButton" class="back-button subtle" type="button" @click="emit('returnQuick')"><ChevronLeft :size="17" />{{ helpers.t('backToQuick') }}</button><h1>{{ state.section === 'settings' ? helpers.t('settings') : helpers.t('manageClipboard') }}</h1><p>{{ state.section !== 'settings' ? helpers.t('manageDescription') : helpers.t('settingsDescription') }}</p></div>
        <div class="library-header-actions">
          <button class="icon-button manager-theme" type="button" :aria-label="helpers.t('toggleTheme')" @click="emit('toggleTheme')"><Moon v-if="state.theme === 'light'" :size="17" /><Sun v-else :size="17" /></button>
          <button class="icon-button window-control" type="button" :disabled="state.windowModeTransitioning || state.windowActionInFlight" :aria-label="helpers.t('minimizeWindow')" @click="emit('windowAction', 'minimize')"><Minus :size="17" /></button>
          <button data-testid="window-toggle-maximize" class="icon-button window-control" type="button" :disabled="state.windowModeTransitioning || state.windowActionInFlight" :aria-label="state.windowMaximized ? helpers.t('restoreWindow') : helpers.t('maximizeWindow')" @click="emit('windowAction', 'toggle-maximize')"><Minimize2 v-if="state.windowMaximized" :size="15" /><Maximize2 v-else :size="15" /></button>
          <button class="icon-button window-control close" type="button" :disabled="state.windowModeTransitioning || state.windowActionInFlight" :aria-label="helpers.t('closeWindow')" @click="emit('windowAction', 'close')"><X :size="17" /></button>
        </div>
      </header>

      <section v-if="state.section !== 'settings'" ref="libraryContent" class="library-content">
        <div class="manager-toolbar">
          <div class="manager-search"><Search :size="14" aria-hidden="true" /><input ref="managerSearchInput" :value="state.managerQuery" data-testid="manager-search-input" type="search" autocomplete="off" spellcheck="false" :aria-label="helpers.t('searchManager')" :placeholder="helpers.t('searchManager')" @input="updateQuery" @keydown.down="emit('managerSearchArrowDown', $event)" @compositionstart="emit('compositionStart')" @compositionend="emit('compositionEnd')" @blur="emit('compositionBlur')" /><button v-if="state.managerQuery" data-testid="clear-manager-search" class="manager-search-clear" type="button" :aria-label="helpers.t('clearSearch')" @mousedown.prevent @click="emit('clearManagerSearch')"><X :size="13" /></button></div>
          <ManagerFilters :kinds="state.managerKinds" :locale="state.locale" @update:kinds="emit('updateManagerKinds', $event)" />
          <div class="manager-toolbar-actions">
            <span data-testid="manager-results-status" :aria-live="state.historyState === 'ready' ? 'polite' : 'off'" aria-atomic="true">{{ state.historyState === 'ready' ? state.nativeRuntime ? helpers.t('showingHistoryPage', { loaded: state.libraryItems.length, total: state.nativeHistoryTotalCount }) : helpers.t('showingItems', { count: state.libraryItems.length }) : '' }}</span>
            <button v-if="state.nativeRuntime" data-testid="new-snippet" class="manager-primary-action" type="button" :disabled="state.managerOperationBusy || state.snippetLoading" @click="emit('newSnippet')"><Plus :size="14" />{{ helpers.t('managerNewSnippet') }}</button>
            <button v-if="state.section === 'all' && !state.nativeRuntime" ref="clearHistoryButton" data-testid="clear-history" class="manager-clear" type="button" :disabled="state.ordinaryHistoryCount === 0" @click="emit('clearHistory')"><Trash2 :size="14" />{{ state.ordinaryClearLabel }}</button>
          </div>
        </div>
        <ManagerBulkToolbar v-if="state.nativeRuntime" :key="state.managerBulkToolbarKey" :locale="state.locale" :selection-state="state.managerBulkSelectionState" :selected-count="state.managerSelectedCount" :collections="state.collections" :busy="state.managerSelectionBusy" :error-message="state.managerBatchError" :includes-pinned="state.managerSelectionIncludesPinned" :includes-permanent="state.managerSelectionIncludesPermanent" @select-all="emit('selectAll')" @clear-selection="emit('clearSelection')" @apply="emit('applyBatch', $event)" />
        <div class="manager-list" role="list" :aria-label="helpers.t('clipboardResults')">
          <div v-if="state.historyState === 'loading'" class="empty-state compact" role="status"><span class="history-loader compact" aria-hidden="true"><span></span><span></span><span></span></span><h2>{{ helpers.t('historyLoading') }}</h2><p>{{ helpers.t('historyLoadingHint') }}</p></div>
          <div v-else-if="state.historyState === 'error'" class="empty-state compact history-state error" role="alert"><ShieldCheck :size="22" /><h2>{{ helpers.t('historyUnavailable') }}</h2><p>{{ helpers.t('historyLoadFailed') }}</p><button data-testid="history-retry" class="secondary-button" type="button" @click="emit('retryHistory')">{{ helpers.t('retryHistory') }}</button></div>
          <article v-for="(clip, index) in state.historyState === 'ready' ? state.libraryItems : []" :key="clip.id" :data-manager-clip-id="clip.id" class="manager-row" role="listitem" :tabindex="state.managerSelectedId === clip.id ? 0 : -1" :aria-current="state.managerSelectedId === clip.id ? 'true' : undefined" :aria-label="`${clip.title}, ${clip.sourceApp}`" @focus="emit('focusManagerClip', clip.id)" @click="emit('managerRowClick', $event, clip)" @keydown="emit('managerRowKeydown', $event, index, clip.id)">
            <input class="manager-select" :data-testid="`manager-select-${clip.id}`" type="checkbox" :tabindex="state.managerSelectedId === clip.id ? 0 : -1" :checked="helpers.managerClipSelected(clip)" :disabled="state.managerSelectionBusy" :aria-label="helpers.t('managerSelectClip', { title: clip.title })" @focus="emit('focusManagerClip', clip.id)" @change="emit('toggleManagerClipSelection', clip)" />
            <span class="kind-icon" :style="{ '--source-color': clip.color }"><ClipImageThumbnail v-if="clip.kind === 'image'" :clip-id="clip.id" :image-url="clip.imageUrl" :image-hash="clip.imageHash" /><component v-else :is="helpers.kindIcon(clip.kind)" :size="17" /></span>
            <div><strong><span class="manager-title-text"><template v-for="(segment, segmentIndex) in helpers.managerHighlightSegments(clip.title)" :key="`manager-title-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span><span v-if="helpers.isOcrOnlyMatch(clip)" class="ocr-match">{{ helpers.t('ocrMatch') }}</span><span v-else-if="helpers.isPhoneticOnlyMatch(clip)" class="phonetic-match">{{ helpers.t(state.nativeRuntime ? 'indexMatch' : 'pinyinMatch') }}</span><span v-else-if="clip.kind === 'image' && clip.ocrStatus" :data-testid="`manager-ocr-status-${clip.id}`" class="ocr-status compact">{{ helpers.ocrStatusLabel(clip) }}</span><span v-if="helpers.hasMissingFiles(clip)" :data-testid="`manager-file-availability-${clip.id}`" class="file-availability">{{ helpers.fileAvailabilityLabel(clip) }}</span></strong><p><template v-for="(segment, segmentIndex) in helpers.managerHighlightSegments(clip.content)" :key="`manager-content-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></p></div>
            <div class="manager-meta"><span class="manager-source"><SourceAppIcon class="manager-app-icon" :source="clip.sourceApp" :icon="clip.sourceAppIcon" :fallback-color="clip.color" /><span><template v-for="(segment, segmentIndex) in helpers.managerHighlightSegments(clip.sourceApp)" :key="`manager-source-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span></span><span class="manager-time">{{ formatRelativeTime(clip.copiedAt, state.relativeTimeNow, state.locale) }}</span></div>
            <div class="manager-actions">
              <button v-if="clip.permanent && (clip.kind === 'text' || clip.kind === 'code')" :data-testid="`manager-edit-snippet-${clip.id}`" type="button" :tabindex="state.managerSelectedId === clip.id ? 0 : -1" :aria-label="helpers.t('managerEditSnippet', { title: clip.title })" @focus="emit('focusManagerClip', clip.id)" @click="emit('editSnippet', clip)">{{ helpers.t('managerEdit') }}</button>
              <button :data-testid="`manager-copy-${clip.id}`" type="button" :tabindex="state.managerSelectedId === clip.id ? 0 : -1" :aria-label="`${helpers.t('copyContent')}: ${clip.title}`" :title="helpers.t('copyContent')" @focus="emit('focusManagerClip', clip.id)" @click="emit('copyClip', clip)"><Copy :size="15" /></button>
              <button :data-testid="`manager-pin-${clip.id}`" type="button" :tabindex="state.managerSelectedId === clip.id ? 0 : -1" :aria-label="`${clip.pinned ? helpers.t('unpin') : helpers.t('pinClip')}: ${clip.title}`" :aria-pressed="clip.pinned" @focus="emit('focusManagerClip', clip.id)" @click="emit('pinClip', clip.id)"><Pin :size="15" :fill="clip.pinned ? 'currentColor' : 'none'" /></button>
              <button :data-testid="`manager-delete-${clip.id}`" type="button" :tabindex="state.managerSelectedId === clip.id ? 0 : -1" :aria-label="`${helpers.t('deleteClip')}: ${clip.title}`" @focus="emit('focusManagerClip', clip.id)" @click="emit('deleteClip', clip.id)"><Trash2 :size="15" /></button>
            </div>
          </article>
          <button v-if="state.nativeRuntime && state.nativeHistoryNextCursor" data-testid="history-load-more" class="secondary-button history-load-more" type="button" :disabled="state.nativeHistoryPageLoading" @click="emit('loadMore')">{{ state.nativeHistoryPageLoading ? helpers.t('loadingMoreHistory') : helpers.t('loadMoreHistory') }}</button>
          <div v-if="state.historyState === 'ready' && state.libraryItems.length === 0" data-testid="manager-empty-state" class="empty-state compact"><component :is="state.managerEmptyState.icon" :size="22" /><h2>{{ state.managerEmptyState.title }}</h2><p>{{ state.managerEmptyState.hint }}</p><button v-if="state.managerEmptyState.canClear" data-testid="clear-empty-manager-search" class="secondary-button" type="button" @click="emit('clearManagerSearch')">{{ helpers.t('clearSearch') }}</button></div>
        </div>
      </section>
      <slot v-else name="settings"></slot>
    </main>
  </section>
</template>
