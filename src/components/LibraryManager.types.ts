import type { Component } from 'vue'
import type { ClipboardItem, ClipKind } from '../domain/clipboard'
import type { BatchAction, Collection, ManagerSelectionState } from '../domain/collections'
import type { Locale, MessageKey } from '../i18n'

export type LibrarySection = 'all' | 'pinned' | 'images' | 'settings'
export type ManagerCollectionFilter = 'any' | 'unfiled' | `collection:${string}`

export interface CollectionEditorViewState {
  mode: 'create' | 'rename'
  id?: string
  name: string
}

export interface LibraryManagerState {
  inert: boolean
  section: LibrarySection
  nativeRuntime: boolean
  nativeHistoryTotalCount: number
  itemsCount: number
  pinnedCount: number
  imageCount: number
  collections: Collection[]
  collectionEditor: CollectionEditorViewState | null
  collectionError: string
  managerOperationBusy: boolean
  managerCollectionFilter: ManagerCollectionFilter
  theme: 'light' | 'dark'
  windowModeTransitioning: boolean
  windowActionInFlight: boolean
  windowMaximized: boolean
  managerQuery: string
  managerKinds: ClipKind[]
  locale: Locale
  historyState: 'loading' | 'ready' | 'error'
  libraryItems: ClipboardItem[]
  snippetLoading: boolean
  ordinaryHistoryCount: number
  ordinaryClearLabel: string
  managerBulkToolbarKey: number
  managerBulkSelectionState: ManagerSelectionState
  managerSelectedCount: number
  managerSelectionBusy: boolean
  managerBatchError: string
  managerSelectionIncludesPinned: boolean
  managerSelectionIncludesPermanent: boolean
  managerSelectedId: string
  nativeHistoryNextCursor?: string
  nativeHistoryPageLoading: boolean
  managerEmptyState: { icon: Component; title: string; hint: string; canClear: boolean }
  relativeTimeNow: Date
}

export interface LibraryManagerHelpers {
  t: (key: MessageKey, replacements?: Record<string, string | number>) => string
  kindIcon: (kind: ClipKind) => Component
  managerHighlightSegments: (text: string) => Array<{ text: string; matched: boolean }>
  isOcrOnlyMatch: (clip: ClipboardItem) => boolean
  isPhoneticOnlyMatch: (clip: ClipboardItem) => boolean
  ocrStatusLabel: (clip: ClipboardItem) => string
  hasMissingFiles: (clip: ClipboardItem) => boolean
  fileAvailabilityLabel: (clip: ClipboardItem) => string
  managerClipSelected: (clip: ClipboardItem) => boolean
}

export type { BatchAction, Collection }
