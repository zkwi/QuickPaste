import type { Component } from 'vue'
import type { ClipboardItem, ClipKind, ClipKindFilter } from '../domain/clipboard'
import type { Locale, MessageKey } from '../i18n'

export interface QuickPanelState {
  inert: boolean
  nativeRuntime: boolean
  quitSubscriptionReady: boolean
  captureAvailability: 'starting' | 'available' | 'unavailable'
  capturePaused: boolean
  captureStatusText: string
  targetApp: string | null
  targetAppIcon: string | null
  targetElevated: boolean
  quickPanelPinned: boolean
  quickPanelPinInFlight: boolean
  nativeSettingsReady: boolean
  theme: 'light' | 'dark'
  windowModeTransitioning: boolean
  windowActionInFlight: boolean
  query: string
  quickSourceFilter: string
  permanentSearch: boolean
  sourceSuggestions: string[]
  sourceSuggestionIndex: number
  activeDescendant?: string
  filters: Array<{ id: ClipKindFilter; label: string }>
  activeFilter: ClipKindFilter
  pinnedCount: number
  onboardingPracticeVisible: boolean
  globalShortcut: string
  previewActive: boolean
  historyState: 'loading' | 'ready' | 'error'
  selectionAnnouncement: string
  visibleItems: ClipboardItem[]
  nativeHistoryTotalCount: number
  selectedId: string
  nativeHistoryNextCursor?: string
  nativeHistoryPageLoading: boolean
  itemsCount: number
  relativeTimeNow: Date
  locale: Locale
}

export interface QuickPanelHelpers {
  t: (key: MessageKey, replacements?: Record<string, string | number>) => string
  kindIcon: (kind: ClipKind) => Component
  highlightSegments: (text: string) => Array<{ text: string; matched: boolean }>
  quickClipText: (clip: ClipboardItem) => string
  isOcrOnlyMatch: (clip: ClipboardItem) => boolean
  isPhoneticOnlyMatch: (clip: ClipboardItem) => boolean
  ocrStatusLabel: (clip: ClipboardItem) => string
  hasMissingFiles: (clip: ClipboardItem) => boolean
  fileAvailabilityLabel: (clip: ClipboardItem) => string
  clipResultId: (id: string) => string
  directPasteTooltip: (index: number) => string
  directPasteAriaShortcuts: (index: number) => string | undefined
  directPasteLabel: (index: number) => string
}
