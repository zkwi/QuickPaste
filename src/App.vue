<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AlignLeft,
  Check,
  Clock3,
  Code2,
  Download,
  Image as ImageIcon,
  LayoutList,
  Link2,
  Pin,
  Search,
  ShieldCheck,
  X,
} from 'lucide-vue-next'
import { demoClips } from './data/demoClips'
import { translate, type Locale, type MessageKey } from './i18n'
import { captureShortcut, DEFAULT_GLOBAL_SHORTCUT, displayShortcut, shortcutConflict } from './domain/shortcut'
import {
  applyClipFilter,
  clearUnpinnedHistory,
  createClipboardItem,
  mergeCapturedClipIntoHistory,
  moveSelection,
  normalizeSourceAppIcon,
  parseClipboardItems,
  promoteUsedClip,
  pruneExpiredClips,
  removeClip,
  restoreClip,
  togglePinned,
  type ClipboardItem,
  type ClipKind,
  type ClipKindFilter,
  type LoadedClipboardItem,
  type RemovedClip,
  type RetentionPeriod,
} from './domain/clipboard'
import {
  defaultPasteMode,
  getClipActions,
  type ClipAction,
  type PasteMode,
} from './domain/clipActions'
import { inferCodeLanguage } from './domain/codeLanguage'
import {
  DEFAULT_HISTORY_POLICY,
  SETTINGS_SCHEMA_VERSION,
  defaultStoredSettings,
  parseStoredSettingsJson,
  retentionPeriodForPolicy,
  type StoredSettings,
  type Theme,
} from './domain/settings'
import { createSearchHighlighter } from './domain/searchHighlight'
import { isSafeExternalUrl } from './domain/externalLink'
import { parseQuickSearch, suggestSourceApps } from './domain/quickSearch'
import {
  historyMatchBadge,
  historyQueryKey,
  normalizeHistoryQuery,
  type HistoryPage,
  type HistoryQuery,
} from './domain/historyQuery'
import {
  createAllMatchingSelection,
  emptyManagerSelection,
  isManagerItemSelected,
  managerSelectedCount as countManagerSelection,
  managerSelectionState,
  normalizeCollectionName,
  selectManagerRange,
  toBatchTarget,
  toggleManagerSelection,
  type BatchAction,
  type Collection,
  type ManagerSelection,
  type SnippetDraft,
} from './domain/collections'
import { formatUpdateSize } from './domain/update'
import { copyImage, copyText, pasteFiles, pasteFormats, pasteImage, pasteText } from './platform/clipboard'
import {
  cancelNativeQuit,
  connectCaptureAvailability,
  connectCaptureState,
  connectNativeClipboard,
  connectPasteTarget,
  connectQuickPanelSession,
  connectQuitRequested,
  exitNativeApp,
  getNativeCaptureAvailability,
  isTauriRuntime,
  setNativeCapturePaused,
  type CaptureAvailability,
  type PasteTargetInfo,
} from './platform/desktop'
import {
  applyNativeHistoryBatch,
  applyNativeHistoryMutation,
  compactNativeHistoryDatabase,
  commitNativeHistoryRestore,
  createIncrementalHistoryPersistence,
  createNativeHistoryCollection,
  createNativeHistoryBackup,
  createSerializedHistoryOperationLane,
  deleteNativeHistoryCollection,
  discardNativeHistoryRestore,
  getNativeHistoryHealth,
  getNativeStorageStats,
  listNativeHistoryCollections,
  loadNativeClipPayload,
  openNativeHistoryDataDirectory,
  prepareNativeHistoryRestore,
  queryNativeHistory,
  renameNativeHistoryCollection,
  saveNativeHistorySnippet,
  type CapacityPolicy,
  type ExternalOcrPatch,
  type HistoryExclusiveLease,
  type HistoryHealth,
  type PreparedRestore,
  type StorageOperation,
  type StorageStats,
} from './platform/history'
import {
  createOcrCoordinator,
  invalidateNativeClipboardOcr,
  listNativePendingOcrImages,
  markNativeClipOcrFailed,
  pumpStoredPendingOcr,
  recognizeNativeClipImage,
  setNativeClipboardOcrEnabled,
} from './platform/ocr'
import { acknowledgeQuickPanelFirstFrame } from './platform/metrics'
import { detectNativeClipQr } from './platform/qr'
import { getLaunchAtStartup, setCaptureExclusions, setElevatedPasteEnabled, setGlobalShortcut, setScreenCaptureProtection } from './platform/settings'
import { openExternalLink, openFilePath, revealFilePath, saveClipboardImage } from './platform/system'
import {
  observeWindowMaximizedState,
  runWindowAction,
  setOnboardingWindowActive,
  setQuickPanelPinned,
  setWindowMode,
  type WindowAction,
} from './platform/window'
import { useUpdater } from './composables/useUpdater'
import ClipContextMenu from './components/ClipContextMenu.vue'
import SnippetEditor from './components/SnippetEditor.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ClipPreview from './components/ClipPreview.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import QuickPanel from './components/QuickPanel.vue'
import type { QuickPanelHelpers } from './components/QuickPanel.types'
import LibraryManager from './components/LibraryManager.vue'
import type { LibraryManagerHelpers, LibrarySection, ManagerCollectionFilter } from './components/LibraryManager.types'
import OnboardingDialog from './components/OnboardingDialog.vue'
import { ONBOARDING_SAMPLE_ID, useOnboarding } from './composables/useOnboarding'
import { useNativeSettingsSync } from './composables/useNativeSettingsSync'

type AppView = 'quick' | 'library'
type HistoryState = 'loading' | 'ready' | 'error'
type ClipFocusSurface = 'quick' | 'manager'
type ClipContextSurface = ClipFocusSurface | 'preview'
type NativeCapturePayload = Parameters<typeof createClipboardItem>[0]

interface ClipContextMenuState {
  clipId: string
  surface: ClipContextSurface
  x: number
  y: number
  restoreFocus: HTMLElement | null
}

interface PendingRetentionChange {
  value: RetentionPeriod
  removedCount: number
}

interface CollectionEditorState {
  mode: 'create' | 'rename'
  id?: string
  name: string
}

interface PermanentSnippetDeleteTarget {
  id: string
  title: string
}

// 品牌重命名不改已有持久化 key，避免 WebView/浏览器模式中的设置和演示历史失效。
const ITEMS_STORAGE_KEY = 'mypaste-demo-items-v1'
const SETTINGS_STORAGE_KEY = 'mypaste-ui-settings-v1'
const MAX_HISTORY_ITEMS = DEFAULT_HISTORY_POLICY.maxRecords
const MAX_PENDING_NATIVE_CAPTURES = MAX_HISTORY_ITEMS
const HISTORY_RETRY_ATTEMPTS = 3
const HISTORY_RETRY_DELAY_MS = 200
const HISTORY_LOAD_TIMEOUT_MS = 1_400
const HISTORY_QUIT_FLUSH_TIMEOUT_MS = 900
const DELETE_UNDO_TIMEOUT_MS = 6_000
const PASTE_TARGET_TTL_MS = 5 * 60 * 1_000
const EVENT_SUBSCRIPTION_ATTEMPTS = 3
const PAGE_NAVIGATION_STEP = 5
const DIRECT_PASTE_ITEM_COUNT = 10
const NATIVE_HISTORY_PAGE_SIZE = 50
const NATIVE_SEARCH_DEBOUNCE_MS = 120
const nativeRuntime = isTauriRuntime()

function writeStoredValue(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 浏览器存储被禁用或空间不足时，界面仍应保持可用。
  }
}

function readStoredItems(): ClipboardItem[] {
  // 原生端的 SQLite 历史是唯一真值，不能让旧版 localStorage 在空库时复活。
  if (nativeRuntime) return []
  try {
    const raw = localStorage.getItem(ITEMS_STORAGE_KEY)
    const parsed = raw ? parseClipboardItems(JSON.parse(raw)) : null
    if (parsed) return parsed
  } catch {
    // 损坏的演示状态不应阻止界面启动。
  }
  return demoClips.map((clip): LoadedClipboardItem => ({
    ...clip,
    searchTerms: [...clip.searchTerms],
  }))
}

function readStoredSettings(): StoredSettings {
  try {
    return parseStoredSettingsJson(localStorage.getItem(SETTINGS_STORAGE_KEY))
  } catch {
    return defaultStoredSettings()
  }
}

const storedSettings = readStoredSettings()
const storedRetentionPeriod = retentionPeriodForPolicy(storedSettings.historyPolicy)
const items = ref<ClipboardItem[]>(pruneExpiredClips(readStoredItems(), storedRetentionPeriod))
const knownSourceApps = ref(suggestSourceApps(items.value.map((clip) => clip.sourceApp), '', 200))
const query = ref('')
const quickSourceFilter = ref('')
const sourceSuggestionIndex = ref(0)
const managerQuery = ref('')
const managerKinds = ref<ClipKind[]>([])
const managerCollectionFilter = ref<ManagerCollectionFilter>('any')
const managerSelectedId = ref(items.value[0]?.id ?? '')
const managerSelection = ref<ManagerSelection>(emptyManagerSelection())
const managerRangeAnchorId = ref<string | undefined>(undefined)
const managerBulkToolbarKey = ref(0)
const collections = ref<Collection[]>([])
const collectionEditor = ref<CollectionEditorState | null>(null)
const collectionDeleteTarget = ref<Collection | null>(null)
const permanentSnippetDeleteTarget = ref<PermanentSnippetDeleteTarget | null>(null)
const permanentSnippetDeleteError = ref('')
const collectionError = ref('')
const snippetDraft = ref<SnippetDraft | null>(null)
const snippetEditorKey = ref(0)
const snippetError = ref('')
const managerBatchError = ref('')
const managerOperationBusy = ref(false)
const snippetLoading = ref(false)
const activeFilter = ref<ClipKindFilter>('all')
const selectedId = ref(items.value[0]?.id ?? '')
const previewId = ref<string | null>(null)
const qrScanState = ref<'idle' | 'scanning' | 'complete'>('idle')
const qrResults = ref<string[]>([])
const clipContextMenu = ref<ClipContextMenuState | null>(null)
const lastRemoved = ref<RemovedClip | null>(null)
const capturePaused = ref(storedSettings.capturePaused)
const captureHealth = ref<CaptureAvailability>({ available: !nativeRuntime, initialized: !nativeRuntime })
const clipboardSubscriptionReady = ref(true)
const captureHealthSubscriptionReady = ref(true)
const captureStateSubscriptionReady = ref(true)
const quitSubscriptionReady = ref(true)
const isComposing = ref(false)
const quickSearchComposing = ref(false)
const managerSearchComposing = ref(false)
const currentView = ref<AppView>('quick')
const librarySection = ref<LibrarySection>('all')
const theme = ref<Theme>(storedSettings.theme)
const locale = ref<Locale>(storedSettings.locale)
const toastMessage = ref('')
const toastUrgent = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const managerSearchInput = ref<HTMLInputElement | null>(null)
const libraryContent = ref<HTMLElement | null>(null)
const sensitiveAppInput = ref<HTMLInputElement | null>(null)
const sensitiveAppsTrigger = ref<HTMLButtonElement | null>(null)
const clearHistoryTrigger = ref<HTMLButtonElement | null>(null)
const retentionSelect = ref<HTMLSelectElement | null>(null)
const undoButton = ref<HTMLButtonElement | null>(null)
const libraryBackButton = ref<HTMLButtonElement | null>(null)
const previewPasteButton = ref<InstanceType<typeof ClipPreview> | null>(null)
const retentionDays = ref<RetentionPeriod>(storedRetentionPeriod)
const historyMaxRecords = ref(storedSettings.historyPolicy.maxRecords)
const historyMaxImageBytes = ref(storedSettings.historyPolicy.maxImageBytes)
const historyRetentionDays = ref<number | null>(storedSettings.historyPolicy.retentionDays)
const launchAtStartup = ref(storedSettings.launchAtStartup)
const hideDuringSharing = ref(storedSettings.hideDuringSharing)
const elevatedPasteEnabled = ref(storedSettings.elevatedPasteEnabled)
const excludedApps = ref([...storedSettings.excludedApps])
const sensitiveAppsOpen = ref(false)
const clearHistoryOpen = ref(false)
const pendingRetentionChange = ref<PendingRetentionChange | null>(null)
const sensitiveAppDraft = ref('')
const globalShortcut = ref(storedSettings.globalShortcut)
const globalShortcutAvailable = ref(!nativeRuntime)
const shortcutRecording = ref(false)
const targetApp = ref<string | null>(null)
const targetAppIcon = ref<string | null>(null)
const targetElevated = ref(false)
const quickPanelPinned = ref(storedSettings.quickPanelPinned)
const autoCheckUpdates = ref(storedSettings.autoCheckUpdates)
const ocrEnabled = ref(storedSettings.ocrEnabled)
const quickPanelPinInFlight = ref(false)
const windowModeTransitioning = ref(false)
const windowActionInFlight = ref(false)
const windowMaximized = ref(false)
const pasteInFlight = ref(false)
const shortcutApplyInFlight = ref(false)
const relativeTimeNow = ref(new Date())
const historyState = ref<HistoryState>(nativeRuntime ? 'loading' : 'ready')
const storageStats = ref<StorageStats | null>(null)
const historyHealth = ref<HistoryHealth | null>(null)
const preparedRestore = ref<PreparedRestore | null>(null)
const busyStorageOperation = ref<StorageOperation>(null)
const storageStatusMessage = ref('')
const nativeHistoryNextCursor = ref<string | undefined>(undefined)
const nativeHistoryTotalCount = ref(items.value.length)
const nativeHistoryPageLoading = ref(false)
const nativeHistoryRefreshGeneration = ref<number | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
let shortcutRecordingToastActive = false
let undoTimer: ReturnType<typeof setTimeout> | undefined
let targetExpiryTimer: ReturnType<typeof setTimeout> | undefined
let relativeTimeTimer: ReturnType<typeof setInterval> | undefined
let disconnectNativeClipboard: (() => void) | undefined
let disconnectPasteTarget: (() => void) | undefined
let disconnectQuickPanelSession: (() => void) | undefined
let disconnectCaptureState: (() => void) | undefined
let disconnectCaptureAvailability: (() => void) | undefined
let disconnectQuitRequested: (() => void) | undefined
let disconnectWindowMaximizedState: (() => void) | undefined
let appUnmounted = false
let quitFlushInProgress = false
let capturedSequence = 0
const pendingNativeCaptures: NativeCapturePayload[] = []
const deferredStorageCaptures: NativeCapturePayload[] = []
let nativeQueryGeneration = 0
let nativeQueryRefreshQueued = false
let nativeQueryRefreshForced = false
let nativeSearchDebounceTimer: ReturnType<typeof setTimeout> | undefined
let nativeAppliedQueryKey = ''
let storageRefreshGeneration = 0
let nativeRefreshAfterExclusive = false
let nativeRefreshAfterExclusiveForced = false
let suppressRetentionPolicySync = false
let previewLoadGeneration = 0
let suppressedNativeHistoryItems: ClipboardItem[] | null = null
let quickSessionGeneration = 0
let qrScanGeneration = 0
let systemActionGeneration = 0
let snippetSessionGeneration = 0
let collectionDeleteRestoreFocus: HTMLElement | null = null
let permanentSnippetDeleteRestoreFocus: HTMLElement | null = null
let windowModeGeneration = 0
let activeQuickSessionId = 0
let quickFirstFrameGeneration = 0
let quickFirstFrameAcknowledgedSessionId = 0
const nativeSettingsReady = ref(!nativeRuntime)
const {
  onboardingCompleted,
  onboardingPracticePending,
  onboardingStep,
  onboardingSampleBusy,
  onboardingDialog,
  onboardingSteps,
  currentOnboardingStep,
  onboardingPracticeVisible,
  finishOnboarding,
  finishOnboardingWithSample,
  dismissOnboardingPractice,
  focusOnboardingStep,
  advanceOnboarding,
} = useOnboarding({
  completed: storedSettings.onboardingCompleted,
  practicePending: storedSettings.onboardingPracticePending,
  nativeRuntime,
  globalShortcut,
  items,
  selectedId,
  searchInput,
  t,
  persistNativeSample: async (sample) => {
    const result = await runSerializedManagerOperation(() => applyNativeHistoryMutation({
      upserts: [sample],
      deleteIds: [],
      policy: currentHistoryPolicy(),
    }), 0)
    return result.status !== 'failed'
  },
  showToast,
})
// 字符串模板 ref 由 Vue 绑定，显式读取避免 TypeScript 将其误判为未使用。
void onboardingDialog
const {
  currentVersion,
  updateStatus,
  updateProgress,
  updateState,
  updateNoticeVisible,
  updateBusy,
  updateStatusText,
  hideUpdateNotice,
  runUpdateCheck,
  installAvailableUpdate,
  connectUpdaterBridge,
} = useUpdater({
  nativeRuntime,
  autoCheckUpdates,
  nativeSettingsReady,
  t,
  showToast,
  openSettings: () => openLibrary('settings'),
  flushHistory: flushHistoryWithRetry,
  isUnmounted: () => appUnmounted,
})
let restoreResultFocusAfterPreview = false
const hydratedPayloads = new Map<string, { generation: number; item: LoadedClipboardItem }>()
const pendingPayloadLoads = new Map<string, { generation: number; promise: Promise<LoadedClipboardItem | null> }>()
const pendingNativeUpserts = new Map<string, ClipboardItem>()
let storedOcrPumpGeneration = 0
let storedOcrPumpPromise: Promise<void> | null = null

const { syncBooleanSetting: syncNativeBooleanSetting, resetExcludedApps: resetNativeExcludedApps } = useNativeSettingsSync({
  nativeRuntime,
  ready: nativeSettingsReady,
  capturePaused,
  launchAtStartup,
  hideDuringSharing,
  elevatedPasteEnabled,
  excludedApps,
  t,
  showToast,
})

const retentionSelectValue = computed(() => (
  historyRetentionDays.value === null ? 'forever' : String(historyRetentionDays.value)
))
const customRetentionDays = computed(() => {
  const value = historyRetentionDays.value
  return value !== null && ![7, 30, 90].includes(value) ? value : null
})

