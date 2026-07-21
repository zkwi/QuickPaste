import { nextTick } from 'vue'
import { captureShortcut } from '../domain/shortcut'
import type { ClipboardItem, ClipKindFilter } from '../domain/clipboard'

type AppView = 'quick' | 'library'
type LibrarySection = 'all' | 'pinned' | 'images' | 'settings'

export interface GlobalKeyboardState {
  modalOverlayOpen: boolean
  pendingRetentionChange: boolean
  clearHistoryOpen: boolean
  sensitiveAppsOpen: boolean
  collectionDeleteOpen: boolean
  permanentSnippetDeleteOpen: boolean
  snippetEditorOpen: boolean
  shortcutRecording: boolean
  isComposing: boolean
  onboardingStep: number
  clipContextMenuOpen: boolean
  previewId: string | null
  currentView: AppView
  collectionEditorOpen: boolean
  librarySection: LibrarySection
  managerSelectedCount: number
  managerQuery: string
  query: string
  quickSourceFilter: string
  activeFilter: ClipKindFilter
  captureAvailability: 'starting' | 'available' | 'unavailable'
  searchInput: HTMLInputElement | null
  sourceSuggestions: string[]
  sourceSuggestionIndex: number
  visibleItems: ClipboardItem[]
  selectedClip: ClipboardItem | null
}

export interface GlobalKeyboardActions {
  closeRetentionChange: () => void
  closeClearHistory: () => void
  closeSensitiveApps: () => void
  closeDeleteCollection: () => void
  closeDeletePermanentSnippet: () => void
  closeSnippetEditor: () => void
  cancelShortcutRecording: (announce?: boolean) => void
  applyRecordedShortcut: (shortcut: string) => Promise<void>
  finishOnboarding: () => void
  closeClipContextMenu: (restoreFocus?: boolean) => void
  openKeyboardContextMenu: (target: Element) => boolean
  closePreview: () => void
  closeCollectionEditor: () => void
  clearManagerSelection: () => void
  clearManagerSearch: () => void
  returnToQuickPanel: () => Promise<void>
  clearSearchAndFocus: (resetFilter?: boolean) => void
  performWindowClose: () => void
  toggleCapturePaused: () => void
  openLibrary: () => void
  selectLibraryAll: () => void
  focusManagerSearch: () => void
  selectAllManagerMatches: () => void
  preservesNativeManagerSelectionKeys: (target: EventTarget | null) => boolean
  moveSourceSuggestion: (direction: number) => void
  selectSourceSuggestion: (source: string) => void
  clearQuickSourceFilter: () => void
  pasteClip: (clip: ClipboardItem) => void
  selectWithKeyboard: (delta: number, moveFocus?: boolean) => void
  selectIndexWithKeyboard: (index: number, moveFocus?: boolean) => void
  openPreview: (id: string) => void
}

const PAGE_NAVIGATION_STEP = 5
const DIRECT_PASTE_ITEM_COUNT = 10