const quickSearchIntent = computed(() => parseQuickSearch(query.value, quickSourceFilter.value))
const sourceSuggestions = computed(() => (
  quickSearchIntent.value.sourceFragment === undefined
    ? []
    : suggestSourceApps(knownSourceApps.value, quickSearchIntent.value.sourceFragment)
))
const visibleItems = computed(() => nativeRuntime
  ? items.value
  : applyClipFilter(items.value, {
      query: quickSearchIntent.value.text,
      kind: activeFilter.value,
      ...(quickSearchIntent.value.sourceApp
        ? { sourceApps: [quickSearchIntent.value.sourceApp] }
        : {}),
      ...(quickSearchIntent.value.permanent ? { permanent: true } : {}),
    }))

const directSearchHighlighter = computed(() => createSearchHighlighter(quickSearchIntent.value.text))
const managerSearchHighlighter = computed(() => createSearchHighlighter(managerQuery.value))

function highlightSegments(text: string) {
  return directSearchHighlighter.value.segments(text)
}

function managerHighlightSegments(text: string) {
  return managerSearchHighlighter.value.segments(text)
}

function hasVisibleSearchMatch(clip: ClipboardItem, manager = false): boolean {
  const highlighter = manager ? managerSearchHighlighter.value : directSearchHighlighter.value
  return [clip.title, clip.content, clip.sourceApp]
    .some((text) => highlighter.segments(text).some((segment) => segment.matched))
}

function isOcrOnlyMatch(clip: ClipboardItem, manager = false): boolean {
  const highlighter = manager ? managerSearchHighlighter.value : directSearchHighlighter.value
  return nativeRuntime && historyMatchBadge(clip, highlighter.hasTerms) === 'ocr'
}

function isPhoneticOnlyMatch(clip: ClipboardItem, manager = false): boolean {
  const highlighter = manager ? managerSearchHighlighter.value : directSearchHighlighter.value
  if (nativeRuntime && clip.payloadLoaded === false) {
    return historyMatchBadge(clip, highlighter.hasTerms) === 'index'
  }
  return highlighter.hasTerms
    && !hasVisibleSearchMatch(clip, manager)
}

function hasMissingFiles(clip: ClipboardItem): boolean {
  return clip.kind === 'file' && Boolean(clip.files?.some((file) => !file.exists))
}

function fileAvailabilityLabel(clip: ClipboardItem): string {
  const files = clip.files ?? []
  return t('fileAvailability', {
    available: files.filter((file) => file.exists).length,
    total: files.length,
  })
}

function ocrStatusLabel(clip: ClipboardItem): string {
  if (clip.ocrStatus === 'pending') return t('ocrPending')
  if (clip.ocrStatus === 'completed') return t('ocrCompleted')
  if (clip.ocrStatus === 'unavailable') return t('ocrUnavailable')
  if (clip.ocrStatus === 'oversized') return t('ocrOversized')
  return t('ocrFailed')
}

function searchPreviewText(text: string): string {
  return directSearchHighlighter.value.preview(text)
}

function quickClipText(clip: ClipboardItem): string {
  const title = clip.title.trim()
  const content = clip.content.trim()
  if (!content) return title

  if (isPhoneticOnlyMatch(clip)) return title || content

  const highlighter = directSearchHighlighter.value
  const titleMatches = highlighter.segments(title).some((segment) => segment.matched)
  const contentMatches = highlighter.segments(content).some((segment) => segment.matched)
  if (highlighter.hasTerms) {
    return searchPreviewText(titleMatches && !contentMatches ? title : content)
  }

  if (clip.kind === 'image') return title
  if (clip.kind === 'link') return searchPreviewText(content)
  if (clip.kind === 'file') {
    return (clip.files?.length ?? 0) > 1
      ? `${title} · ${searchPreviewText(content)}`
      : searchPreviewText(content)
  }

  const comparableTitle = title.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ')
  const comparableContent = content.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ')
  const titleRepeatsContent = !comparableTitle
    || comparableTitle === comparableContent
    || comparableContent.startsWith(comparableTitle)
    || comparableTitle.startsWith(comparableContent)
  return titleRepeatsContent ? searchPreviewText(content) : `${title} · ${searchPreviewText(content)}`
}

const selectedIndex = computed(() => visibleItems.value.findIndex((clip) => clip.id === selectedId.value))
const selectedClip = computed(() => visibleItems.value.find((clip) => clip.id === selectedId.value) ?? null)
const selectionAnnouncement = computed(() => {
  if (!selectedClip.value || selectedIndex.value < 0) return t('noClipboardSelection')
  return t('clipboardSelection', {
    position: selectedIndex.value + 1,
    count: visibleItems.value.length,
    title: selectedClip.value.title,
    source: selectedClip.value.sourceApp,
  })
})
const previewClip = computed(() => {
  const clip = items.value.find((candidate) => candidate.id === previewId.value)
  return clip ? cachedPayload(clip) : null
})
const previewCodeLanguage = computed(() => {
  const clip = previewClip.value
  return clip?.kind === 'code' ? inferCodeLanguage(clip.title, clip.content) : undefined
})
const shortcutConflictMessage = computed(() => {
  const conflict = shortcutConflict(globalShortcut.value)
  if (conflict === 'plainTextPaste') return t('shortcutConflictPlainTextPaste')
  if (conflict === 'pasteSpecial') return t('shortcutConflictPasteSpecial')
  return ''
})
watch(previewClip, (clip) => {
  const generation = ++qrScanGeneration
  qrResults.value = []
  qrScanState.value = 'idle'
  if (!clip || clip.kind !== 'image') return

  qrScanState.value = 'scanning'
  void detectNativeClipQr(clip.id).then((results) => {
    if (appUnmounted
      || generation !== qrScanGeneration
      || previewId.value !== clip.id) return
    if (results === null) {
      qrScanState.value = 'idle'
      return
    }
    qrResults.value = results
    qrScanState.value = 'complete'
  })
})
const contextMenuClip = computed(() => (
  clipContextMenu.value
    ? (() => {
        const clip = items.value.find((candidate) => candidate.id === clipContextMenu.value?.clipId)
        if (!clip) return null
        return cachedPayload(clip) ?? clip
      })()
    : null
))
const pinnedCount = computed(() => items.value.filter((clip) => clip.pinned).length)
const ordinaryHistoryCount = computed(() => items.value.filter((clip) => (
  !clip.pinned && clip.permanent !== true
)).length)
const ordinaryClearLabel = computed(() => t('clearOrdinaryHistory'))
const ordinaryClearDescription = computed(() => t('clearOrdinaryHistoryDescription', {
  count: ordinaryHistoryCount.value,
}))
const imageCount = computed(() => items.value.filter((clip) => clip.kind === 'image').length)
const captureAvailability = computed<'starting' | 'available' | 'unavailable'>(() => {
  if (!nativeRuntime) return 'available'
  if (!clipboardSubscriptionReady.value
    || !captureHealthSubscriptionReady.value
    || !captureStateSubscriptionReady.value) return 'unavailable'
  if (!captureHealth.value.initialized) return 'starting'
  return captureHealth.value.available ? 'available' : 'unavailable'
})
const captureStatusText = computed(() => {
  if (captureAvailability.value === 'starting') return t('captureStarting')
  if (captureAvailability.value === 'unavailable') return t('captureUnavailable')
  return capturePaused.value ? t('paused') : t('recording')
})
const libraryItems = computed(() => {
  if (nativeRuntime) return items.value
  const sectionItems = librarySection.value === 'pinned'
    ? items.value.filter((clip) => clip.pinned)
    : librarySection.value === 'images'
      ? items.value.filter((clip) => clip.kind === 'image')
      : items.value
  const filtered = sectionItems.filter((clip) => (
    (managerKinds.value.length === 0 || managerKinds.value.includes(clip.kind))
  ))
  return applyClipFilter(filtered, { query: managerQuery.value, kind: 'all' })
})
const managerSelectedCount = computed(() => countManagerSelection(managerSelection.value))
const managerTotalCount = computed(() => nativeRuntime ? nativeHistoryTotalCount.value : libraryItems.value.length)
const managerBulkSelectionState = computed(() => {
  try {
    return managerSelectionState(managerSelection.value, managerTotalCount.value)
  } catch {
    return 'none'
  }
})
const managerSelectionIncludesPinned = computed(() => {
  const selection = managerSelection.value
  if (selection.mode === 'allMatching') return true
  return libraryItems.value.some((clip) => selection.ids.has(clip.id) && clip.pinned)
})
const managerSelectionIncludesPermanent = computed(() => {
  const selection = managerSelection.value
  if (selection.mode === 'allMatching') return true
  return libraryItems.value.some((clip) => selection.ids.has(clip.id) && clip.permanent === true)
})
const managerSelectionBusy = computed(() => (
  managerOperationBusy.value || nativeHistoryRefreshGeneration.value !== null
))
const managerEmptyState = computed(() => {
  if (managerQuery.value.trim()) {
    return { icon: Search, title: t('noResults'), hint: t('noResultsHint'), canClear: true }
  }
  if (librarySection.value === 'images') {
    return { icon: ImageIcon, title: t('noImages'), hint: t('noImagesHint'), canClear: false }
  }
  if (librarySection.value === 'pinned') {
    return { icon: Pin, title: t('managerEmpty'), hint: t('managerEmptyHint'), canClear: false }
  }
  return { icon: Clock3, title: t('emptyHistory'), hint: t('emptyHistoryHint'), canClear: false }
})
const canAddSensitiveApp = computed(() => {
  const candidate = sensitiveAppDraft.value.trim()
  return Boolean(candidate)
    && !excludedApps.value.some((app) => app.toLocaleLowerCase() === candidate.toLocaleLowerCase())
})
const modalOverlayOpen = computed(() => (
  sensitiveAppsOpen.value
  || clearHistoryOpen.value
  || pendingRetentionChange.value !== null
  || collectionDeleteTarget.value !== null
  || permanentSnippetDeleteTarget.value !== null
  || snippetDraft.value !== null
))
const filters = computed<Array<{ id: ClipKindFilter; label: string }>>(() => [
  { id: 'all', label: t('all') },
  { id: 'text', label: t('text') },
  { id: 'code', label: t('code') },
  { id: 'link', label: t('link') },
  { id: 'image', label: t('image') },
  { id: 'pinned', label: t('pinned') },
])

const quickPanelState = computed(() => ({
  inert: onboardingStep.value >= 0 || modalOverlayOpen.value,
  nativeRuntime,
  quitSubscriptionReady: quitSubscriptionReady.value,
  captureAvailability: captureAvailability.value,
  capturePaused: capturePaused.value,
  captureStatusText: captureStatusText.value,
  targetApp: targetApp.value,
  targetAppIcon: targetAppIcon.value,
  targetElevated: targetElevated.value,
  quickPanelPinned: quickPanelPinned.value,
  quickPanelPinInFlight: quickPanelPinInFlight.value,
  nativeSettingsReady: nativeSettingsReady.value,
  theme: theme.value,
  windowModeTransitioning: windowModeTransitioning.value,
  windowActionInFlight: windowActionInFlight.value,
  query: query.value,
  quickSourceFilter: quickSourceFilter.value,
  permanentSearch: Boolean(quickSearchIntent.value.permanent),
  sourceSuggestions: sourceSuggestions.value,
  sourceSuggestionIndex: sourceSuggestionIndex.value,
  activeDescendant: previewId.value === null && selectedClip.value ? clipResultId(selectedClip.value.id) : undefined,
  filters: filters.value,
  activeFilter: activeFilter.value,
  pinnedCount: pinnedCount.value,
  onboardingPracticeVisible: onboardingPracticeVisible.value,
  globalShortcut: globalShortcut.value,
  previewActive: previewClip.value !== null,
  historyState: historyState.value,
  selectionAnnouncement: selectionAnnouncement.value,
  visibleItems: visibleItems.value,
  nativeHistoryTotalCount: nativeHistoryTotalCount.value,
  selectedId: selectedId.value,
  nativeHistoryNextCursor: nativeHistoryNextCursor.value,
  nativeHistoryPageLoading: nativeHistoryPageLoading.value,
  itemsCount: items.value.length,
  relativeTimeNow: relativeTimeNow.value,
  locale: locale.value,
}))

const quickPanelHelpers: QuickPanelHelpers = {
  t,
  kindIcon,
  highlightSegments,
  quickClipText,
  isOcrOnlyMatch: (clip) => isOcrOnlyMatch(clip),
  isPhoneticOnlyMatch: (clip) => isPhoneticOnlyMatch(clip),
  ocrStatusLabel,
  hasMissingFiles,
  fileAvailabilityLabel,
  clipResultId,
  directPasteTooltip,
  directPasteAriaShortcuts,
  directPasteLabel,
}

const libraryManagerState = computed(() => ({
  inert: modalOverlayOpen.value,
  section: librarySection.value,
  nativeRuntime,
  nativeHistoryTotalCount: nativeHistoryTotalCount.value,
  itemsCount: items.value.length,
  pinnedCount: pinnedCount.value,
  imageCount: imageCount.value,
  collections: collections.value,
  collectionEditor: collectionEditor.value,
  collectionError: collectionError.value,
  managerOperationBusy: managerOperationBusy.value,
  managerCollectionFilter: managerCollectionFilter.value,
  theme: theme.value,
  windowModeTransitioning: windowModeTransitioning.value,
  windowActionInFlight: windowActionInFlight.value,
  windowMaximized: windowMaximized.value,
  managerQuery: managerQuery.value,
  managerKinds: managerKinds.value,
  locale: locale.value,
  historyState: historyState.value,
  libraryItems: libraryItems.value,
  snippetLoading: snippetLoading.value,
  ordinaryHistoryCount: ordinaryHistoryCount.value,
  ordinaryClearLabel: ordinaryClearLabel.value,
  managerBulkToolbarKey: managerBulkToolbarKey.value,
  managerBulkSelectionState: managerBulkSelectionState.value,
  managerSelectedCount: managerSelectedCount.value,
  managerSelectionBusy: managerSelectionBusy.value,
  managerBatchError: managerBatchError.value,
  managerSelectionIncludesPinned: managerSelectionIncludesPinned.value,
  managerSelectionIncludesPermanent: managerSelectionIncludesPermanent.value,
  managerSelectedId: managerSelectedId.value,
  nativeHistoryNextCursor: nativeHistoryNextCursor.value,
  nativeHistoryPageLoading: nativeHistoryPageLoading.value,
  managerEmptyState: managerEmptyState.value,
  relativeTimeNow: relativeTimeNow.value,
}))

const libraryManagerHelpers: LibraryManagerHelpers = {
  t,
  kindIcon,
  managerHighlightSegments,
  isOcrOnlyMatch: (clip) => isOcrOnlyMatch(clip, true),
  isPhoneticOnlyMatch: (clip) => isPhoneticOnlyMatch(clip, true),
  ocrStatusLabel,
  hasMissingFiles,
  fileAvailabilityLabel,
  managerClipSelected,
}

function setManagerSearchElement(element: HTMLInputElement | null) {
  managerSearchInput.value = element
}

function setLibraryContentElement(element: HTMLElement | null) {
  libraryContent.value = element
}

function setLibraryBackButton(element: HTMLButtonElement | null) {
  libraryBackButton.value = element
}

function setClearHistoryTrigger(element: HTMLButtonElement | null) {
  clearHistoryTrigger.value = element
}

function setQuickSearchElement(element: HTMLInputElement | null) {
  searchInput.value = element
}

interface NativeQueryDescriptor {
  query: HistoryQuery
  impossible: boolean
}

function currentNativeQueryDescriptor(cursor?: string): NativeQueryDescriptor | null {
  if (!nativeRuntime || currentView.value === 'library' && librarySection.value === 'settings') return null

  let kinds: ClipKind[] = []
  let sourceApps: string[] = []
  let pinned: boolean | undefined
  let permanent: boolean | undefined
  let text = query.value
  let collection: HistoryQuery['collection'] = { mode: 'any' }
  let impossible = false

  if (currentView.value === 'quick') {
    text = quickSearchIntent.value.text
    sourceApps = quickSearchIntent.value.sourceApp ? [quickSearchIntent.value.sourceApp] : []
    permanent = quickSearchIntent.value.permanent ? true : undefined
    if (quickSearchIntent.value.sourceFragment !== undefined) impossible = true
    if (activeFilter.value !== 'all' && activeFilter.value !== 'pinned') kinds = [activeFilter.value]
    if (activeFilter.value === 'pinned') pinned = true
  } else {
    text = managerQuery.value
    kinds = [...managerKinds.value]
    collection = managerCollectionFilter.value === 'unfiled'
      ? { mode: 'unfiled' }
      : managerCollectionFilter.value.startsWith('collection:')
        ? { mode: 'collection', id: managerCollectionFilter.value.slice('collection:'.length) }
        : { mode: 'any' }
    if (librarySection.value === 'images') {
      impossible = kinds.length > 0 && !kinds.includes('image')
      kinds = ['image']
    }
    if (librarySection.value === 'pinned') {
      impossible = pinned === false
      pinned = true
    }
  }

  return {
    query: normalizeHistoryQuery({
      text,
      kinds,
      sourceApps,
      collection,
      ...(pinned === undefined ? {} : { pinned }),
      ...(permanent === undefined ? {} : { permanent }),
      limit: NATIVE_HISTORY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    }),
    impossible,
  }
}

function cachedPayload(clip: ClipboardItem): LoadedClipboardItem | null {
  if (clip.payloadLoaded !== false) return clip
  if (!nativeRuntime) return null
  const cached = hydratedPayloads.get(clip.id)
  return cached?.generation === nativeQueryGeneration ? cached.item : null
}

function invalidateNativePayloads() {
  previewLoadGeneration += 1
  hydratedPayloads.clear()
  pendingPayloadLoads.clear()
}

function currentHistoryPolicy(): CapacityPolicy {
  return {
    maxRecords: historyMaxRecords.value,
    maxImageBytes: historyMaxImageBytes.value,
    retentionDays: historyRetentionDays.value,
  }
}

function nativePersistenceTarget(visible: ClipboardItem[]): ClipboardItem[] {
  if (pendingNativeUpserts.size === 0) return visible
  let target = visible
  for (const clip of pendingNativeUpserts.values()) {
    target = mergeCapturedClipIntoHistory(
      target,
      clip,
      retentionDays.value,
      Math.max(historyMaxRecords.value, target.length + 1),
    )
  }
  return target
}

function handleCapacityPruned(ids: string[]) {
  const prunedIds = new Set(ids)
  for (const id of prunedIds) pendingNativeUpserts.delete(id)
  if (prunedIds.size > 0 && countManagerSelection(managerSelection.value) > 0) {
    clearManagerSelection()
    managerBulkToolbarKey.value += 1
  }
  if (!items.value.some((clip) => prunedIds.has(clip.id))) return

  const removedVisibleCount = items.value.filter((clip) => prunedIds.has(clip.id)).length
  items.value = items.value.filter((clip) => !prunedIds.has(clip.id))
  if (nativeRuntime) nativeHistoryTotalCount.value = Math.max(0, nativeHistoryTotalCount.value - removedVisibleCount)
  if (!visibleItems.value.some((clip) => clip.id === selectedId.value)) {
    selectedId.value = visibleItems.value[0]?.id ?? ''
  }
  if (!libraryItems.value.some((clip) => clip.id === managerSelectedId.value)) {
    managerSelectedId.value = libraryItems.value[0]?.id ?? ''
  }
  if (previewId.value && prunedIds.has(previewId.value)) {
    previewId.value = null
    restoreResultFocusAfterPreview = false
  }
  if (clipContextMenu.value && prunedIds.has(clipContextMenu.value.clipId)) {
    clipContextMenu.value = null
  }
  if (lastRemoved.value && prunedIds.has(lastRemoved.value.clip.id)) {
    lastRemoved.value = null
    if (undoTimer) clearTimeout(undoTimer)
    undoTimer = undefined
  }
}

const historyPersistence = createIncrementalHistoryPersistence(applyNativeHistoryMutation, {
  onSaveFailed: () => showToast(t('historySaveFailed'), true),
  onCapacityPruned: handleCapacityPruned,
})
const historyOperationLane = createSerializedHistoryOperationLane(historyPersistence)

function currentOcrItem(id: string): ClipboardItem | undefined {
  return pendingNativeUpserts.get(id) ?? items.value.find((item) => item.id === id)
}

function withOcrPatch(
  item: ClipboardItem,
  id: string,
  imageHash: string,
  patch: ExternalOcrPatch,
): ClipboardItem {
  if (item.id !== id
    || item.kind !== 'image'
    || item.imageHash !== imageHash
    || item.ocrStatus !== 'pending') return item
  if (item.payloadLoaded === false) {
    return { ...item, imageHash, ocrStatus: patch.ocrStatus }
  }
  const next: LoadedClipboardItem = { ...item, imageHash, ocrStatus: patch.ocrStatus }
  if (patch.ocrStatus === 'completed') next.ocrText = patch.ocrText
  else delete next.ocrText
  return next
}

const ocrCoordinator = createOcrCoordinator({
  enabled: () => nativeRuntime && ocrEnabled.value && !appUnmounted,
  getItem: currentOcrItem,
  recognize: recognizeNativeClipImage,
  fail: markNativeClipOcrFailed,
  acknowledge: (id, imageHash, patch) => (
    historyPersistence.acknowledgeExternalOcrPatch(id, imageHash, patch)
  ),
  apply: (id, imageHash, patch) => {
    const pending = pendingNativeUpserts.get(id)
    if (pending) pendingNativeUpserts.set(id, withOcrPatch(pending, id, imageHash, patch))
    items.value = items.value.map((item) => withOcrPatch(item, id, imageHash, patch))
  },
})

function resumePendingOcr(candidates: readonly ClipboardItem[] = items.value): void {
  if (!nativeRuntime || !ocrEnabled.value || appUnmounted) return
  // 新捕获会在持久化后直接入队；恢复路径从 SQLite 游标分页，避免只覆盖当前 UI 页。
  void candidates
  if (storedOcrPumpPromise) return
  const generation = storedOcrPumpGeneration
  const pump = pumpStoredPendingOcr(ocrCoordinator, {
    enabled: () => nativeRuntime && ocrEnabled.value && !appUnmounted,
    current: () => generation === storedOcrPumpGeneration,
    list: listNativePendingOcrImages,
  })
  storedOcrPumpPromise = pump
  void pump.finally(() => {
    if (storedOcrPumpPromise === pump) storedOcrPumpPromise = null
  })
}

function invalidateStoredOcrPump(): void {
  storedOcrPumpGeneration += 1
  storedOcrPumpPromise = null
}

async function refreshManagerCollections(): Promise<boolean> {
  if (!nativeRuntime) return false
  const loaded = await listNativeHistoryCollections()
  if (appUnmounted || loaded === null) return false
  collections.value = loaded
  if (managerCollectionFilter.value.startsWith('collection:')) {
    const id = managerCollectionFilter.value.slice('collection:'.length)
    if (!loaded.some((collection) => collection.id === id)) managerCollectionFilter.value = 'unfiled'
  }
  return true
}

async function replayDeferredManagerCaptures(): Promise<void> {
  const captures = deferredStorageCaptures.splice(0)
  if (captures.length === 0 || appUnmounted) return
  const replayed = await mergeNativeCaptures(captures, false)
  if (replayed) return
  for (const payload of captures) {
    pendingNativeCaptures.push(payload)
    if (pendingNativeCaptures.length > MAX_PENDING_NATIVE_CAPTURES) pendingNativeCaptures.shift()
  }
}

async function runSerializedManagerOperation<T>(
  mutate: () => Promise<T | null>,
  oldVisualIndex = Math.max(0, libraryItems.value.findIndex((clip) => clip.id === managerSelectedId.value)),
) {
  if (!nativeRuntime || managerOperationBusy.value || historyState.value !== 'ready') {
    return { status: 'failed' as const }
  }
  managerOperationBusy.value = true
  historyOperationLane.invalidate()
  nativeQueryGeneration += 1
  invalidateNativePayloads()
  let refreshedPage: HistoryPage | null = null
  let refreshedQueryKey = ''
  try {
    const result = await historyOperationLane.run({
      mutate,
      refresh: async () => {
        const descriptor = currentNativeQueryDescriptor()
        if (!descriptor) return null
        refreshedQueryKey = historyQueryKey(descriptor.query)
        refreshedPage = descriptor.impossible
          ? { items: [], totalCount: 0 }
          : await queryHistoryWithRetry(descriptor.query)
        if (!refreshedPage) return null
        const latest = currentNativeQueryDescriptor()
        if (!latest || historyQueryKey(latest.query) !== refreshedQueryKey) return null
        return { items: refreshedPage.items, policy: currentHistoryPolicy() }
      },
      commit: (snapshot) => {
        if (!refreshedPage) return
        pendingNativeUpserts.clear()
        const nextItems = pruneExpiredClips(snapshot.items, retentionDays.value)
        suppressedNativeHistoryItems = nextItems
        items.value = nextItems
        nativeHistoryNextCursor.value = refreshedPage.nextCursor
        nativeHistoryTotalCount.value = refreshedPage.totalCount
        nativeAppliedQueryKey = refreshedQueryKey
        historyState.value = 'ready'
        const focusedStillVisible = libraryItems.value.some((clip) => clip.id === managerSelectedId.value)
        if (!focusedStillVisible) {
          managerSelectedId.value = libraryItems.value[
            Math.min(oldVisualIndex, Math.max(0, libraryItems.value.length - 1))
          ]?.id ?? ''
        }
        nextTick(() => {
          if (suppressedNativeHistoryItems === nextItems) suppressedNativeHistoryItems = null
        })
      },
    })
    if (result.status === 'committedRefreshFailed' && !appUnmounted) {
      queueNativeHistoryRefresh(true)
    }
    return result
  } finally {
    managerOperationBusy.value = false
    await replayDeferredManagerCaptures()
  }
}

watch(items, (value, previous) => {
  knownSourceApps.value = suggestSourceApps([
    ...knownSourceApps.value,
    ...value.map((clip) => clip.sourceApp),
  ], '', 200)
  if (clipContextMenu.value && !value.some((clip) => clip.id === clipContextMenu.value?.clipId)) {
    closeClipContextMenu()
  }
  if (nativeRuntime) {
    if (suppressedNativeHistoryItems === value) {
      suppressedNativeHistoryItems = null
      return
    }
    if (historyState.value !== 'ready') return
    historyPersistence.schedule(previous, nativePersistenceTarget(value), currentHistoryPolicy())
  } else {
    writeStoredValue(ITEMS_STORAGE_KEY, value)
  }
}, { deep: true })

watch(retentionDays, () => {
  if (!suppressRetentionPolicySync) {
    historyRetentionDays.value = retentionDays.value === 'forever' ? null : Number(retentionDays.value)
  }
  if (!nativeRuntime || historyState.value !== 'ready') return
  historyPersistence.schedule(items.value, nativePersistenceTarget(items.value), currentHistoryPolicy())
})

watch(theme, (value) => {
  document.documentElement.dataset.theme = value
}, { immediate: true })

watch([theme, locale, retentionDays, historyMaxRecords, historyMaxImageBytes, historyRetentionDays, launchAtStartup, hideDuringSharing, elevatedPasteEnabled, capturePaused, excludedApps, globalShortcut, onboardingCompleted, onboardingPracticePending, quickPanelPinned, autoCheckUpdates, ocrEnabled], () => {
  writeStoredValue(SETTINGS_STORAGE_KEY, {
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    theme: theme.value,
    locale: locale.value,
    retentionDays: historyRetentionDays.value === null ? 'forever' : String(historyRetentionDays.value),
    historyPolicy: currentHistoryPolicy(),
    launchAtStartup: launchAtStartup.value,
    hideDuringSharing: hideDuringSharing.value,
    elevatedPasteEnabled: elevatedPasteEnabled.value,
    capturePaused: capturePaused.value,
    excludedApps: excludedApps.value,
    globalShortcut: globalShortcut.value,
    onboardingCompleted: onboardingCompleted.value,
    onboardingPracticePending: onboardingPracticePending.value,
    quickPanelPinned: quickPanelPinned.value,
    autoCheckUpdates: autoCheckUpdates.value,
    ocrEnabled: ocrEnabled.value,
  } satisfies StoredSettings)
}, { immediate: true, deep: true })

watch(locale, (value) => {
  document.documentElement.lang = value
}, { immediate: true })

watch(ocrEnabled, (enabled, previous) => {
  invalidateStoredOcrPump()
  ocrCoordinator.invalidate()
  syncNativeBooleanSetting('ocrEnabled', enabled, previous, async (value) => {
    const applied = await setNativeClipboardOcrEnabled(value)
    if (applied && value) resumePendingOcr([
      ...items.value,
      ...pendingNativeUpserts.values(),
    ])
    return applied
  }, (value) => {
    ocrEnabled.value = value
    if (value) resumePendingOcr([
      ...items.value,
      ...pendingNativeUpserts.values(),
    ])
  })
})

watch([currentView, librarySection, locale], () => {
  closeClipContextMenu()
  const sectionTitle = currentView.value === 'quick'
    ? t('quickPanel')
    : librarySection.value === 'settings'
      ? t('settings')
      : t('manageClipboard')
  document.title = `${t('productName')} · ${sectionTitle}`
  if (nativeRuntime && nativeSettingsReady.value) {
    if (currentView.value === 'library' && librarySection.value === 'settings') void refreshStorageState()
    else queueNativeHistoryRefresh()
  }
}, { immediate: true })

watch(visibleItems, (value) => {
  if (!value.some((clip) => clip.id === selectedId.value)) {
    selectedId.value = value[0]?.id ?? ''
  }
})

watch(sourceSuggestions, (value) => {
  sourceSuggestionIndex.value = Math.min(sourceSuggestionIndex.value, Math.max(0, value.length - 1))
})

watch(libraryItems, (value) => {
  if (!value.some((clip) => clip.id === managerSelectedId.value)) {
    managerSelectedId.value = value[0]?.id ?? ''
  }
})

watch(managerQuery, () => {
  closeClipContextMenu()
  managerSelectedId.value = libraryItems.value[0]?.id ?? ''
  nextTick(() => {
    const list = document.querySelector<HTMLElement>('.manager-list')
    if (list) list.scrollTop = 0
    if (libraryContent.value) libraryContent.value.scrollTop = 0
  })
  if (nativeRuntime
    && currentView.value === 'library'
    && librarySection.value !== 'settings'
    && !managerSearchComposing.value) scheduleNativeHistorySearchRefresh()
})

watch([managerKinds, managerCollectionFilter], () => {
  closeClipContextMenu()
  managerSelectedId.value = ''
  if (nativeRuntime && currentView.value === 'library' && librarySection.value !== 'settings') {
    queueNativeHistoryRefresh()
  }
}, { deep: true })

watch(
  [managerQuery, managerKinds, managerCollectionFilter, librarySection],
  () => {
    managerSelection.value = emptyManagerSelection()
    managerRangeAnchorId.value = undefined
    managerBatchError.value = ''
    historyOperationLane.invalidate()
  },
  { deep: true, flush: 'sync' },
)

watch(currentView, (view) => {
  historyOperationLane.invalidate()
  if (view === 'library') return
  managerSelection.value = emptyManagerSelection()
  managerRangeAnchorId.value = undefined
  managerBatchError.value = ''
})

watch([query, activeFilter, quickSourceFilter], () => {
  if (quickSearchIntent.value.sourceFragment !== undefined) sourceSuggestionIndex.value = 0
  closeClipContextMenu()
  selectedId.value = visibleItems.value[0]?.id ?? ''
  previewId.value = null
  nextTick(() => {
    const list = document.querySelector<HTMLElement>('.clip-list')
    if (list) list.scrollTop = 0
  })
})

watch(query, () => {
  if (nativeRuntime && currentView.value === 'quick' && !quickSearchComposing.value) {
    scheduleNativeHistorySearchRefresh()
  }
})

watch([activeFilter, quickSourceFilter], () => {
  if (nativeRuntime && currentView.value === 'quick') queueNativeHistoryRefresh()
})

function t(key: MessageKey, replacements?: Record<string, string | number>): string {
  return translate(locale.value, key, replacements)
}

function kindIcon(kind: ClipKind) {
  return {
    text: AlignLeft,
    code: Code2,
    link: Link2,
    image: ImageIcon,
    file: LayoutList,
  }[kind]
}

function sourceInitial(source: string): string {
  return Array.from(source.trim())[0]?.toLocaleUpperCase() ?? '?'
}

function showToast(message: string, urgent = false) {
  shortcutRecordingToastActive = false
  toastMessage.value = message
  toastUrgent.value = urgent
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = ''
    toastUrgent.value = false
    shortcutRecordingToastActive = false
  }, 2600)
}

function waitForHistoryRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, HISTORY_RETRY_DELAY_MS))
}

async function queryHistoryWithRetry(nativeQuery: HistoryQuery): Promise<HistoryPage | null> {
  for (let attempt = 0; attempt < HISTORY_RETRY_ATTEMPTS; attempt += 1) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), HISTORY_LOAD_TIMEOUT_MS)
    })
    const loaded = await Promise.race([queryNativeHistory(nativeQuery), timedOut])
    if (timeout) clearTimeout(timeout)
    if (loaded !== null) return loaded
    if (attempt < HISTORY_RETRY_ATTEMPTS - 1) await waitForHistoryRetry()
  }
  return null
}

async function applyNativeHistoryPage(
  page: HistoryPage,
  append: boolean,
  generation: number,
  queryKey: string,
  resolvedUpsertIds: string[],
): Promise<boolean> {
  for (const id of resolvedUpsertIds) pendingNativeUpserts.delete(id)
  const confirmed = append
    ? [...items.value, ...page.items.filter((item) => !items.value.some((current) => current.id === item.id))]
    : [...page.items]
  const nextItems = pruneExpiredClips(confirmed, retentionDays.value)
  const pending = append ? [] : pendingNativeCaptures.splice(0)
  for (const payload of pending) {
    const clip = createClipboardItem(payload, `captured-${Date.now()}-${capturedSequence++}`)
    pendingNativeUpserts.set(clip.id, clip)
  }

  if (appUnmounted || generation !== nativeQueryGeneration) return false
  historyPersistence.reset(confirmed, currentHistoryPolicy())
  suppressedNativeHistoryItems = nextItems
  items.value = nextItems
  nativeHistoryNextCursor.value = page.nextCursor
  nativeHistoryTotalCount.value = page.totalCount
  nativeAppliedQueryKey = queryKey
  historyState.value = 'ready'
  if (currentView.value === 'quick') {
    if (!append || !items.value.some((clip) => clip.id === selectedId.value)) {
      selectedId.value = items.value[0]?.id ?? ''
    }
  } else if (!append || !items.value.some((clip) => clip.id === managerSelectedId.value)) {
    managerSelectedId.value = items.value[0]?.id ?? ''
  }

  const persistenceTarget = nativePersistenceTarget(nextItems)
  const hasLocalDelta = nextItems.length !== confirmed.length || pendingNativeUpserts.size > 0
  if (hasLocalDelta) {
    historyPersistence.schedule(confirmed, persistenceTarget, currentHistoryPolicy())
    const saved = await historyPersistence.flush()
    if (!saved) return false
    if (appUnmounted || generation !== nativeQueryGeneration) return false
    if (pending.length > 0) queueNativeHistoryRefresh(true)
  }
  nextTick(() => {
    if (suppressedNativeHistoryItems === nextItems) suppressedNativeHistoryItems = null
  })
  resumePendingOcr(persistenceTarget)
  return true
}