export function useGlobalKeyboard(
  getState: () => GlobalKeyboardState,
  actions: GlobalKeyboardActions,
) {
  function handleKeydown(event: KeyboardEvent) {
    const state = getState()
    if (state.modalOverlayOpen) {
      if (event.key === 'Escape' && !event.isComposing && !state.isComposing) {
        event.preventDefault()
        if (state.pendingRetentionChange) actions.closeRetentionChange()
        else if (state.clearHistoryOpen) actions.closeClearHistory()
        else if (state.sensitiveAppsOpen) actions.closeSensitiveApps()
        else if (state.collectionDeleteOpen) actions.closeDeleteCollection()
        else if (state.permanentSnippetDeleteOpen) actions.closeDeletePermanentSnippet()
        else if (state.snippetEditorOpen) actions.closeSnippetEditor()
      }
      return
    }

    if (state.shortcutRecording) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        actions.cancelShortcutRecording(true)
        return
      }
      const shortcut = captureShortcut(event)
      if (shortcut) void actions.applyRecordedShortcut(shortcut)
      return
    }

    if (event.isComposing || state.isComposing) return
    if (state.onboardingStep >= 0) {
      if (event.key === 'Escape') actions.finishOnboarding()
      return
    }

    if (state.clipContextMenuOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        actions.closeClipContextMenu(true)
      } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault()
      }
      return
    }

    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const target = event.target instanceof Element ? event.target : null
      if (target && actions.openKeyboardContextMenu(target)) {
        event.preventDefault()
        return
      }
    }

    if (event.key === 'Escape') {
      if (state.previewId) {
        event.preventDefault()
        actions.closePreview()
      } else if (state.currentView === 'library') {
        event.preventDefault()
        if (state.collectionEditorOpen) actions.closeCollectionEditor()
        else if (state.librarySection !== 'settings' && state.managerSelectedCount > 0) actions.clearManagerSelection()
        else if (state.librarySection !== 'settings' && state.managerQuery) actions.clearManagerSearch()
        else void actions.returnToQuickPanel()
      } else if (!event.shiftKey && (state.query || state.quickSourceFilter || state.activeFilter !== 'all')) {
        event.preventDefault()
        actions.clearSearchAndFocus(true)
      } else {
        event.preventDefault()
        actions.performWindowClose()
      }
      return
    }

    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'p') {
      event.preventDefault()
      if (state.captureAvailability === 'available') actions.toggleCapturePaused()
      return
    }

    if (event.ctrlKey && event.key.toLocaleLowerCase() === 'l') {
      event.preventDefault()
      if (state.currentView === 'quick') actions.openLibrary()
      else {
        actions.selectLibraryAll()
        actions.focusManagerSearch()
      }
      return
    }

    if (state.currentView === 'quick' && event.ctrlKey && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault()
      nextTick(() => state.searchInput?.focus())
      return
    }

    if (state.currentView === 'library'
      && state.librarySection !== 'settings'
      && event.ctrlKey
      && ['f', 'k'].includes(event.key.toLocaleLowerCase())) {
      event.preventDefault()
      actions.focusManagerSearch()
      return
    }

    if (state.currentView === 'library'
      && state.librarySection !== 'settings'
      && event.ctrlKey
      && !event.altKey
      && !event.shiftKey
      && event.key.toLocaleLowerCase() === 'a'
      && !actions.preservesNativeManagerSelectionKeys(event.target)) {
      event.preventDefault()
      actions.selectAllManagerMatches()
      return
    }

    if (state.currentView !== 'quick') return
    const eventTarget = event.target instanceof HTMLElement ? event.target : null
    const resultPrimary = eventTarget?.closest<HTMLElement>('.clip-primary') ?? null
    const isSearchTarget = eventTarget === state.searchInput
    const isResultNavigationTarget = isSearchTarget || resultPrimary !== null

    if (isSearchTarget && state.sourceSuggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        actions.moveSourceSuggestion(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const source = state.sourceSuggestions[state.sourceSuggestionIndex]
        if (source) actions.selectSourceSuggestion(source)
        return
      }
    }

    if (isSearchTarget && event.key === 'Backspace' && !state.query && state.quickSourceFilter) {
      event.preventDefault()
      actions.clearQuickSourceFilter()
      return
    }

    const hasExactDirectPasteModifier = event.altKey !== event.ctrlKey && !event.shiftKey && !event.metaKey
    if (hasExactDirectPasteModifier && /^[0-9]$/.test(event.key)) {
      event.preventDefault()
      const directIndex = event.key === '0' ? DIRECT_PASTE_ITEM_COUNT - 1 : Number(event.key) - 1
      const clip = state.visibleItems[directIndex]
      if (clip) actions.pasteClip(clip)
      return
    }

    if (isResultNavigationTarget && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      actions.selectWithKeyboard(event.key === 'ArrowDown' ? 1 : -1, resultPrimary !== null)
      return
    }
    if (isResultNavigationTarget && (event.key === 'PageDown' || event.key === 'PageUp')) {
      event.preventDefault()
      actions.selectWithKeyboard(event.key === 'PageDown' ? PAGE_NAVIGATION_STEP : -PAGE_NAVIGATION_STEP, resultPrimary !== null)
      return
    }
    if (resultPrimary && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      actions.selectIndexWithKeyboard(event.key === 'Home' ? 0 : state.visibleItems.length - 1, true)
      return
    }
    if (isResultNavigationTarget && event.key === 'Enter' && state.selectedClip) {
      event.preventDefault()
      actions.pasteClip(state.selectedClip)
      return
    }
    if (event.key === ' ' && state.previewId === null) {
      if (eventTarget?.closest('.clip-primary') && state.selectedClip) {
        event.preventDefault()
        actions.openPreview(state.selectedClip.id)
      }
    }
  }

  return { handleKeydown }
}