async function runNativeHistoryQuery(append = false, force = false): Promise<boolean> {
  if (historyPersistence.isFrozen()) {
    nativeRefreshAfterExclusive = true
    nativeRefreshAfterExclusiveForced ||= force
    return false
  }
  const cursor = append ? nativeHistoryNextCursor.value : undefined
  const descriptor = currentNativeQueryDescriptor(cursor)
  if (!descriptor || append && (!cursor || nativeHistoryPageLoading.value)) return false

  const requestedKey = historyQueryKey(descriptor.query)
  if (!append && !force && historyState.value === 'ready' && requestedKey === nativeAppliedQueryKey) return true
  const generation = append ? nativeQueryGeneration : ++nativeQueryGeneration
  if (!append) {
    nativeHistoryRefreshGeneration.value = generation
    invalidateNativePayloads()
    previewId.value = null
    nativeHistoryNextCursor.value = undefined
  } else {
    nativeHistoryPageLoading.value = true
  }

  try {
    // SQLite 必须先观察到当前乐观 UI 的最后一次变更，查询结果才不会把旧元数据带回界面。
    const flushed = await historyPersistence.flush()
    if (appUnmounted || generation !== nativeQueryGeneration) return false
    const latestDescriptor = currentNativeQueryDescriptor()
    if (!latestDescriptor || historyQueryKey(latestDescriptor.query) !== requestedKey) return false
    if (!flushed) return false
    const resolvedUpsertIds = [...pendingNativeUpserts.keys()]

    if (descriptor.impossible) {
      return applyNativeHistoryPage({ items: [], totalCount: 0 }, false, generation, requestedKey, resolvedUpsertIds)
    }

    const page = await queryHistoryWithRetry(descriptor.query)
    if (appUnmounted || generation !== nativeQueryGeneration) return false
    const currentDescriptor = currentNativeQueryDescriptor()
    if (!currentDescriptor || historyQueryKey(currentDescriptor.query) !== requestedKey) return false
    if (!page) {
      historyState.value = 'error'
      return false
    }
    return applyNativeHistoryPage(page, append, generation, requestedKey, resolvedUpsertIds)
  } finally {
    if (append || generation === nativeQueryGeneration) nativeHistoryPageLoading.value = false
    if (!append && nativeHistoryRefreshGeneration.value === generation) {
      nativeHistoryRefreshGeneration.value = null
    }
  }
}

function cancelNativeHistorySearchRefresh() {
  if (nativeSearchDebounceTimer) clearTimeout(nativeSearchDebounceTimer)
  nativeSearchDebounceTimer = undefined
}

function scheduleNativeHistorySearchRefresh() {
  cancelNativeHistorySearchRefresh()
  nativeSearchDebounceTimer = setTimeout(() => {
    nativeSearchDebounceTimer = undefined
    queueNativeHistoryRefresh()
  }, NATIVE_SEARCH_DEBOUNCE_MS)
}

function queueNativeHistoryRefresh(force = false) {
  cancelNativeHistorySearchRefresh()
  if (!nativeRuntime
    || !nativeSettingsReady.value
    || historyState.value === 'error') return
  if (currentView.value === 'library' && librarySection.value === 'settings') {
    nativeRefreshAfterExclusive = true
    nativeRefreshAfterExclusiveForced ||= force
    return
  }
  if (historyPersistence.isFrozen()) {
    nativeRefreshAfterExclusive = true
    nativeRefreshAfterExclusiveForced ||= force
    return
  }
  if (nativeRefreshAfterExclusive) {
    force ||= nativeRefreshAfterExclusiveForced
    nativeRefreshAfterExclusive = false
    nativeRefreshAfterExclusiveForced = false
  }
  nativeQueryRefreshForced ||= force
  if (nativeQueryRefreshQueued) return
  nativeQueryRefreshQueued = true
  void nextTick(() => {
    nativeQueryRefreshQueued = false
    const shouldForce = nativeQueryRefreshForced
    nativeQueryRefreshForced = false
    if (!appUnmounted) void runNativeHistoryQuery(false, shouldForce)
  })
}

async function refreshStorageState(): Promise<boolean> {
  if (!nativeRuntime) return false
  const generation = ++storageRefreshGeneration
  const [health, stats] = await Promise.all([
    getNativeHistoryHealth(),
    getNativeStorageStats(),
  ])
  if (appUnmounted || generation !== storageRefreshGeneration) return false
  if (health) historyHealth.value = health
  if (stats) storageStats.value = stats
  return health !== null && stats !== null
}

async function acquireStorageOperationLease(
  operation: Exclude<StorageOperation, null | 'refresh'>,
  allowReadOnly = false,
): Promise<HistoryExclusiveLease | null> {
  if (busyStorageOperation.value !== null || !nativeRuntime || historyState.value !== 'ready') return null
  if (!allowReadOnly && historyHealth.value?.status === 'readOnlyError') {
    storageStatusMessage.value = t('storageOperationReadOnly')
    return null
  }

  busyStorageOperation.value = operation
  storageStatusMessage.value = ''
  nativeQueryGeneration += 1
  invalidateNativePayloads()
  try {
    return await historyPersistence.acquireExclusiveLease()
  } catch {
    busyStorageOperation.value = null
    storageStatusMessage.value = t('storageOperationPendingWrites')
    if (nativeRefreshAfterExclusive) queueNativeHistoryRefresh(nativeRefreshAfterExclusiveForced)
    return null
  }
}

async function releaseStorageOperationLease(lease: HistoryExclusiveLease): Promise<void> {
  lease.release()
  const captures = deferredStorageCaptures.splice(0)
  try {
    if (historyState.value === 'error') {
      for (const payload of captures) {
        pendingNativeCaptures.push(payload)
        if (pendingNativeCaptures.length > MAX_PENDING_NATIVE_CAPTURES) pendingNativeCaptures.shift()
      }
    } else if (!appUnmounted && captures.length > 0) {
      const replayed = await mergeNativeCaptures(captures)
      if (!replayed) {
        storageStatusMessage.value = t('storageDeferredCapturesPending')
      }
    }
  } catch {
    for (const payload of captures) {
      pendingNativeCaptures.push(payload)
      if (pendingNativeCaptures.length > MAX_PENDING_NATIVE_CAPTURES) pendingNativeCaptures.shift()
    }
    storageStatusMessage.value = t('storageDeferredCapturesRetry')
  } finally {
    const shouldRefresh = nativeRefreshAfterExclusive
    const forceRefresh = nativeRefreshAfterExclusiveForced
    nativeRefreshAfterExclusive = false
    nativeRefreshAfterExclusiveForced = false
    busyStorageOperation.value = null
    if (shouldRefresh && !appUnmounted) queueNativeHistoryRefresh(forceRefresh)
  }
}

async function reloadHistoryAfterRestore(): Promise<boolean> {
  const query = normalizeHistoryQuery({
    text: '',
    kinds: [],
    sourceApps: [],
    collection: { mode: 'any' },
    limit: NATIVE_HISTORY_PAGE_SIZE,
  })
  const generation = ++nativeQueryGeneration
  invalidateNativePayloads()
  nativeHistoryNextCursor.value = undefined
  const page = await queryHistoryWithRetry(query)
  if (!page || appUnmounted || generation !== nativeQueryGeneration) return false
  const resolvedUpsertIds = [...pendingNativeUpserts.keys()]
  return applyNativeHistoryPage(
    page,
    false,
    generation,
    historyQueryKey(query),
    resolvedUpsertIds,
  )
}

async function adoptRestoredHistoryPolicy(policy: CapacityPolicy): Promise<void> {
  suppressRetentionPolicySync = true
  historyMaxRecords.value = policy.maxRecords
  historyMaxImageBytes.value = policy.maxImageBytes
  historyRetentionDays.value = policy.retentionDays
  retentionDays.value = retentionPeriodForPolicy(policy)
  await nextTick()
  suppressRetentionPolicySync = false
}

async function createHistoryBackup() {
  if (preparedRestore.value) return
  const lease = await acquireStorageOperationLease('backup')
  if (!lease) return
  try {
    const result = await createNativeHistoryBackup()
    if (!result) {
      storageStatusMessage.value = t('storageBackupFailed')
      return
    }
    if (result.status === 'cancelled') {
      storageStatusMessage.value = t('storageBackupCancelled')
      return
    }
    storageStatusMessage.value = t('storageBackupSaved')
    const stats = await getNativeStorageStats()
    if (stats && !appUnmounted) storageStats.value = stats
  } finally {
    await releaseStorageOperationLease(lease)
  }
}

async function prepareHistoryRestore() {
  if (preparedRestore.value) return
  const lease = await acquireStorageOperationLease('prepare-restore')
  if (!lease) return
  try {
    const result = await prepareNativeHistoryRestore()
    if (!result) {
      storageStatusMessage.value = t('storageRestoreValidationFailed')
      return
    }
    if (result.status === 'cancelled') {
      storageStatusMessage.value = t('storageRestoreCancelled')
      return
    }
    preparedRestore.value = result
    storageStatusMessage.value = t('storageRestoreValidated')
  } finally {
    await releaseStorageOperationLease(lease)
  }
}

async function commitHistoryRestore(token: string) {
  if (!preparedRestore.value || preparedRestore.value.token !== token) return
  const lease = await acquireStorageOperationLease('commit-restore')
  if (!lease) return
  try {
    invalidateStoredOcrPump()
    ocrCoordinator.invalidate()
    if (!await invalidateNativeClipboardOcr()) {
      storageStatusMessage.value = t('storageRestoreOcrInvalidationFailed')
      return
    }
    const result = await commitNativeHistoryRestore(token)
    if (!result) {
      preparedRestore.value = null
      storageStatusMessage.value = t('storageRestoreCommitFailed')
      return
    }

    preparedRestore.value = null
    storageRefreshGeneration += 1
    storageStats.value = result.stats
    await adoptRestoredHistoryPolicy(result.policy)
    historyState.value = 'loading'
    const reloaded = await reloadHistoryAfterRestore()
    if (!reloaded) {
      historyState.value = 'error'
      storageStatusMessage.value = t('storageRestoreReloadFailed')
      return
    }
    await refreshManagerCollections()
    await refreshStorageState()
    storageStatusMessage.value = t('storageRestoreCompleted', { count: result.importedCount })
  } finally {
    await releaseStorageOperationLease(lease)
    if (!appUnmounted && ocrEnabled.value) resumePendingOcr()
  }
}

async function discardHistoryRestore(token: string) {
  if (!preparedRestore.value || preparedRestore.value.token !== token) return
  const lease = await acquireStorageOperationLease('discard-restore', true)
  if (!lease) return
  try {
    const result = await discardNativeHistoryRestore(token)
    if (!result) {
      storageStatusMessage.value = t('storageRestoreDiscardFailed')
      return
    }
    preparedRestore.value = null
    storageStatusMessage.value = t('storageRestoreCancelled')
  } finally {
    await releaseStorageOperationLease(lease)
  }
}

async function compactHistoryDatabase() {
  if (preparedRestore.value) return
  const lease = await acquireStorageOperationLease('compact')
  if (!lease) return
  try {
    const stats = await compactNativeHistoryDatabase()
    if (!stats) {
      storageStatusMessage.value = t('storageCompactionFailed')
      return
    }
    storageStats.value = stats
    storageStatusMessage.value = t('storageCompactionCompleted')
  } finally {
    await releaseStorageOperationLease(lease)
  }
}

async function refreshHistoryStorage() {
  if (busyStorageOperation.value !== null) return
  busyStorageOperation.value = 'refresh'
  storageStatusMessage.value = ''
  try {
    const refreshed = await refreshStorageState()
    storageStatusMessage.value = refreshed
      ? t('storageStatsRefreshed')
      : t('storageStatsUnavailable')
  } finally {
    busyStorageOperation.value = null
  }
}

async function openHistoryDataDirectory() {
  const opened = await openNativeHistoryDataDirectory()
  storageStatusMessage.value = opened
    ? t('storageDirectoryOpened')
    : t('storageDirectoryOpenFailed')
}

function loadMoreNativeHistory() {
  if (!nativeRuntime) return
  void runNativeHistoryQuery(true)
}

async function retryHistoryLoad() {
  if (!nativeRuntime || historyState.value === 'loading') return
  const retryView = currentView.value
  historyState.value = 'loading'
  const loaded = await runNativeHistoryQuery(false)
  if (appUnmounted) return
  if (!loaded) {
    historyState.value = 'error'
    nextTick(() => document.querySelector<HTMLElement>('[data-testid="history-retry"]')?.focus())
    return
  }
  if (retryView === currentView.value) nextTick(focusCurrentSurfaceFallback)
}

async function flushHistoryWithRetry(): Promise<boolean> {
  for (let attempt = 0; attempt < HISTORY_RETRY_ATTEMPTS; attempt += 1) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), HISTORY_QUIT_FLUSH_TIMEOUT_MS)
    })
    const saved = await Promise.race([historyPersistence.flush(), timedOut])
    if (timeout) clearTimeout(timeout)
    if (saved) return true
    if (attempt < HISTORY_RETRY_ATTEMPTS - 1) await waitForHistoryRetry()
  }
  return false
}

function pinClip(id: string, focusSurface?: ClipFocusSurface) {
  const surfaceItems = focusSurface === 'manager' ? libraryItems.value : visibleItems.value
  const changedIndex = surfaceItems.findIndex((clip) => clip.id === id)
  const nextFocusId = changedIndex < 0
    ? null
    : surfaceItems[changedIndex + 1]?.id ?? surfaceItems[changedIndex - 1]?.id ?? null

  items.value = togglePinned(items.value, id)
  if (nativeRuntime && currentNativeQueryDescriptor()?.query.pinned !== undefined) {
    queueNativeHistoryRefresh(true)
  }
  const remainsVisible = focusSurface === 'manager'
    ? libraryItems.value.some((clip) => clip.id === id)
    : visibleItems.value.some((clip) => clip.id === id)
  if (!focusSurface || remainsVisible) return

  if (focusSurface === 'quick') {
    if (previewId.value === id) previewId.value = null
    selectedId.value = nextFocusId ?? ''
  } else {
    managerSelectedId.value = nextFocusId ?? ''
  }
  nextTick(() => {
    if (focusSurface === 'quick') {
      const nextResult = nextFocusId
        ? document.querySelector<HTMLElement>(`[data-clip-id="${nextFocusId}"] .clip-primary`)
        : null
      ;(nextResult ?? searchInput.value)?.focus()
      return
    }
    const nextPinAction = nextFocusId
      ? document.querySelector<HTMLElement>(`[data-testid="manager-pin-${nextFocusId}"]`)
      : null
    ;(nextPinAction ?? managerSearchInput.value)?.focus()
  })
}

function deleteClip(id: string, focusSurface?: ClipFocusSurface) {
  const clip = items.value.find((item) => item.id === id)
  if (clip?.permanent === true) {
    if (managerOperationBusy.value || permanentSnippetDeleteTarget.value) return
    permanentSnippetDeleteRestoreFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    permanentSnippetDeleteTarget.value = { id: clip.id, title: clip.title }
    permanentSnippetDeleteError.value = ''
    nextTick(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="manager-cancel-delete-permanent"]')?.focus()
    })
    return
  }
  deleteClipImmediately(id, focusSurface)
}

function deleteClipImmediately(id: string, focusSurface?: ClipFocusSurface) {
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const focusedRow = focusSurface === 'quick'
    ? activeElement?.closest<HTMLElement>('.clip-row')
    : focusSurface === 'manager'
      ? activeElement?.closest<HTMLElement>('.manager-row')
      : null
  const focusedRowId = focusSurface === 'quick'
    ? focusedRow?.dataset.clipId
    : focusedRow?.dataset.managerClipId
  const managerAction = focusSurface === 'manager'
    ? activeElement?.dataset.testid?.match(/^manager-(copy|pin|delete)-/)?.[1] ?? 'row'
    : null
  const surfaceItems = focusSurface === 'manager' ? libraryItems.value : visibleItems.value
  const removedIndex = surfaceItems.findIndex((clip) => clip.id === id)
  const nextFocusId = removedIndex < 0
    ? null
    : surfaceItems[removedIndex + 1]?.id ?? surfaceItems[removedIndex - 1]?.id ?? null

  const result = removeClip(items.value, id)
  if (!result.undo) return
  items.value = result.items
  if (focusSurface === 'manager') {
    clearManagerSelection()
    managerBulkToolbarKey.value += 1
  }
  if (nativeRuntime) nativeHistoryTotalCount.value = Math.max(0, nativeHistoryTotalCount.value - 1)
  lastRemoved.value = result.undo
  if (previewId.value === id) previewId.value = null
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = setTimeout(() => {
    const undoHadFocus = document.activeElement === undoButton.value
    lastRemoved.value = null
    undoTimer = undefined
    if (undoHadFocus) nextTick(focusCurrentSurfaceFallback)
  }, DELETE_UNDO_TIMEOUT_MS)

  if (focusedRowId !== id) return
  if (focusSurface === 'quick') selectedId.value = nextFocusId ?? ''
  else if (focusSurface === 'manager') managerSelectedId.value = nextFocusId ?? ''
  nextTick(() => {
    if (focusSurface === 'quick') {
      const nextResult = nextFocusId
        ? document.querySelector<HTMLElement>(`[data-clip-id="${nextFocusId}"] .clip-primary`)
        : null
      ;(nextResult ?? searchInput.value)?.focus()
      return
    }
    const managerSelector = managerAction === 'row'
      ? `[data-manager-clip-id="${nextFocusId}"]`
      : `[data-testid="manager-${managerAction}-${nextFocusId}"]`
    const nextManagerAction = nextFocusId
      ? document.querySelector<HTMLElement>(managerSelector)
      : null
    ;(nextManagerAction ?? managerSearchInput.value)?.focus()
  })
}

function restoreFocus(element: HTMLElement | null) {
  nextTick(() => element?.focus())
}

function focusCurrentSurfaceFallback() {
  if (currentView.value === 'quick') {
    searchInput.value?.focus()
  } else if (librarySection.value === 'settings') {
    libraryBackButton.value?.focus()
  } else {
    ;(managerSearchInput.value ?? libraryBackButton.value)?.focus()
  }
}

function closeClipContextMenu(restoreSourceFocus = false) {
  const menu = clipContextMenu.value
  if (!menu) return
  clipContextMenu.value = null
  if (!restoreSourceFocus) return
  nextTick(() => {
    if (menu.restoreFocus?.isConnected) {
      menu.restoreFocus.focus({ preventScroll: true })
    } else {
      focusCurrentSurfaceFallback()
    }
  })
}

function openClipContextMenu(
  clipId: string,
  surface: ClipContextSurface,
  x: number,
  y: number,
  restoreFocus: HTMLElement | null,
) {
  if (modalOverlayOpen.value || onboardingStep.value >= 0) return
  if (!items.value.some((clip) => clip.id === clipId)) return
  if (surface === 'manager') managerSelectedId.value = clipId
  else selectedId.value = clipId
  clipContextMenu.value = { clipId, surface, x, y, restoreFocus }
}

function contextMenuTarget(target: Element) {
  const managerRow = target.closest<HTMLElement>('[data-manager-clip-id]')
  if (managerRow?.dataset.managerClipId) {
    return { clipId: managerRow.dataset.managerClipId, surface: 'manager' as const, host: managerRow }
  }
  const preview = target.closest<HTMLElement>('[data-preview-clip-id]')
  if (preview?.dataset.previewClipId) {
    return { clipId: preview.dataset.previewClipId, surface: 'preview' as const, host: preview }
  }
  const quickRow = target.closest<HTMLElement>('[data-clip-id]')
  if (quickRow?.dataset.clipId) {
    return { clipId: quickRow.dataset.clipId, surface: 'quick' as const, host: quickRow }
  }
  return null
}

function contextRestoreTarget(target: Element, surface: ClipContextSurface, host: HTMLElement) {
  const focusedControl = target.closest<HTMLElement>('button, a, [tabindex]')
  if (focusedControl) return focusedControl
  if (surface === 'quick') return host.querySelector<HTMLElement>('.clip-primary')
  if (surface === 'preview') return previewPasteButton.value?.primaryButton() ?? null
  return host
}

function isEditableContextTarget(target: Element): boolean {
  const input = target.closest<HTMLInputElement>('input')
  if (input) return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(input.type)
  return Boolean(target.closest('textarea, [contenteditable]:not([contenteditable="false"])'))
}

function preservesNativeManagerSelectionKeys(target: EventTarget | null): boolean {
  return target instanceof Element
    && (isEditableContextTarget(target) || Boolean(target.closest('select')))
}

function handleContextMenu(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return
  if (isEditableContextTarget(target)) {
    closeClipContextMenu()
    return
  }

  event.preventDefault()
  const contextTarget = contextMenuTarget(target)
  if (!contextTarget || modalOverlayOpen.value || onboardingStep.value >= 0) {
    closeClipContextMenu()
    return
  }
  const bounds = contextTarget.host.getBoundingClientRect()
  const x = event.clientX || bounds.left + 18
  const y = event.clientY || bounds.bottom - 4
  openClipContextMenu(
    contextTarget.clipId,
    contextTarget.surface,
    x,
    y,
    contextRestoreTarget(target, contextTarget.surface, contextTarget.host),
  )
}

function handleContextMenuPointerDown(event: PointerEvent) {
  if (!clipContextMenu.value) return
  const target = event.target instanceof Element ? event.target : null
  if (!target?.closest('[data-testid="clip-context-menu"]')) closeClipContextMenu()
}

function handleContextMenuScroll() {
  closeClipContextMenu()
}

function openKeyboardContextMenu(target: Element): boolean {
  const contextTarget = contextMenuTarget(target)
  if (!contextTarget) return false
  const bounds = contextTarget.host.getBoundingClientRect()
  openClipContextMenu(
    contextTarget.clipId,
    contextTarget.surface,
    bounds.left + Math.min(28, bounds.width / 2),
    bounds.bottom - 4,
    contextRestoreTarget(target, contextTarget.surface, contextTarget.host),
  )
  return true
}

function runContextPreview() {
  const clip = contextMenuClip.value
  if (!clip) return
  closeClipContextMenu()
  openPreview(clip.id)
}

async function runContextAction(action: ClipAction) {
  const clip = contextMenuClip.value
  if (!clip || action.disabled) return
  const actionSurface = clipContextMenu.value?.surface === 'manager' ? 'manager' : 'quick'
  closeClipContextMenu(true)
  if (action.pasteMode) {
    await pasteClip(clip, action.pasteMode)
    return
  }
  if (action.id === 'copy') {
    await copyClip(clip)
    return
  }

  const generation = ++systemActionGeneration
  const sessionGeneration = quickSessionGeneration
  const actionView = currentView.value
  const isCurrentAction = () => !appUnmounted
    && generation === systemActionGeneration
    && sessionGeneration === quickSessionGeneration
    && actionView === currentView.value
    && items.value.some((item) => item.id === clip.id)
  const actionClip = await resolveClipPayload(clip)
  if (!actionClip || !isCurrentAction()) {
    if (!actionClip && isCurrentAction()) showToast(t('historyUnavailable'), true)
    return
  }
  const resolvedAction = getClipActions(actionClip, actionSurface)
    .find((candidate) => candidate.id === action.id)
  let succeeded = false
  let succeededFileActions = 0
  let attemptedFileActions = 0
  if (!resolvedAction || resolvedAction.disabled) {
    succeeded = false
  } else if (action.id === 'open-link') {
    succeeded = await openExternalLink(actionClip.content)
  } else if (action.id === 'open-file' || action.id === 'reveal-file') {
    const availableFiles = actionClip.files?.filter((file) => file.exists) ?? []
    attemptedFileActions = availableFiles.length
    for (const file of availableFiles) {
      const completed = action.id === 'open-file'
        ? await openFilePath(file.path)
        : await revealFilePath(file.path)
      if (completed) succeededFileActions += 1
      if (!isCurrentAction()) return
    }
    succeeded = attemptedFileActions > 0 && succeededFileActions === attemptedFileActions
  } else if (action.id === 'save-image' && actionClip.imageUrl) {
    const result = await saveClipboardImage(actionClip.imageUrl)
    if (!isCurrentAction()) return
    if (result === 'cancelled') return
    succeeded = result === 'saved'
  }

  if (!isCurrentAction()) return
  if (succeededFileActions > 0 && succeededFileActions < attemptedFileActions) {
    showToast(t('systemActionPartiallyCompleted', {
      succeeded: succeededFileActions,
      total: attemptedFileActions,
    }), true)
  } else if (!succeeded) {
    showToast(t('systemActionFailed'), true)
  } else if (action.id === 'reveal-file') {
    showToast(t('revealedInExplorer'))
  } else if (action.id === 'save-image') {
    showToast(t('imageSaved'))
  } else {
    showToast(t('openedWithSystem'))
  }
}

function openSensitiveApps(trigger?: HTMLButtonElement) {
  if (trigger) sensitiveAppsTrigger.value = trigger
  cancelShortcutRecording()
  sensitiveAppsOpen.value = true
  nextTick(() => sensitiveAppInput.value?.focus())
}

function closeSensitiveApps() {
  sensitiveAppsOpen.value = false
  sensitiveAppDraft.value = ''
  restoreFocus(sensitiveAppsTrigger.value)
}

function requestClearHistory() {
  if (ordinaryHistoryCount.value <= 0) return
  clearHistoryOpen.value = true
  nextTick(() => document.querySelector<HTMLElement>('[data-testid="cancel-clear-history"]')?.focus())
}

function closeClearHistory() {
  clearHistoryOpen.value = false
  restoreFocus(clearHistoryTrigger.value)
}

function retentionPeriodLabel(value: RetentionPeriod): string {
  return value === 'forever' ? t('forever') : t('daysOption', { count: value })
}

function applyRetentionPeriod(value: RetentionPeriod) {
  const controlChanged = retentionDays.value !== value
  historyRetentionDays.value = value === 'forever' ? null : Number(value)
  retentionDays.value = value
  if (!controlChanged && nativeRuntime && historyState.value === 'ready') {
    historyPersistence.schedule(items.value, nativePersistenceTarget(items.value), currentHistoryPolicy())
  }
}

function requestRetentionChange(event: Event) {
  const select = event.target as HTMLSelectElement
  retentionSelect.value = select
  if (historyState.value !== 'ready') {
    select.value = retentionSelectValue.value
    return
  }
  const value = select.value as RetentionPeriod
  if (!['7', '30', '90', 'forever'].includes(value)) return
  const numericValue = value === 'forever' ? null : Number(value)
  if (numericValue === historyRetentionDays.value) return

  const nextItems = pruneExpiredClips(items.value, value)
  const removedCount = items.value.length - nextItems.length
  if (removedCount === 0) {
    applyRetentionPeriod(value)
    items.value = nextItems
    showToast(t('retentionUpdated', { period: retentionPeriodLabel(value) }))
    return
  }

  pendingRetentionChange.value = { value, removedCount }
  nextTick(() => document.querySelector<HTMLElement>('[data-testid="cancel-retention-change"]')?.focus())
}

function closeRetentionChange() {
  pendingRetentionChange.value = null
  if (retentionSelect.value) retentionSelect.value.value = retentionSelectValue.value
  restoreFocus(retentionSelect.value)
}

function confirmRetentionChange() {
  const pending = pendingRetentionChange.value
  if (!pending) return
  applyRetentionPeriod(pending.value)
  items.value = pruneExpiredClips(items.value, pending.value)
  pendingRetentionChange.value = null
  if (!items.value.some((clip) => clip.id === selectedId.value)) {
    selectedId.value = items.value[0]?.id ?? ''
  }
  showToast(t('retentionUpdated', { period: retentionPeriodLabel(pending.value) }))
  restoreFocus(retentionSelect.value)
}

function trapModalFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const dialog = event.currentTarget as HTMLElement | null
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute('hidden'))
  if (focusable.length === 0) return

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function confirmClearHistory() {
  const result = clearUnpinnedHistory(items.value)
  items.value = result.items
  if (nativeRuntime) nativeHistoryTotalCount.value = Math.max(0, nativeHistoryTotalCount.value - result.removedCount)
  clearHistoryOpen.value = false
  lastRemoved.value = null
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = undefined
  previewId.value = null
  selectedId.value = items.value[0]?.id ?? ''
  showToast(t('ordinaryHistoryCleared', { count: result.removedCount }))
  nextTick(() => managerSearchInput.value?.focus())
}

function undoDelete() {
  const restoredId = lastRemoved.value?.clip.id ?? null
  items.value = restoreClip(items.value, lastRemoved.value)
  if (nativeRuntime && restoredId) nativeHistoryTotalCount.value += 1
  if (restoredId) selectedId.value = restoredId
  lastRemoved.value = null
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = undefined
  nextTick(() => {
    if (!restoredId) return
    if (currentView.value === 'quick') {
      const restoredResult = document.querySelector<HTMLElement>(`[data-clip-id="${restoredId}"] .clip-primary`)
      ;(restoredResult ?? searchInput.value)?.focus()
    } else {
      const restoredAction = document.querySelector<HTMLElement>(`[data-manager-clip-id="${restoredId}"] .manager-actions button`)
      if (restoredAction) restoredAction.focus()
      else focusCurrentSurfaceFallback()
    }
  })
}

function setFilter(filter: ClipKindFilter, focusSearch = true) {
  activeFilter.value = filter
  previewId.value = null
  if (focusSearch) nextTick(() => searchInput.value?.focus())
}

function handleFilterKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const lastIndex = filters.value.length - 1
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? lastIndex
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + filters.value.length) % filters.value.length
  const filter = filters.value[nextIndex]
  if (!filter) return
  setFilter(filter.id, false)
  nextTick(() => {
    document.querySelector<HTMLElement>(`[data-testid="filter-${filter.id}"]`)?.focus()
  })
}

function clearSearchAndFocus(resetFilter = false) {
  query.value = ''
  quickSourceFilter.value = ''
  if (resetFilter) activeFilter.value = 'all'
  nextTick(() => searchInput.value?.focus())
}

function clearQuickSourceFilter() {
  quickSourceFilter.value = ''
  nextTick(() => searchInput.value?.focus())
}

function selectSourceSuggestion(sourceApp: string) {
  if (!sourceSuggestions.value.includes(sourceApp)) return
  const remainingText = quickSearchIntent.value.text
  quickSourceFilter.value = sourceApp
  query.value = remainingText
  sourceSuggestionIndex.value = 0
  nextTick(() => searchInput.value?.focus())
}

function clearManagerSearch() {
  managerQuery.value = ''
  nextTick(() => managerSearchInput.value?.focus())
}

function startSearchComposition(surface: ClipFocusSurface) {
  cancelNativeHistorySearchRefresh()
  isComposing.value = true
  if (surface === 'quick') quickSearchComposing.value = true
  else managerSearchComposing.value = true
}

function finishSearchComposition(surface: ClipFocusSurface) {
  isComposing.value = false
  if (surface === 'quick') quickSearchComposing.value = false
  else managerSearchComposing.value = false
  if (nativeRuntime
    && (surface === 'quick' && currentView.value === 'quick'
      || surface === 'manager' && currentView.value === 'library' && librarySection.value !== 'settings')) {
    scheduleNativeHistorySearchRefresh()
  }
}

function cancelSearchComposition(surface: ClipFocusSurface) {
  isComposing.value = false
  if (surface === 'quick') quickSearchComposing.value = false
  else managerSearchComposing.value = false
}

function resetQuickSession(focusSearch = true) {
  quickSessionGeneration += 1
  closeClipContextMenu()
  query.value = ''
  quickSourceFilter.value = ''
  sourceSuggestionIndex.value = 0
  managerQuery.value = ''
  activeFilter.value = 'all'
  previewId.value = null
  lastRemoved.value = null
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = undefined
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = undefined
  toastMessage.value = ''
  toastUrgent.value = false
  shortcutRecordingToastActive = false
  sensitiveAppsOpen.value = false
  sensitiveAppDraft.value = ''
  clearHistoryOpen.value = false
  pendingRetentionChange.value = null
  collectionEditor.value = null
  collectionDeleteTarget.value = null
  permanentSnippetDeleteTarget.value = null
  permanentSnippetDeleteError.value = ''
  permanentSnippetDeleteRestoreFocus = null
  collectionDeleteRestoreFocus = null
  collectionError.value = ''
  snippetSessionGeneration += 1
  snippetDraft.value = null
  snippetError.value = ''
  clearManagerSelection()
  shortcutRecording.value = false
  isComposing.value = false
  quickSearchComposing.value = false
  managerSearchComposing.value = false
  restoreResultFocusAfterPreview = false
  selectedId.value = onboardingPracticePending.value
    && items.value.some((clip) => clip.id === ONBOARDING_SAMPLE_ID)
    ? ONBOARDING_SAMPLE_ID
    : items.value[0]?.id ?? ''
  nextTick(() => {
    const list = document.querySelector<HTMLElement>('.clip-list')
    if (list) list.scrollTop = 0
    if (focusSearch && currentView.value === 'quick' && onboardingStep.value < 0) {
      searchInput.value?.focus()
    }
  })
}

async function toggleQuickPanelPinned() {
  if (quickPanelPinInFlight.value) return
  const previous = quickPanelPinned.value
  quickPanelPinned.value = !previous
  quickPanelPinInFlight.value = true
  try {
    if (nativeRuntime && !await setQuickPanelPinned(quickPanelPinned.value)) {
      quickPanelPinned.value = previous
      showToast(t('settingApplyFailed'), true)
    }
  } finally {
    quickPanelPinInFlight.value = false
  }
}

async function resolveClipPayload(clip: ClipboardItem): Promise<LoadedClipboardItem | null> {
  const available = cachedPayload(clip)
  if (available) return available

  const generation = nativeQueryGeneration
  const pending = pendingPayloadLoads.get(clip.id)
  if (pending?.generation === generation) return pending.promise

  const promise = (async () => {
    const result = await loadNativeClipPayload(clip.id)
    if (appUnmounted
      || generation !== nativeQueryGeneration
      || !items.value.some((candidate) => candidate.id === clip.id)) return null
    if (result.status !== 'loaded') return null
    hydratedPayloads.set(clip.id, { generation, item: result.item })
    return result.item
  })()
  pendingPayloadLoads.set(clip.id, { generation, promise })
  try {
    return await promise
  } finally {
    const current = pendingPayloadLoads.get(clip.id)
    if (current?.promise === promise) pendingPayloadLoads.delete(clip.id)
  }
}

async function openPreview(id: string) {
  selectedId.value = id
  const clip = items.value.find((candidate) => candidate.id === id)
  if (!clip) return
  if (cachedPayload(clip)) {
    previewId.value = id
    restoreResultFocusAfterPreview = false
    return
  }
  const generation = ++previewLoadGeneration
  const payload = await resolveClipPayload(clip)
  if (!payload
    || appUnmounted
    || generation !== previewLoadGeneration
    || selectedId.value !== id
    || !items.value.some((candidate) => candidate.id === id)) {
    if (!payload && generation === previewLoadGeneration && items.value.some((candidate) => candidate.id === id)) {
      showToast(t('historyUnavailable'), true)
    }
    return
  }
  previewId.value = id
  restoreResultFocusAfterPreview = false
}

function closePreview() {
  previewLoadGeneration += 1
  restoreResultFocusAfterPreview = true
  previewId.value = null
}

function focusCurrentView() {
  nextTick(() => {
    if (currentView.value === 'library') libraryBackButton.value?.focus()
    else if (onboardingStep.value < 0) searchInput.value?.focus()
  })
}

function focusCurrentQuickContent() {
  nextTick(() => {
    if (previewId.value) {
      previewPasteButton.value?.focusPrimary()
    } else if (restoreResultFocusAfterPreview) {
      restoreResultFocusAfterPreview = false
      document.querySelector<HTMLElement>(`[data-clip-id="${selectedId.value}"] .clip-primary`)?.focus()
    }
  })
}

async function pasteClip(clip: ClipboardItem, mode: PasteMode = defaultPasteMode(clip)) {
  if (pasteInFlight.value) return
  const sessionGeneration = quickSessionGeneration
  const pasteTargetLabel = targetApp.value ?? t('currentApp')
  pasteInFlight.value = true
  try {
    const payload = await resolveClipPayload(clip)
    if (!payload || sessionGeneration !== quickSessionGeneration) {
      if (!payload && sessionGeneration === quickSessionGeneration) showToast(t('historyUnavailable'), true)
      return
    }
    const action = getClipActions(payload, 'quick').find((candidate) => candidate.pasteMode === mode)
    if (!action || action.disabled) return
    const result = mode === 'files'
      ? await pasteFiles(payload.files ?? [])
      : mode === 'preserve'
        ? await pasteFormats(payload.content, payload.html, payload.rtfBase64)
        : mode === 'image' && payload.imageUrl
          ? await pasteImage(payload.imageUrl)
          : await pasteText(payload.content)
    if (sessionGeneration !== quickSessionGeneration) return
    if (payload.id === ONBOARDING_SAMPLE_ID && result.pasted) {
      onboardingPracticePending.value = false
    }
    showToast(result.requiresElevation
      ? t('elevatedPasteApprovalRequired')
      : result.pasted
      ? t('pastedTo', { app: pasteTargetLabel })
      : result.copied
        ? t('pasteFallbackCopied', { app: pasteTargetLabel })
      : t('clipboardUnavailable'), result.requiresElevation || !result.pasted)
    return result.pasted || result.copied
  } finally {
    pasteInFlight.value = false
  }
}

function pastePreviewClip(mode?: PasteMode) {
  const clip = previewClip.value
  if (clip) void pasteClip(clip, mode)
}

async function useClipFromDoubleClick(clip: ClipboardItem) {
  const used = await pasteClip(clip)
  if (!used) return

  items.value = promoteUsedClip(items.value, clip.id)
  selectedId.value = clip.id
  if (nativeRuntime) queueNativeHistoryRefresh(true)
}

async function copyClip(clip: ClipboardItem) {
  const sessionGeneration = quickSessionGeneration
  const payload = await resolveClipPayload(clip)
  if (!payload || sessionGeneration !== quickSessionGeneration) {
    if (!payload && sessionGeneration === quickSessionGeneration) showToast(t('historyUnavailable'), true)
    return
  }
  const copied = payload.kind === 'image' && payload.imageUrl
    ? await copyImage(payload.imageUrl)
    : await copyText(payload.content)
  if (sessionGeneration !== quickSessionGeneration) return
  showToast(copied ? t('copiedFrom', { source: payload.sourceApp }) : t('clipboardUnavailable'), !copied)
}

async function pasteRecognizedText(text: string) {
  if (pasteInFlight.value || !text) return
  const sessionGeneration = quickSessionGeneration
  const pasteTargetLabel = targetApp.value ?? t('currentApp')
  pasteInFlight.value = true
  try {
    const result = await pasteText(text)
    if (sessionGeneration !== quickSessionGeneration) return
    showToast(result.requiresElevation
      ? t('elevatedPasteApprovalRequired')
      : result.pasted
        ? t('pastedTo', { app: pasteTargetLabel })
        : result.copied
          ? t('pasteFallbackCopied', { app: pasteTargetLabel })
          : t('clipboardUnavailable'), result.requiresElevation || !result.pasted)
  } finally {
    pasteInFlight.value = false
  }
}

async function copyRecognizedText(text: string, sourceApp: string) {
  if (!text) return
  const sessionGeneration = quickSessionGeneration
  const copied = await copyText(text)
  if (sessionGeneration !== quickSessionGeneration) return
  showToast(copied ? t('copiedFrom', { source: sourceApp }) : t('clipboardUnavailable'), !copied)
}

async function openQrLink(value: string) {
  if (!isSafeExternalUrl(value)) return
  const opened = await openExternalLink(value)
  showToast(opened ? t('qrLinkOpened') : t('qrLinkOpenFailed'), !opened)
}

async function mergeNativeCaptures(payloads: NativeCapturePayload[], announce = true): Promise<boolean> {
  if (payloads.length === 0) return true
  const clips = payloads.map((payload) => (
    createClipboardItem(payload, `captured-${Date.now()}-${capturedSequence++}`)
  ))
  if (!nativeRuntime) {
    for (const clip of clips) {
      items.value = mergeCapturedClipIntoHistory(items.value, clip, retentionDays.value, MAX_HISTORY_ITEMS)
    }
    const latest = clips.at(-1)!
    selectedId.value = latest.id
    if (announce) showToast(latest.kind === 'image' ? t('capturedImage') : t('capturedContent'))
    return true
  }

  for (const clip of clips) pendingNativeUpserts.set(clip.id, clip)
  const persistenceTarget = nativePersistenceTarget(items.value)
  historyPersistence.schedule(items.value, persistenceTarget, currentHistoryPolicy())
  const saved = await historyPersistence.flush()
  if (!saved || appUnmounted) return false
  for (const clip of clips) {
    const persisted = persistenceTarget.find((candidate) => candidate.id === clip.id)
    // 批量回放也逐个接纳；队列溢出的失败写回必须完成后再处理下一条。
    if (persisted) await ocrCoordinator.enqueue(persisted)
  }
  const latest = clips.at(-1)!
  if (announce) showToast(latest.kind === 'image' ? t('capturedImage') : t('capturedContent'))
  queueNativeHistoryRefresh(true)
  return true
}

async function mergeNativeCapture(payload: NativeCapturePayload, announce = true): Promise<boolean> {
  return mergeNativeCaptures([payload], announce)
}

function acceptNativeCapture(payload: NativeCapturePayload) {
  if (capturePaused.value) return
  if (nativeRuntime && historyPersistence.isFrozen()) {
    deferredStorageCaptures.push(payload)
    if (deferredStorageCaptures.length > MAX_PENDING_NATIVE_CAPTURES) deferredStorageCaptures.shift()
    return
  }
  if (nativeRuntime && historyState.value !== 'ready') {
    pendingNativeCaptures.push(payload)
    if (pendingNativeCaptures.length > MAX_PENDING_NATIVE_CAPTURES) pendingNativeCaptures.shift()
    if (historyState.value === 'loading') showToast(t('historyLoading'))
    return
  }

  void mergeNativeCapture(payload)
}

function clipResultId(id: string): string {
  return `clip-result-${id}`
}

function selectIndexWithKeyboard(index: number, moveFocus = false) {
  const lastIndex = visibleItems.value.length - 1
  const nextIndex = lastIndex < 0 ? -1 : Math.min(Math.max(index, 0), lastIndex)
  selectedId.value = visibleItems.value[nextIndex]?.id ?? ''
  nextTick(() => {
    const row = document.querySelector<HTMLElement>(`[data-clip-id="${selectedId.value}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    if (moveFocus) row?.querySelector<HTMLElement>('.clip-primary')?.focus()
  })
}

function selectWithKeyboard(delta: number, moveFocus = false) {
  selectIndexWithKeyboard(moveSelection(selectedIndex.value, delta, visibleItems.value.length), moveFocus)
}

function directPasteNumber(index: number): string {
  return index === DIRECT_PASTE_ITEM_COUNT - 1 ? '0' : String(index + 1)
}

function directPasteLabel(index: number): string {
  return `Alt ${directPasteNumber(index)}`
}

function directPasteAriaShortcuts(index: number): string | undefined {
  if (index >= DIRECT_PASTE_ITEM_COUNT) return undefined
  const key = directPasteNumber(index)
  return `Alt+${key} Control+${key}`
}

function directPasteTooltip(index: number): string {
  return index < DIRECT_PASTE_ITEM_COUNT
    ? t('clipPasteHintDirect', { shortcut: directPasteLabel(index) })
    : t('clipPasteHint')
}

function focusManagerIndex(index: number) {
  const lastIndex = libraryItems.value.length - 1
  const nextIndex = lastIndex < 0 ? -1 : Math.min(Math.max(index, 0), lastIndex)
  managerSelectedId.value = libraryItems.value[nextIndex]?.id ?? ''
  nextTick(() => {
    const row = document.querySelector<HTMLElement>(`[data-manager-clip-id="${managerSelectedId.value}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    ;(row ?? managerSearchInput.value)?.focus()
  })
}

function clearManagerSelection() {
  managerSelection.value = emptyManagerSelection()
  managerRangeAnchorId.value = undefined
  managerBatchError.value = ''
}

function selectManagerCollection(filter: ManagerCollectionFilter) {
  managerCollectionFilter.value = filter
  if (librarySection.value === 'settings') selectLibrarySection('all')
}

function managerClipCoordinate(clip: ClipboardItem) {
  return { id: clip.id, copiedAt: clip.copiedAt }
}

function managerClipSelected(clip: ClipboardItem): boolean {
  return isManagerItemSelected(managerSelection.value, managerClipCoordinate(clip))
}

function toggleManagerClipSelection(clip: ClipboardItem, contiguous = false) {
  if (managerSelectionBusy.value) return
  try {
    managerSelection.value = contiguous
      ? selectManagerRange(
          managerSelection.value,
          libraryItems.value.map((item) => item.id),
          clip.id,
          managerRangeAnchorId.value,
        )
      : toggleManagerSelection(managerSelection.value, managerClipCoordinate(clip))
    if (!contiguous || managerRangeAnchorId.value === undefined) managerRangeAnchorId.value = clip.id
    managerBatchError.value = ''
  } catch {
    managerBatchError.value = t('managerSelectionUpdateFailed')
  }
}

function selectAllManagerMatches() {
  if (managerSelectionBusy.value) return
  if (managerBulkSelectionState.value === 'all') {
    clearManagerSelection()
    return
  }
  const descriptor = currentNativeQueryDescriptor()
  const upperBoundClip = libraryItems.value[0]
  if (!descriptor || descriptor.impossible || !upperBoundClip || managerTotalCount.value === 0) {
    clearManagerSelection()
    return
  }
  try {
    managerSelection.value = createAllMatchingSelection(
      descriptor.query,
      managerClipCoordinate(upperBoundClip),
      managerTotalCount.value,
    )
    managerRangeAnchorId.value = managerSelectedId.value || upperBoundClip.id
    managerBatchError.value = ''
  } catch {
    managerBatchError.value = t('managerSelectAllFailed')
  }
}

function handleManagerRowClick(event: MouseEvent, clip: ClipboardItem) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
  managerSelectedId.value = clip.id
  toggleManagerClipSelection(clip, event.shiftKey)
}

function focusCurrentManagerRow() {
  nextTick(() => {
    const row = managerSelectedId.value
      ? libraryContent.value?.querySelector<HTMLElement>(`[data-manager-clip-id="${managerSelectedId.value}"]`)
      : null
    ;(row ?? managerSearchInput.value)?.focus()
  })
}

async function applyManagerBatch(action: BatchAction) {
  if (managerSelectedCount.value === 0 || managerSelectionBusy.value) return
  const descriptor = currentNativeQueryDescriptor()
  if (!descriptor) return
  let target
  try {
    target = toBatchTarget(managerSelection.value, descriptor.query)
  } catch {
    managerBatchError.value = t('managerSelectionStale')
    return
  }
  const oldVisualIndex = Math.max(0, libraryItems.value.findIndex((clip) => clip.id === managerSelectedId.value))
  const focusBeforeOperation = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  managerBatchError.value = ''
  const result = await runSerializedManagerOperation(
    () => applyNativeHistoryBatch(target, action),
    oldVisualIndex,
  )
  if (result.status === 'failed') {
    managerBatchError.value = t('managerBatchFailed')
    await nextTick()
    if (action.type === 'delete' && focusBeforeOperation?.isConnected) {
      focusBeforeOperation.focus()
    } else {
      const row = managerSelectedId.value
        ? libraryContent.value?.querySelector<HTMLElement>(`[data-manager-clip-id="${managerSelectedId.value}"]`)
        : null
      ;(row ?? managerSearchInput.value)?.focus()
    }
    return
  }
  clearManagerSelection()
  managerBulkToolbarKey.value += 1
  if (action.type === 'delete') {
    lastRemoved.value = null
    if (undoTimer) clearTimeout(undoTimer)
    undoTimer = undefined
  }
  focusCurrentManagerRow()
}

function beginCreateCollection() {
  if (managerOperationBusy.value) return
  collectionEditor.value = { mode: 'create', name: '' }
  collectionError.value = ''
  nextTick(() => document.querySelector<HTMLInputElement>('[data-testid="manager-collection-name"]')?.focus())
}

function beginRenameCollection(collection: Collection) {
  if (managerOperationBusy.value) return
  collectionEditor.value = { mode: 'rename', id: collection.id, name: collection.name }
  collectionError.value = ''
  nextTick(() => document.querySelector<HTMLInputElement>('[data-testid="manager-collection-name"]')?.focus())
}

function closeCollectionEditor() {
  if (managerOperationBusy.value) return
  collectionEditor.value = null
  collectionError.value = ''
}

function updateCollectionEditorName(event: Event) {
  if (!collectionEditor.value) return
  collectionEditor.value = {
    ...collectionEditor.value,
    name: (event.target as HTMLInputElement).value,
  }
}

async function saveCollectionEditor() {
  const editor = collectionEditor.value
  if (!editor || managerOperationBusy.value) return
  let name: string
  try {
    name = normalizeCollectionName(editor.name, collections.value, editor.id)
  } catch {
    collectionError.value = t('managerCollectionNameInvalid')
    return
  }
  collectionError.value = ''
  const result = await runSerializedManagerOperation(() => editor.mode === 'create'
    ? createNativeHistoryCollection(name)
    : renameNativeHistoryCollection(editor.id!, name))
  if (result.status === 'failed') {
    collectionError.value = t('managerCollectionSaveFailed')
    return
  }
  const saved = result.value
  collections.value = editor.mode === 'create'
    ? [...collections.value, saved].sort((left, right) => left.sortOrder - right.sortOrder)
    : collections.value.map((collection) => collection.id === saved.id ? saved : collection)
  collectionEditor.value = null
}

function requestDeleteCollection(collection: Collection, event?: Event) {
  if (managerOperationBusy.value) return
  collectionDeleteRestoreFocus = event?.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  collectionDeleteTarget.value = collection
  collectionError.value = ''
  nextTick(() => document.querySelector<HTMLButtonElement>('[data-testid="manager-confirm-delete-collection"]')?.focus())
}

function closeDeleteCollection() {
  if (managerOperationBusy.value) return
  collectionDeleteTarget.value = null
  const restoreTarget = collectionDeleteRestoreFocus
  collectionDeleteRestoreFocus = null
  nextTick(() => {
    if (restoreTarget?.isConnected) restoreTarget.focus()
  })
}

async function confirmDeleteCollection() {
  const collection = collectionDeleteTarget.value
  if (!collection || managerOperationBusy.value) return
  const result = await runSerializedManagerOperation(() => deleteNativeHistoryCollection(collection.id))
  if (result.status === 'failed') {
    collectionError.value = t('managerCollectionDeleteFailed')
    return
  }
  collections.value = collections.value.filter((candidate) => candidate.id !== collection.id)
  if (managerCollectionFilter.value === `collection:${collection.id}`) {
    managerCollectionFilter.value = 'unfiled'
  }
  collectionDeleteTarget.value = null
  collectionDeleteRestoreFocus = null
  clearManagerSelection()
  managerBulkToolbarKey.value += 1
  focusCurrentManagerRow()
}

function closeDeletePermanentSnippet() {
  if (managerOperationBusy.value) return
  permanentSnippetDeleteTarget.value = null
  permanentSnippetDeleteError.value = ''
  const restoreTarget = permanentSnippetDeleteRestoreFocus
  permanentSnippetDeleteRestoreFocus = null
  nextTick(() => {
    if (restoreTarget?.isConnected) restoreTarget.focus()
  })
}

async function confirmDeletePermanentSnippet() {
  const target = permanentSnippetDeleteTarget.value
  if (!target || managerOperationBusy.value) return
  if (!nativeRuntime) {
    permanentSnippetDeleteTarget.value = null
    permanentSnippetDeleteRestoreFocus = null
    deleteClipImmediately(target.id, 'manager')
    lastRemoved.value = null
    if (undoTimer) clearTimeout(undoTimer)
    undoTimer = undefined
    return
  }

  const oldVisualIndex = Math.max(
    0,
    libraryItems.value.findIndex((clip) => clip.id === target.id),
  )
  permanentSnippetDeleteError.value = ''
  const result = await runSerializedManagerOperation(
    () => applyNativeHistoryBatch(
      { mode: 'ids', ids: [target.id] },
      { type: 'delete' },
    ),
    oldVisualIndex,
  )
  if (result.status === 'failed') {
    permanentSnippetDeleteError.value = t('managerPermanentDeleteFailed')
    nextTick(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="manager-confirm-delete-permanent"]')?.focus()
    })
    return
  }
  permanentSnippetDeleteTarget.value = null
  permanentSnippetDeleteRestoreFocus = null
  lastRemoved.value = null
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = undefined
  clearManagerSelection()
  managerBulkToolbarKey.value += 1
  focusCurrentManagerRow()
}

function openNewSnippet() {
  if (managerOperationBusy.value || snippetLoading.value) return
  snippetSessionGeneration += 1
  snippetEditorKey.value += 1
  snippetError.value = ''
  snippetDraft.value = {
    title: '',
    content: '',
    kind: 'text',
    ...(managerCollectionFilter.value.startsWith('collection:')
      ? { collectionId: managerCollectionFilter.value.slice('collection:'.length) }
      : {}),
  }
}

async function openSnippetEditor(clip: ClipboardItem) {
  if (!clip.permanent || (clip.kind !== 'text' && clip.kind !== 'code') || snippetLoading.value) return
  const generation = ++snippetSessionGeneration
  snippetLoading.value = true
  snippetError.value = ''
  try {
    const payload = await resolveClipPayload(clip)
    if (generation !== snippetSessionGeneration
      || appUnmounted
      || currentView.value !== 'library'
      || !payload
      || !payload.permanent
      || (payload.kind !== 'text' && payload.kind !== 'code')) return
    snippetEditorKey.value += 1
    snippetDraft.value = {
      id: payload.id,
      title: payload.title,
      content: payload.content,
      kind: payload.kind,
      ...(payload.collectionId === undefined ? {} : { collectionId: payload.collectionId }),
    }
  } finally {
    if (generation === snippetSessionGeneration) snippetLoading.value = false
  }
}

function updateSnippetDraft(draft: SnippetDraft) {
  snippetDraft.value = draft
  snippetError.value = ''
}

function closeSnippetEditor() {
  if (managerOperationBusy.value) return
  snippetSessionGeneration += 1
  snippetDraft.value = null
  snippetError.value = ''
}

async function saveSnippet(draft: SnippetDraft) {
  if (managerOperationBusy.value) return
  snippetDraft.value = draft
  snippetError.value = ''
  const result = await runSerializedManagerOperation(() => saveNativeHistorySnippet(draft))
  if (result.status === 'failed') {
    snippetError.value = t('managerSnippetSaveFailed')
    return
  }
  snippetSessionGeneration += 1
  snippetDraft.value = null
  managerSelectedId.value = libraryItems.value.some((clip) => clip.id === result.value.id)
    ? result.value.id
    : managerSelectedId.value
  focusCurrentManagerRow()
}

function handleManagerSearchArrowDown(event: KeyboardEvent) {
  if (event.isComposing || isComposing.value) return
  event.preventDefault()
  focusManagerIndex(0)
}

function handleManagerRowKeydown(event: KeyboardEvent, index: number, clipId: string) {
  if (event.target !== event.currentTarget) return
  if (event.isComposing || isComposing.value) return
  const clip = libraryItems.value.find((item) => item.id === clipId)
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    focusManagerIndex(index + (event.key === 'ArrowDown' ? 1 : -1))
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    focusManagerIndex(event.key === 'Home' ? 0 : libraryItems.value.length - 1)
  } else if (event.key === 'Delete') {
    event.preventDefault()
    deleteClip(clipId, 'manager')
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const clip = items.value.find((item) => item.id === clipId)
    if (clip) void pasteClip(clip)
  } else if (event.key === ' ' && clip) {
    event.preventDefault()
    toggleManagerClipSelection(clip, event.shiftKey)
  } else if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'c') {
    event.preventDefault()
    const clip = items.value.find((item) => item.id === clipId)
    if (clip) void copyClip(clip)
  }
}

async function openLibrary(section: LibrarySection = 'all') {
  if (windowModeTransitioning.value) return
  const generation = ++windowModeGeneration
  windowModeTransitioning.value = true
  currentView.value = 'library'
  selectLibrarySection(section)
  previewId.value = null
  const applied = !nativeRuntime || await setWindowMode('library')
  if (generation !== windowModeGeneration) return
  if (!applied) {
    currentView.value = 'quick'
    showToast(t('windowModeFailed'), true)
    nextTick(() => searchInput.value?.focus())
  }
  windowModeTransitioning.value = false
}

async function returnToQuickPanel() {
  if (windowModeTransitioning.value) return
  const generation = ++windowModeGeneration
  windowModeTransitioning.value = true
  currentView.value = 'quick'
  const applied = !nativeRuntime || await setWindowMode('quick')
  if (generation !== windowModeGeneration) return
  if (!applied) {
    currentView.value = 'library'
    showToast(t('windowModeFailed'), true)
    nextTick(() => libraryBackButton.value?.focus())
  } else {
    resetQuickSession()
  }
  windowModeTransitioning.value = false
}

function selectLibrarySection(section: LibrarySection) {
  if (librarySection.value === 'settings' && section !== 'settings') {
    cancelShortcutRecording()
  }
  if (section === 'settings') managerQuery.value = ''
  librarySection.value = section
  if (section !== 'settings') managerSelectedId.value = libraryItems.value[0]?.id ?? ''
  nextTick(() => {
    if (libraryContent.value) libraryContent.value.scrollTop = 0
  })
}

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}

async function performWindowAction(action: WindowAction) {
  if (windowModeTransitioning.value || windowActionInFlight.value) return
  const sessionGeneration = quickSessionGeneration
  const modeGeneration = windowModeGeneration
  const actionView = currentView.value
  windowActionInFlight.value = true
  try {
    const isCurrentAction = () => sessionGeneration === quickSessionGeneration
      && modeGeneration === windowModeGeneration
      && actionView === currentView.value
    const completed = await runWindowAction(action, undefined, isCurrentAction)
    if (!isCurrentAction()) return
    if (!completed) {
      showToast(t('windowActionFailed'), true)
      return
    }
    if (action === 'close' && currentView.value === 'quick') {
      resetQuickSession(false)
    }
  } finally {
    windowActionInFlight.value = false
  }
}

function handleWindowBlur() {
  closeClipContextMenu()
  if (currentView.value === 'quick' && !quickPanelPinned.value && !pasteInFlight.value) {
    resetQuickSession(false)
  }
}

function addSensitiveApp() {
  const app = sensitiveAppDraft.value.trim()
  if (!canAddSensitiveApp.value) return
  excludedApps.value.push(app)
  sensitiveAppDraft.value = ''
  nextTick(() => sensitiveAppInput.value?.focus())
}

function removeSensitiveApp(app: string) {
  const removedIndex = excludedApps.value.indexOf(app)
  excludedApps.value = excludedApps.value.filter((current) => current !== app)
  nextTick(() => {
    const removeButtons = [...document.querySelectorAll<HTMLElement>('.sensitive-app-row button')]
    const nextButton = removeButtons[Math.min(Math.max(removedIndex, 0), removeButtons.length - 1)]
    ;(nextButton ?? sensitiveAppInput.value)?.focus()
  })
}

function startShortcutRecording() {
  if (shortcutApplyInFlight.value) return
  shortcutRecording.value = true
  showToast(t('shortcutRecordingHint'))
  shortcutRecordingToastActive = true
}

function cancelShortcutRecording(announce = false) {
  const wasRecording = shortcutRecording.value
  shortcutRecording.value = false
  if (shortcutRecordingToastActive) {
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = undefined
    toastMessage.value = ''
    toastUrgent.value = false
    shortcutRecordingToastActive = false
  }
  if (announce && wasRecording) showToast(t('shortcutRecordingCancelled'))
}

async function applyRecordedShortcut(shortcut: string) {
  if (shortcutApplyInFlight.value) return
  cancelShortcutRecording()
  shortcutApplyInFlight.value = true
  try {
    const applied = !nativeRuntime || await setGlobalShortcut(shortcut)
    if (!applied) {
      showToast(t('shortcutUnavailable'), true)
      return
    }

    globalShortcut.value = shortcut
    globalShortcutAvailable.value = true
    showToast(t('shortcutUpdated', { shortcut: displayShortcut(shortcut) }))
  } finally {
    shortcutApplyInFlight.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (modalOverlayOpen.value) {
    if (event.key === 'Escape' && !event.isComposing && !isComposing.value) {
      event.preventDefault()
      if (pendingRetentionChange.value) closeRetentionChange()
      else if (clearHistoryOpen.value) closeClearHistory()
      else if (sensitiveAppsOpen.value) closeSensitiveApps()
      else if (collectionDeleteTarget.value) closeDeleteCollection()
      else if (permanentSnippetDeleteTarget.value) closeDeletePermanentSnippet()
      else if (snippetDraft.value) closeSnippetEditor()
    }
    return
  }

  if (shortcutRecording.value) {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      cancelShortcutRecording(true)
      return
    }

    const shortcut = captureShortcut(event)
    if (shortcut) void applyRecordedShortcut(shortcut)
    return
  }

  if (event.isComposing || isComposing.value) return

  if (onboardingStep.value >= 0) {
    if (event.key === 'Escape') finishOnboarding()
    return
  }

  if (clipContextMenu.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeClipContextMenu(true)
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
    }
    // 菜单打开时仅由菜单自身处理按键，避免全局快捷键作用到背后的列表。
    return
  }

  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    const target = event.target instanceof Element ? event.target : null
    if (target && openKeyboardContextMenu(target)) {
      event.preventDefault()
      return
    }
  }

  if (event.key === 'Escape') {
    if (previewId.value) {
      event.preventDefault()
      closePreview()
    } else if (currentView.value === 'library') {
      event.preventDefault()
      if (collectionEditor.value) closeCollectionEditor()
      else if (librarySection.value !== 'settings' && managerSelectedCount.value > 0) clearManagerSelection()
      else if (librarySection.value !== 'settings' && managerQuery.value) clearManagerSearch()
      else returnToQuickPanel()
    } else if (!event.shiftKey && (query.value || quickSourceFilter.value || activeFilter.value !== 'all')) {
      event.preventDefault()
      clearSearchAndFocus(true)
    } else {
      event.preventDefault()
      performWindowAction('close')
    }
    return
  }

  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'p') {
    event.preventDefault()
    if (captureAvailability.value === 'available') capturePaused.value = !capturePaused.value
    return
  }

  if (event.ctrlKey && event.key.toLocaleLowerCase() === 'l') {
    event.preventDefault()
    if (currentView.value === 'quick') {
      openLibrary()
    } else {
      selectLibrarySection('all')
      nextTick(() => managerSearchInput.value?.focus())
    }
    return
  }

  if (currentView.value === 'quick' && event.ctrlKey && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault()
    nextTick(() => searchInput.value?.focus())
    return
  }

  if (currentView.value === 'library'
    && librarySection.value !== 'settings'
    && event.ctrlKey
    && ['f', 'k'].includes(event.key.toLocaleLowerCase())) {
    event.preventDefault()
    nextTick(() => managerSearchInput.value?.focus())
    return
  }

  if (currentView.value === 'library'
    && librarySection.value !== 'settings'
    && event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && event.key.toLocaleLowerCase() === 'a'
    && !preservesNativeManagerSelectionKeys(event.target)) {
    event.preventDefault()
    selectAllManagerMatches()
    return
  }

  if (currentView.value !== 'quick') return

  const eventTarget = event.target instanceof HTMLElement ? event.target : null
  const resultPrimary = eventTarget?.closest<HTMLElement>('.clip-primary') ?? null
  const isSearchTarget = eventTarget === searchInput.value
  const isResultNavigationTarget = isSearchTarget || resultPrimary !== null

  if (isSearchTarget && sourceSuggestions.value.length > 0) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      sourceSuggestionIndex.value = (
        sourceSuggestionIndex.value + direction + sourceSuggestions.value.length
      ) % sourceSuggestions.value.length
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      selectSourceSuggestion(sourceSuggestions.value[sourceSuggestionIndex.value])
      return
    }
  }

  if (isSearchTarget && event.key === 'Backspace' && !query.value && quickSourceFilter.value) {
    event.preventDefault()
    clearQuickSourceFilter()
    return
  }

  const hasExactDirectPasteModifier = event.altKey !== event.ctrlKey
    && !event.shiftKey
    && !event.metaKey
  if (hasExactDirectPasteModifier && /^[0-9]$/.test(event.key)) {
    event.preventDefault()
    const directIndex = event.key === '0' ? DIRECT_PASTE_ITEM_COUNT - 1 : Number(event.key) - 1
    const clip = visibleItems.value[directIndex]
    if (clip) void pasteClip(clip)
    return
  }

  if (isResultNavigationTarget && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    selectWithKeyboard(event.key === 'ArrowDown' ? 1 : -1, resultPrimary !== null)
    return
  }

  if (isResultNavigationTarget && (event.key === 'PageDown' || event.key === 'PageUp')) {
    event.preventDefault()
    selectWithKeyboard(event.key === 'PageDown' ? PAGE_NAVIGATION_STEP : -PAGE_NAVIGATION_STEP, resultPrimary !== null)
    return
  }

  if (resultPrimary && (event.key === 'Home' || event.key === 'End')) {
    event.preventDefault()
    selectIndexWithKeyboard(event.key === 'Home' ? 0 : visibleItems.value.length - 1, true)
    return
  }

  if (isResultNavigationTarget && event.key === 'Enter' && selectedClip.value) {
    event.preventDefault()
    void pasteClip(selectedClip.value)
    return
  }

  if (event.key === ' ' && previewId.value === null) {
    const target = event.target as HTMLElement | null
    if (target?.closest('.clip-primary') && selectedClip.value) {
      event.preventDefault()
      openPreview(selectedClip.value.id)
    }
  }
}

function applyPasteTarget(target: PasteTargetInfo) {
  if (typeof target.sessionId === 'number') {
    if (target.sessionId < activeQuickSessionId) return
    // 原生会先发送目标、再发送面板会话；即使后一事件丢失，目标也必须按自己的会话过期。
    activeQuickSessionId = target.sessionId
  }
  if (targetExpiryTimer) clearTimeout(targetExpiryTimer)
  targetExpiryTimer = undefined
  targetApp.value = target.sourceApp || null
  targetAppIcon.value = targetApp.value ? normalizeSourceAppIcon(target.sourceAppIcon) ?? null : null
  targetElevated.value = Boolean(target.sourceApp) && target.elevated
  if (!targetApp.value) return

  const targetSessionId = target.sessionId ?? activeQuickSessionId
  targetExpiryTimer = setTimeout(() => {
    if (targetSessionId !== activeQuickSessionId) return
    targetApp.value = null
    targetAppIcon.value = null
    targetElevated.value = false
    targetExpiryTimer = undefined
  }, PASTE_TARGET_TTL_MS)
}

async function connectEventWithRetry(
  connect: () => Promise<(() => void) | null>,
): Promise<(() => void) | null> {
  for (let attempt = 0; attempt < EVENT_SUBSCRIPTION_ATTEMPTS; attempt += 1) {
    const disconnect = await connect()
    if (disconnect) return disconnect
    await Promise.resolve()
  }
  return null
}

async function connectSessionBridges() {
  const [quickSessionDisconnect, pasteTargetDisconnect] = await Promise.all([
    connectEventWithRetry(() => connectQuickPanelSession((session) => {
      if (session && Number.isFinite(session.sessionId)) {
        activeQuickSessionId = Math.max(activeQuickSessionId, session.sessionId)
        applyPasteTarget(session)
      }
      windowModeGeneration += 1
      currentView.value = 'quick'
      windowModeTransitioning.value = false
      resetQuickSession()
      const sessionId = session?.sessionId
      if (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0) return
      const frameGeneration = ++quickFirstFrameGeneration
      void nextTick().then(() => new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })).then(() => {
        if (appUnmounted
          || frameGeneration !== quickFirstFrameGeneration
          || sessionId !== activeQuickSessionId
          || sessionId === quickFirstFrameAcknowledgedSessionId) return
        quickFirstFrameAcknowledgedSessionId = sessionId
        return acknowledgeQuickPanelFirstFrame(sessionId)
      }).catch(() => undefined)
    })),
    connectEventWithRetry(() => connectPasteTarget(applyPasteTarget)),
  ])

  if (quickSessionDisconnect) {
    if (appUnmounted) quickSessionDisconnect()
    else disconnectQuickPanelSession = quickSessionDisconnect
  } else {
    showToast(t('desktopEventsUnavailable'), true)
  }
  if (pasteTargetDisconnect) {
    if (appUnmounted) pasteTargetDisconnect()
    else disconnectPasteTarget = pasteTargetDisconnect
  } else {
    showToast(t('desktopEventsUnavailable'), true)
  }
}

async function connectClipboardBridge() {
  const disconnect = await connectNativeClipboard(acceptNativeCapture)
  if (disconnect) {
    if (appUnmounted) disconnect()
    else disconnectNativeClipboard = disconnect
  } else {
    clipboardSubscriptionReady.value = false
  }
}

async function connectDesktopBridges() {
  if (nativeRuntime) {
    const nativeLaunchAtStartup = await getLaunchAtStartup()
    if (nativeLaunchAtStartup !== null) launchAtStartup.value = nativeLaunchAtStartup
    const initializationResults = await Promise.all([
      setNativeCapturePaused(capturePaused.value),
      setScreenCaptureProtection(hideDuringSharing.value),
      setCaptureExclusions(excludedApps.value),
      setElevatedPasteEnabled(elevatedPasteEnabled.value),
      setQuickPanelPinned(quickPanelPinned.value),
      setNativeClipboardOcrEnabled(ocrEnabled.value),
    ])
    const [capturePausedApplied, captureProtectionApplied, exclusionsApplied, elevatedPasteApplied, quickPanelPinnedApplied] = initializationResults
    // 启动阶段失败时，回到本进程已知的原生初始状态，避免 UI 与 Windows 状态相反。
    if (!capturePausedApplied) capturePaused.value = false
    if (!captureProtectionApplied) hideDuringSharing.value = false
    if (!elevatedPasteApplied) elevatedPasteEnabled.value = true
    if (!quickPanelPinnedApplied) quickPanelPinned.value = false
    // OCR 是隐私选择：原生同步失败时保留本地意图，尤其不能把显式关闭改回开启。
    if (!exclusionsApplied) {
      excludedApps.value = []
      resetNativeExcludedApps([])
    }
    if (initializationResults.some((applied) => !applied)) showToast(t('settingApplyFailed'), true)
    // 先让初始化造成的响应式变更在 nativeSettingsReady=false 时完成，避免被误判为用户操作并重复调用。
    await nextTick()
    nativeSettingsReady.value = true
    await refreshManagerCollections()
    shortcutApplyInFlight.value = true
    try {
      if (!await setGlobalShortcut(globalShortcut.value)) {
        const fallbackApplied = globalShortcut.value !== DEFAULT_GLOBAL_SHORTCUT
          && await setGlobalShortcut(DEFAULT_GLOBAL_SHORTCUT)
        if (fallbackApplied) {
          globalShortcut.value = DEFAULT_GLOBAL_SHORTCUT
          globalShortcutAvailable.value = true
        } else {
          globalShortcutAvailable.value = false
        }
        showToast(t('shortcutUnavailable'), true)
      } else {
        globalShortcutAvailable.value = true
      }
    } finally {
      shortcutApplyInFlight.value = false
    }
    const policySynced = await applyNativeHistoryMutation({
      upserts: [],
      deleteIds: [],
      policy: currentHistoryPolicy(),
    })
    await refreshStorageState()
    const loadedHistory = policySynced ? await runNativeHistoryQuery(false) : false
    if (appUnmounted) return
    if (!loadedHistory) {
      // 未知的数据库状态必须保持只读，避免本次运行中的新捕获覆盖既有历史。
      historyState.value = 'error'
    }
    if (appUnmounted) return
  }

  const availabilityDisconnect = await connectCaptureAvailability((availability) => {
    captureHealth.value = availability
  })
  if (availabilityDisconnect) {
    if (appUnmounted) availabilityDisconnect()
    else disconnectCaptureAvailability = availabilityDisconnect
  } else {
    captureHealthSubscriptionReady.value = false
  }
  const availability = await getNativeCaptureAvailability()
  if (availability) captureHealth.value = availability
  else if (nativeRuntime) captureHealthSubscriptionReady.value = false

  void connectCaptureState((paused) => {
    capturePaused.value = paused
  }).then((disconnect) => {
    if (!disconnect) {
      captureStateSubscriptionReady.value = false
      return
    }
    if (appUnmounted) disconnect()
    else disconnectCaptureState = disconnect
  })
  const quitDisconnect = await connectQuitRequested(() => {
    if (quitFlushInProgress) return
    quitFlushInProgress = true
    void (async () => {
      try {
        if (await flushHistoryWithRetry()) {
          await exitNativeApp()
        } else {
          await cancelNativeQuit()
          showToast(t('historyQuitSaveFailed'), true)
        }
      } finally {
        quitFlushInProgress = false
      }
    })()
  })
  if (quitDisconnect) {
    if (appUnmounted) quitDisconnect()
    else disconnectQuitRequested = quitDisconnect
  } else {
    quitSubscriptionReady.value = false
    showToast(t('desktopExitUnavailable'), true)
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('blur', handleWindowBlur)
  window.addEventListener('resize', handleContextMenuScroll)
  relativeTimeTimer = setInterval(() => {
    relativeTimeNow.value = new Date()
  }, 60_000)
  if (nativeRuntime && !onboardingCompleted.value) void setOnboardingWindowActive(true)
  // 会话和目标事件必须先于设置/历史加载订阅，避免冷启动期间丢失第一次唤起。
  void connectSessionBridges()
  void connectClipboardBridge()
  void observeWindowMaximizedState((maximized) => {
    windowMaximized.value = maximized
  }).then((disconnect) => {
    if (appUnmounted) disconnect()
    else disconnectWindowMaximizedState = disconnect
  })
  nextTick(() => {
    if (onboardingCompleted.value) searchInput.value?.focus()
    else focusOnboardingStep()
  })
  void connectDesktopBridges()
  void connectUpdaterBridge()
})

onBeforeUnmount(() => {
  appUnmounted = true
  qrScanGeneration += 1
  quickFirstFrameGeneration += 1
  invalidateStoredOcrPump()
  ocrCoordinator.shutdown()
  if (nativeRuntime) void invalidateNativeClipboardOcr()
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('blur', handleWindowBlur)
  window.removeEventListener('resize', handleContextMenuScroll)
  disconnectNativeClipboard?.()
  disconnectPasteTarget?.()
  disconnectQuickPanelSession?.()
  disconnectCaptureState?.()
  disconnectCaptureAvailability?.()
  disconnectQuitRequested?.()
  disconnectWindowMaximizedState?.()
  historyPersistence.cancel()
  void historyPersistence.flush()
  if (toastTimer) clearTimeout(toastTimer)
  if (undoTimer) clearTimeout(undoTimer)
  if (targetExpiryTimer) clearTimeout(targetExpiryTimer)
  if (relativeTimeTimer) clearInterval(relativeTimeTimer)
  cancelNativeHistorySearchRefresh()
})
</script>

<template>
  <div
    class="app-stage"
    :class="{ 'is-window-maximized': currentView === 'library' && windowMaximized }"
    :data-theme="theme"
    @contextmenu="handleContextMenu"
    @pointerdown.capture="handleContextMenuPointerDown"
    @scroll.capture="handleContextMenuScroll"
  >
    <Transition name="panel-swap" mode="out-in" @after-enter="focusCurrentView">
      <QuickPanel
        v-if="currentView === 'quick'"
        key="quick"
        :state="quickPanelState"
        :helpers="quickPanelHelpers"
        @toggle-pin="toggleQuickPanelPinned"
        @toggle-theme="toggleTheme"
        @open-library="openLibrary"
        @window-action="performWindowAction"
        @resume-capture="capturePaused = false"
        @update-query="query = $event"
        @composition-start="startSearchComposition('quick')"
        @composition-end="finishSearchComposition('quick')"
        @composition-blur="cancelSearchComposition('quick')"
        @clear-search="clearSearchAndFocus"
        @clear-source="clearQuickSourceFilter"
        @select-source="selectSourceSuggestion"
        @set-filter="setFilter"
        @filter-keydown="handleFilterKeydown"
        @dismiss-practice="dismissOnboardingPractice"
        @focus-content="focusCurrentQuickContent"
        @retry-history="retryHistoryLoad"
        @select-clip="selectedId = $event"
        @use-clip="useClipFromDoubleClick"
        @preview-clip="openPreview"
        @pin-clip="pinClip($event, 'quick')"
        @load-more="loadMoreNativeHistory"
        @search-element="setQuickSearchElement"
      >
        <template #preview>
          <ClipPreview
            v-if="previewClip"
            ref="previewPasteButton"
            :clip="previewClip"
            :code-language="previewCodeLanguage"
            :qr-scan-state="qrScanState"
            :qr-results="qrResults"
            :paste-in-flight="pasteInFlight"
            :relative-time-now="relativeTimeNow"
            :locale="locale"
            :t="t"
            @close="closePreview"
            @copy-recognized-text="copyRecognizedText"
            @paste-recognized-text="pasteRecognizedText"
            @open-qr-link="openQrLink"
            @paste="pastePreviewClip"
          />
        </template>
      </QuickPanel>

      <LibraryManager
        v-else
        key="library"
        :state="libraryManagerState"
        :helpers="libraryManagerHelpers"
        @select-section="selectLibrarySection"
        @select-collection="selectManagerCollection"
        @create-collection="beginCreateCollection"
        @rename-collection="beginRenameCollection"
        @delete-collection="requestDeleteCollection"
        @update-collection-name="updateCollectionEditorName"
        @save-collection="saveCollectionEditor"
        @close-collection-editor="closeCollectionEditor"
        @return-quick="returnToQuickPanel"
        @toggle-theme="toggleTheme"
        @window-action="performWindowAction"
        @update-manager-query="managerQuery = $event"
        @update-manager-kinds="managerKinds = $event"
        @manager-search-arrow-down="handleManagerSearchArrowDown"
        @composition-start="startSearchComposition('manager')"
        @composition-end="finishSearchComposition('manager')"
        @composition-blur="cancelSearchComposition('manager')"
        @clear-manager-search="clearManagerSearch"
        @new-snippet="openNewSnippet"
        @clear-history="requestClearHistory"
        @select-all="selectAllManagerMatches"
        @clear-selection="clearManagerSelection"
        @apply-batch="applyManagerBatch"
        @retry-history="retryHistoryLoad"
        @focus-manager-clip="managerSelectedId = $event"
        @manager-row-click="handleManagerRowClick"
        @manager-row-keydown="handleManagerRowKeydown"
        @edit-snippet="openSnippetEditor"
        @copy-clip="copyClip"
        @pin-clip="pinClip($event, 'manager')"
        @delete-clip="deleteClip($event, 'manager')"
        @load-more="loadMoreNativeHistory"
        @manager-search-element="setManagerSearchElement"
        @library-content-element="setLibraryContentElement"
        @back-button-element="setLibraryBackButton"
        @clear-history-element="setClearHistoryTrigger"
      >
        <template #settings>
          <SettingsPanel
            v-model:launch-at-startup="launchAtStartup"
            v-model:theme="theme"
            v-model:locale="locale"
            v-model:hide-during-sharing="hideDuringSharing"
            v-model:ocr-enabled="ocrEnabled"
            v-model:elevated-paste-enabled="elevatedPasteEnabled"
            v-model:auto-check-updates="autoCheckUpdates"
            :native-runtime="nativeRuntime"
            :native-settings-ready="nativeSettingsReady"
            :global-shortcut="globalShortcut"
            :global-shortcut-available="globalShortcutAvailable"
            :shortcut-recording="shortcutRecording"
            :shortcut-apply-in-flight="shortcutApplyInFlight"
            :shortcut-conflict-message="shortcutConflictMessage"
            :history-state="historyState"
            :retention-select-value="retentionSelectValue"
            :custom-retention-days="customRetentionDays"
            :excluded-apps-count="excludedApps.length"
            :storage-stats="storageStats"
            :history-health="historyHealth"
            :prepared-restore="preparedRestore"
            :busy-storage-operation="busyStorageOperation"
            :storage-status-message="storageStatusMessage"
            :current-version="currentVersion"
            :update-status="updateStatus"
            :update-progress="updateProgress"
            :update-state="updateState"
            :update-busy="updateBusy"
            :update-status-text="updateStatusText"
            :t="t"
            @open-clipboard="selectLibrarySection('all')"
            @toggle-theme="toggleTheme"
            @start-shortcut-recording="startShortcutRecording"
            @cancel-shortcut-recording="cancelShortcutRecording()"
            @retention-change="requestRetentionChange"
            @open-sensitive-apps="openSensitiveApps"
            @backup="createHistoryBackup"
            @prepare-restore="prepareHistoryRestore"
            @commit-restore="commitHistoryRestore"
            @discard-restore="discardHistoryRestore"
            @compact="compactHistoryDatabase"
            @open-data-directory="openHistoryDataDirectory"
            @refresh-storage="refreshHistoryStorage"
            @check-update="runUpdateCheck(true)"
            @install-update="installAvailableUpdate"
          />
        </template>
      </LibraryManager>
    </Transition>

    <Transition name="context-menu">
      <ClipContextMenu
        v-if="clipContextMenu && contextMenuClip"
        :key="`${clipContextMenu.surface}-${clipContextMenu.clipId}-${clipContextMenu.x}-${clipContextMenu.y}`"
        :clip="contextMenuClip"
        :surface="clipContextMenu.surface"
        :locale="locale"
        :x="clipContextMenu.x"
        :y="clipContextMenu.y"
        :paste-disabled="pasteInFlight"
        @close="closeClipContextMenu"
        @action="runContextAction"
        @preview="runContextPreview"
      />
    </Transition>

    <Transition name="modal">
      <SnippetEditor
        v-if="snippetDraft"
        :key="snippetEditorKey"
        :locale="locale"
        :model-value="snippetDraft"
        :collections="collections"
        :busy="managerOperationBusy"
        :error-message="snippetError"
        @update:model-value="updateSnippetDraft"
        @save="saveSnippet"
        @cancel="closeSnippetEditor"
      />
    </Transition>

    <Transition name="modal">
      <ConfirmDialog
        v-if="collectionDeleteTarget"
        test-id="manager-collection-delete-confirmation"
        title-id="manager-collection-delete-title"
        description-id="manager-collection-delete-description"
        :title="t('managerDeleteCollectionTitle')"
        :description="t('managerDeleteCollectionDescription', { name: collectionDeleteTarget.name })"
        :cancel-label="t('cancel')"
        :confirm-label="t('managerDeleteCollectionConfirm')"
        cancel-test-id="manager-cancel-delete-collection"
        confirm-test-id="manager-confirm-delete-collection"
        role="alertdialog"
        :busy="managerOperationBusy"
        :error-message="collectionError"
        error-test-id="manager-collection-delete-error"
        @cancel="closeDeleteCollection"
        @confirm="confirmDeleteCollection"
        @keydown="trapModalFocus"
      />
    </Transition>

    <Transition name="modal">
      <ConfirmDialog
        v-if="permanentSnippetDeleteTarget"
        test-id="manager-permanent-delete-confirmation"
        title-id="manager-permanent-delete-title"
        description-id="manager-permanent-delete-description"
        :title="t('managerPermanentDeleteTitle')"
        :description="t('managerPermanentDeleteDescription', { title: permanentSnippetDeleteTarget.title })"
        :cancel-label="t('cancel')"
        :confirm-label="t('managerConfirmDelete')"
        cancel-test-id="manager-cancel-delete-permanent"
        confirm-test-id="manager-confirm-delete-permanent"
        role="alertdialog"
        :busy="managerOperationBusy"
        :error-message="permanentSnippetDeleteError"
        error-test-id="manager-permanent-delete-error"
        @cancel="closeDeletePermanentSnippet"
        @confirm="confirmDeletePermanentSnippet"
        @keydown="trapModalFocus"
      />
    </Transition>

    <Transition name="modal">
      <div v-if="sensitiveAppsOpen" class="settings-modal-backdrop" @click.self="closeSensitiveApps">
        <section data-testid="sensitive-apps-dialog" class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="sensitive-apps-title" aria-describedby="sensitive-apps-description" @keydown="trapModalFocus">
          <header>
            <div><ShieldCheck :size="19" /><span><strong id="sensitive-apps-title">{{ t('excludeSensitiveApps') }}</strong><small id="sensitive-apps-description">{{ t('sensitiveAppsDescription') }}</small></span></div>
            <button class="icon-button" type="button" :aria-label="t('closeSensitiveApps')" @click="closeSensitiveApps"><X :size="17" /></button>
          </header>
          <div class="sensitive-app-list">
            <div v-for="app in excludedApps" :key="app" class="sensitive-app-row">
              <span class="app-dot neutral">{{ sourceInitial(app) }}</span><strong>{{ app }}</strong>
              <button type="button" :aria-label="t('removeSensitiveApp', { app })" @click="removeSensitiveApp(app)"><X :size="15" /></button>
            </div>
            <p v-if="excludedApps.length === 0" class="sensitive-empty">{{ t('noSensitiveApps') }}</p>
          </div>
          <form class="sensitive-app-form" @submit.prevent="addSensitiveApp">
            <input ref="sensitiveAppInput" data-testid="sensitive-app-input" v-model="sensitiveAppDraft" type="text" autocomplete="off" :aria-label="t('sensitiveAppName')" :placeholder="t('sensitiveAppPlaceholder')" />
            <button data-testid="add-sensitive-app" class="primary-button" type="submit" :disabled="!canAddSensitiveApp" @click.prevent="addSensitiveApp">{{ t('add') }}</button>
          </form>
          <p class="settings-modal-note">{{ t('sensitiveAppsNote') }}</p>
        </section>
      </div>
    </Transition>

    <Transition name="modal">
      <ConfirmDialog
        v-if="clearHistoryOpen"
        test-id="clear-history-dialog"
        title-id="clear-history-title"
        description-id="clear-history-description"
        :title="t('clearHistoryTitle')"
        :description="ordinaryClearDescription"
        :cancel-label="t('cancel')"
        :confirm-label="t('confirmClear')"
        cancel-test-id="cancel-clear-history"
        confirm-test-id="confirm-clear-history"
        @cancel="closeClearHistory"
        @confirm="confirmClearHistory"
        @keydown="trapModalFocus"
      />
    </Transition>

    <Transition name="modal">
      <ConfirmDialog
        v-if="pendingRetentionChange"
        test-id="retention-change-dialog"
        title-id="retention-change-title"
        description-id="retention-change-description"
        :title="t('retentionChangeTitle')"
        :description="t('retentionChangeDescription', { count: pendingRetentionChange.removedCount, period: retentionPeriodLabel(pendingRetentionChange.value) })"
        :cancel-label="t('cancel')"
        :confirm-label="t('confirmRetentionChange')"
        cancel-test-id="cancel-retention-change"
        confirm-test-id="confirm-retention-change"
        @cancel="closeRetentionChange"
        @confirm="confirmRetentionChange"
        @keydown="trapModalFocus"
      />
    </Transition>

    <Transition name="toast">
      <aside v-if="lastRemoved && !modalOverlayOpen" class="undo-toast" role="status">
        <span><Check :size="16" />{{ t('deletedOne') }}</span>
        <button ref="undoButton" data-testid="undo-delete" type="button" @click="undoDelete">{{ t('undo') }}</button>
      </aside>
    </Transition>

    <Transition name="update-notice">
      <aside
        v-if="updateNoticeVisible && updateStatus?.updateAvailable && !modalOverlayOpen"
        data-testid="update-notice"
        class="update-notice"
        :class="{ busy: updateBusy, error: updateState === 'error' }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span class="update-notice-icon" aria-hidden="true"><Download :size="18" /></span>
        <span class="update-notice-copy">
          <strong>{{ updateStatusText }}</strong>
          <small v-if="updateStatus.assetSize">{{ formatUpdateSize(updateStatus.assetSize) }}</small>
        </span>
        <span class="update-notice-actions">
          <button data-testid="update-notice-dismiss" class="update-notice-dismiss" type="button" :aria-label="t('dismissUpdate')" @click="hideUpdateNotice"><X :size="15" /></button>
          <button
            v-if="updateStatus.automaticInstallAvailable"
            data-testid="update-notice-install"
            class="update-notice-install"
            type="button"
            :disabled="updateBusy"
            @click="installAvailableUpdate"
          >
            <Download :size="14" />{{ updateBusy ? updateStatusText : t('downloadInstall') }}
          </button>
        </span>
        <span v-if="updateProgress && updateBusy" class="update-notice-progress" aria-hidden="true"><span :style="{ width: `${updateProgress.percent}%` }"></span></span>
      </aside>
    </Transition>

    <Transition name="toast">
      <aside v-if="toastMessage" class="feedback-toast" :class="{ 'with-undo': lastRemoved && !modalOverlayOpen }" :role="toastUrgent ? 'alert' : 'status'" :aria-live="toastUrgent ? 'assertive' : 'polite'" aria-atomic="true">{{ toastMessage }}</aside>
    </Transition>

    <Transition name="modal">
      <OnboardingDialog
        v-if="onboardingStep >= 0"
        ref="onboardingDialog"
        :step="onboardingStep"
        :steps="onboardingSteps"
        :current-step="currentOnboardingStep"
        :global-shortcut="globalShortcut"
        :sample-busy="onboardingSampleBusy"
        :native-runtime="nativeRuntime"
        :history-ready="historyState === 'ready'"
        :locale="locale"
        :relative-time-now="relativeTimeNow"
        :t="t"
        @skip="finishOnboarding"
        @next="advanceOnboarding"
        @add-sample="finishOnboardingWithSample"
        @keydown="trapModalFocus"
      />
    </Transition>
  </div>
</template>
