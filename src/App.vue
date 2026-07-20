<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AlignLeft,
  ArrowLeft,
  Check,
  ChevronLeft,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  Eye,
  Image as ImageIcon,
  Keyboard,
  LayoutList,
  Link2,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Minus,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from 'lucide-vue-next'
import { demoClips } from './data/demoClips'
import { translate, type Locale, type MessageKey } from './i18n'
import { captureShortcut, DEFAULT_GLOBAL_SHORTCUT, displayShortcut } from './domain/shortcut'
import {
  applyClipFilter,
  clearUnpinnedHistory,
  createClipboardItem,
  formatRelativeTime,
  mergeCapturedClipIntoHistory,
  moveSelection,
  normalizeSourceAppIcon,
  parseClipboardItems,
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
import { formatUpdateSize, shouldAutoCheckUpdate } from './domain/update'
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
import { getLaunchAtStartup, setCaptureExclusions, setElevatedPasteEnabled, setGlobalShortcut, setLaunchAtStartup, setScreenCaptureProtection } from './platform/settings'
import { openExternalLink, openFilePath, revealFilePath, saveClipboardImage } from './platform/system'
import {
  observeWindowMaximizedState,
  runWindowAction,
  setOnboardingWindowActive,
  setQuickPanelPinned,
  setWindowMode,
  type WindowAction,
} from './platform/window'
import { checkForUpdate, connectUpdateCheckRequested, downloadUpdate, getCurrentVersion, installDownloadedUpdate, type UpdateProgress, type UpdateStatus } from './platform/updater'
import ClipContextMenu from './components/ClipContextMenu.vue'
import ClipImageThumbnail from './components/ClipImageThumbnail.vue'
import ManagerFilters from './components/ManagerFilters.vue'
import ManagerBulkToolbar from './components/ManagerBulkToolbar.vue'
import SnippetEditor from './components/SnippetEditor.vue'
import SourceAppIcon from './components/SourceAppIcon.vue'
import StorageManager from './components/StorageManager.vue'

const CodePreview = defineAsyncComponent(() => import('./components/CodePreview.vue'))

type AppView = 'quick' | 'library'
type LibrarySection = 'all' | 'pinned' | 'images' | 'settings'
type ManagerCollectionFilter = 'any' | 'unfiled' | `collection:${string}`
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
const UPDATE_CHECK_STORAGE_KEY = 'quickpaste-update-check-v1'
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
const ONBOARDING_SAMPLE_ID = 'quickpaste-onboarding-sample-v1'
const AUTO_UPDATE_CHECK_DELAY_MS = 15_000
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

function readLastUpdateCheckAt(): number | null {
  try {
    const value = Number(localStorage.getItem(UPDATE_CHECK_STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
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
const query = ref('')
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
const clearHistoryCancel = ref<HTMLButtonElement | null>(null)
const clearHistoryTrigger = ref<HTMLButtonElement | null>(null)
const retentionChangeCancel = ref<HTMLButtonElement | null>(null)
const retentionSelect = ref<HTMLSelectElement | null>(null)
const undoButton = ref<HTMLButtonElement | null>(null)
const onboardingPrimary = ref<HTMLButtonElement | null>(null)
const onboardingDialog = ref<HTMLElement | null>(null)
const libraryBackButton = ref<HTMLButtonElement | null>(null)
const previewPasteButton = ref<HTMLButtonElement | null>(null)
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
const onboardingCompleted = ref(storedSettings.onboardingCompleted)
const onboardingPracticePending = ref(storedSettings.onboardingPracticePending)
const onboardingStep = ref(storedSettings.onboardingCompleted ? -1 : 0)
const onboardingSampleBusy = ref(false)
const targetApp = ref<string | null>(null)
const targetAppIcon = ref<string | null>(null)
const targetElevated = ref(false)
const quickPanelPinned = ref(storedSettings.quickPanelPinned)
const autoCheckUpdates = ref(storedSettings.autoCheckUpdates)
const ocrEnabled = ref(storedSettings.ocrEnabled)
const currentVersion = ref('—')
const updateStatus = ref<UpdateStatus | null>(null)
const updateProgress = ref<UpdateProgress | null>(null)
const updateState = ref<'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'verifying' | 'installing' | 'error'>('idle')
const updateError = ref('')
const updateNoticeVisible = ref(false)
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
let disconnectUpdateCheckRequested: (() => void) | undefined
let autoUpdateCheckTimer: ReturnType<typeof setTimeout> | undefined
let updateNoticeTimer: ReturnType<typeof setTimeout> | undefined
let appUnmounted = false
let quitFlushInProgress = false
let capturedSequence = 0
const pendingNativeCaptures: NativeCapturePayload[] = []
const deferredStorageCaptures: NativeCapturePayload[] = []
let nativeQueryGeneration = 0
let nativeQueryRefreshQueued = false
let nativeQueryRefreshForced = false
let nativeAppliedQueryKey = ''
let storageRefreshGeneration = 0
let nativeRefreshAfterExclusive = false
let nativeRefreshAfterExclusiveForced = false
let suppressRetentionPolicySync = false
let previewLoadGeneration = 0
let suppressedNativeHistoryItems: ClipboardItem[] | null = null
let quickSessionGeneration = 0
let systemActionGeneration = 0
let snippetSessionGeneration = 0
let collectionDeleteRestoreFocus: HTMLElement | null = null
let permanentSnippetDeleteRestoreFocus: HTMLElement | null = null
let windowModeGeneration = 0
let activeQuickSessionId = 0
let quickFirstFrameGeneration = 0
let quickFirstFrameAcknowledgedSessionId = 0
const nativeSettingsReady = ref(!nativeRuntime)
let restoreResultFocusAfterPreview = false
const hydratedPayloads = new Map<string, { generation: number; item: LoadedClipboardItem }>()
const pendingPayloadLoads = new Map<string, { generation: number; promise: Promise<LoadedClipboardItem | null> }>()
const pendingNativeUpserts = new Map<string, ClipboardItem>()
let storedOcrPumpGeneration = 0
let storedOcrPumpPromise: Promise<void> | null = null

interface NativeBooleanSyncState {
  confirmed: boolean
  desired: boolean
  running: boolean
  suppressNext: boolean
}

const nativeBooleanSyncStates = new Map<string, NativeBooleanSyncState>()
const excludedAppsSyncState = {
  confirmed: [...excludedApps.value],
  desired: [...excludedApps.value],
  running: false,
  suppressNext: false,
}

const retentionSelectValue = computed(() => (
  historyRetentionDays.value === null ? 'forever' : String(historyRetentionDays.value)
))
const customRetentionDays = computed(() => {
  const value = historyRetentionDays.value
  return value !== null && ![7, 30, 90].includes(value) ? value : null
})

const onboardingSteps = computed(() => [
  {
    eyebrow: t('onboardingQuickEyebrow'),
    title: t('onboardingQuickTitle'),
    description: t('onboardingQuickDescription', { shortcut: displayShortcut(globalShortcut.value) }),
  },
  {
    eyebrow: t('onboardingEfficientEyebrow'),
    title: t('onboardingEfficientTitle'),
    description: t('onboardingEfficientDescription'),
  },
  {
    eyebrow: t('onboardingPrivateEyebrow'),
    title: t('onboardingPrivateTitle'),
    description: t('onboardingPrivateDescription'),
  },
] as const)

const currentOnboardingStep = computed(() => onboardingSteps.value[onboardingStep.value] ?? onboardingSteps.value[0])
const onboardingPracticeVisible = computed(() => (
  onboardingStep.value < 0 && onboardingPracticePending.value
))

const visibleItems = computed(() => nativeRuntime
  ? items.value
  : applyClipFilter(items.value, {
      query: query.value,
      kind: activeFilter.value,
    }))

const directSearchHighlighter = computed(() => createSearchHighlighter(query.value))
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
const ordinaryClearLabel = computed(() => locale.value === 'zh-CN'
  ? '清除普通记录'
  : 'Clear ordinary history')
const ordinaryClearDescription = computed(() => locale.value === 'zh-CN'
  ? `将删除 ${ordinaryHistoryCount.value} 条普通记录；固定内容会保留，永久片段也会保留。`
  : `This removes ${ordinaryHistoryCount.value} ordinary records. Pinned items and permanent snippets are kept.`)
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
const updateBusy = computed(() => ['checking', 'downloading', 'verifying', 'installing'].includes(updateState.value))
const updateStatusText = computed(() => {
  if (updateState.value === 'checking') return t('updateChecking')
  if (updateState.value === 'downloading') return t('updateDownloading', { percent: updateProgress.value?.percent ?? 0 })
  if (updateState.value === 'verifying') return t('updateVerifying')
  if (updateState.value === 'installing') return t('updateInstalling')
  if (updateState.value === 'available' && updateStatus.value) {
    return t('updateAvailableVersion', { version: updateStatus.value.latestVersion })
  }
  if (updateState.value === 'latest') return t('updateLatest')
  if (updateState.value === 'error') return updateError.value || t('updateCheckFailed')
  return t('updateNotChecked')
})

const filters = computed<Array<{ id: ClipKindFilter; label: string }>>(() => [
  { id: 'all', label: t('all') },
  { id: 'text', label: t('text') },
  { id: 'code', label: t('code') },
  { id: 'link', label: t('link') },
  { id: 'image', label: t('image') },
  { id: 'pinned', label: t('pinned') },
])

interface NativeQueryDescriptor {
  query: HistoryQuery
  impossible: boolean
}

function currentNativeQueryDescriptor(cursor?: string): NativeQueryDescriptor | null {
  if (!nativeRuntime || currentView.value === 'library' && librarySection.value === 'settings') return null

  let kinds: ClipKind[] = []
  const sourceApps: string[] = []
  let pinned: boolean | undefined
  let text = query.value
  let collection: HistoryQuery['collection'] = { mode: 'any' }
  let impossible = false

  if (currentView.value === 'quick') {
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

watch(autoCheckUpdates, () => {
  if (nativeSettingsReady.value) scheduleAutomaticUpdateCheck()
})

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
    && !managerSearchComposing.value) queueNativeHistoryRefresh()
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

watch([query, activeFilter], () => {
  closeClipContextMenu()
  selectedId.value = visibleItems.value[0]?.id ?? ''
  previewId.value = null
  nextTick(() => {
    const list = document.querySelector<HTMLElement>('.clip-list')
    if (list) list.scrollTop = 0
  })
  if (nativeRuntime && currentView.value === 'quick' && !quickSearchComposing.value) {
    queueNativeHistoryRefresh()
  }
})

function syncNativeBooleanSetting(
  key: string,
  enabled: boolean,
  previous: boolean,
  apply: (value: boolean) => Promise<boolean>,
  rollback: (value: boolean) => void,
) {
  if (!nativeRuntime || !nativeSettingsReady.value) return
  let state = nativeBooleanSyncStates.get(key)
  if (!state) {
    state = { confirmed: previous, desired: previous, running: false, suppressNext: false }
    nativeBooleanSyncStates.set(key, state)
  }
  if (state.suppressNext && enabled === state.confirmed) {
    state.suppressNext = false
    return
  }

  state.desired = enabled
  if (state.running) return
  state.running = true

  void (async () => {
    while (state.desired !== state.confirmed) {
      const next = state.desired
      const applied = await apply(next)
      if (applied) {
        state.confirmed = next
        continue
      }
      // 失败请求已不是最新意图时继续收敛；只有最新请求失败才回滚界面。
      if (state.desired === next) {
        state.desired = state.confirmed
        state.suppressNext = true
        rollback(state.confirmed)
        showToast(t('settingApplyFailed'), true)
        break
      }
    }
    state.running = false
  })()
}

watch(capturePaused, (enabled, previous) => {
  syncNativeBooleanSetting('capturePaused', enabled, previous, setNativeCapturePaused, (value) => {
    capturePaused.value = value
  })
})

watch(launchAtStartup, (enabled, previous) => {
  syncNativeBooleanSetting('launchAtStartup', enabled, previous, setLaunchAtStartup, (value) => {
    launchAtStartup.value = value
  })
})

watch(hideDuringSharing, (enabled, previous) => {
  syncNativeBooleanSetting('hideDuringSharing', enabled, previous, setScreenCaptureProtection, (value) => {
    hideDuringSharing.value = value
  })
})

watch(elevatedPasteEnabled, (enabled, previous) => {
  syncNativeBooleanSetting('elevatedPasteEnabled', enabled, previous, setElevatedPasteEnabled, (value) => {
    elevatedPasteEnabled.value = value
  })
})

watch(excludedApps, (apps) => {
  if (!nativeRuntime || !nativeSettingsReady.value) return
  const nextApps = [...apps]
  if (excludedAppsSyncState.suppressNext
    && JSON.stringify(nextApps) === JSON.stringify(excludedAppsSyncState.confirmed)) {
    excludedAppsSyncState.suppressNext = false
    return
  }

  excludedAppsSyncState.desired = nextApps
  if (excludedAppsSyncState.running) return
  excludedAppsSyncState.running = true
  void (async () => {
    while (JSON.stringify(excludedAppsSyncState.desired) !== JSON.stringify(excludedAppsSyncState.confirmed)) {
      const requested = [...excludedAppsSyncState.desired]
      const applied = await setCaptureExclusions(requested)
      if (applied) {
        excludedAppsSyncState.confirmed = requested
        continue
      }
      if (JSON.stringify(excludedAppsSyncState.desired) === JSON.stringify(requested)) {
        excludedAppsSyncState.desired = [...excludedAppsSyncState.confirmed]
        excludedAppsSyncState.suppressNext = true
        excludedApps.value = [...excludedAppsSyncState.confirmed]
        showToast(t('settingApplyFailed'), true)
        break
      }
    }
    excludedAppsSyncState.running = false
  })()
}, { deep: true })

function kindLabel(kind: ClipKind): string {
  return {
    text: t('text'),
    code: t('code'),
    link: t('link'),
    image: t('image'),
    file: '文件',
  }[kind]
}

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

function hideUpdateNotice() {
  updateNoticeVisible.value = false
  if (updateNoticeTimer) clearTimeout(updateNoticeTimer)
  updateNoticeTimer = undefined
}

function showUpdateNotice() {
  updateNoticeVisible.value = true
  if (updateNoticeTimer) clearTimeout(updateNoticeTimer)
  updateNoticeTimer = setTimeout(() => {
    updateNoticeVisible.value = false
    updateNoticeTimer = undefined
  }, 12_000)
}

function writeLastUpdateCheckAt(value: number): void {
  try {
    localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, String(value))
  } catch {
    // 检查时间只用于本地节流，存储不可用不应阻止更新检查。
  }
}

async function runUpdateCheck(manual: boolean) {
  if (!nativeRuntime || updateBusy.value) return
  updateState.value = 'checking'
  updateError.value = ''
  updateProgress.value = null
  const attemptedAt = Date.now()
  try {
    const status = await checkForUpdate()
    if (!status) {
      updateState.value = 'idle'
      return
    }
    currentVersion.value = status.currentVersion
    updateStatus.value = status
    updateState.value = status.updateAvailable ? 'available' : 'latest'
    if (status.updateAvailable) showUpdateNotice()
    else hideUpdateNotice()
  } catch (error) {
    if (manual) {
      updateError.value = error instanceof Error && error.message.trim()
        ? error.message
        : t('updateCheckFailed')
      updateState.value = 'error'
      showToast(t('updateCheckFailed'), true)
    } else {
      updateState.value = 'idle'
    }
  } finally {
    writeLastUpdateCheckAt(attemptedAt)
  }
}

async function installAvailableUpdate() {
  const status = updateStatus.value
  if (!status?.updateAvailable || !status.automaticInstallAvailable || updateBusy.value) return
  updateNoticeVisible.value = true
  if (updateNoticeTimer) clearTimeout(updateNoticeTimer)
  updateNoticeTimer = undefined
  updateState.value = 'downloading'
  updateError.value = ''
  updateProgress.value = null
  try {
    const prepared = await downloadUpdate(status.latestVersion, (progress) => {
      updateProgress.value = progress
      updateState.value = progress.phase
    })
    if (!prepared) throw new Error(t('updateInstallFailed'))
    if (!await flushHistoryWithRetry()) {
      throw new Error(t('historyQuitSaveFailed'))
    }
    updateState.value = 'installing'
    const result = await installDownloadedUpdate(prepared.token)
    if (!result) throw new Error(t('updateInstallFailed'))
  } catch (error) {
    updateError.value = error instanceof Error && error.message.trim()
      ? error.message
      : t('updateInstallFailed')
    updateState.value = 'error'
    showToast(updateError.value, true)
  }
}

function scheduleAutomaticUpdateCheck() {
  if (autoUpdateCheckTimer) clearTimeout(autoUpdateCheckTimer)
  autoUpdateCheckTimer = undefined
  if (!nativeRuntime || !autoCheckUpdates.value || !shouldAutoCheckUpdate(readLastUpdateCheckAt())) return
  autoUpdateCheckTimer = setTimeout(() => {
    autoUpdateCheckTimer = undefined
    void runUpdateCheck(false)
  }, AUTO_UPDATE_CHECK_DELAY_MS)
}

async function connectUpdaterBridge() {
  const packagedVersion = await getCurrentVersion()
  if (packagedVersion) currentVersion.value = packagedVersion
  const disconnect = await connectUpdateCheckRequested(() => {
    void (async () => {
      await openLibrary('settings')
      await runUpdateCheck(true)
    })()
  })
  if (disconnect) {
    if (appUnmounted) disconnect()
    else disconnectUpdateCheckRequested = disconnect
  }
  scheduleAutomaticUpdateCheck()
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

function queueNativeHistoryRefresh(force = false) {
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

function storageStatus(zhCN: string, enUS: string): string {
  return locale.value === 'zh-CN' ? zhCN : enUS
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
    storageStatusMessage.value = storageStatus(
      '历史数据库处于只读状态，无法执行此操作。',
      'The history database is read-only, so this operation is unavailable.',
    )
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
    storageStatusMessage.value = storageStatus(
      '尚有历史记录未能安全写入，本次操作已取消。',
      'Pending history could not be saved safely, so the operation was cancelled.',
    )
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
        storageStatusMessage.value = storageStatus(
          '操作已完成，但恢复期间捕获的内容仍在等待写入。',
          'The operation completed, but captures received during it are still waiting to be saved.',
        )
      }
    }
  } catch {
    for (const payload of captures) {
      pendingNativeCaptures.push(payload)
      if (pendingNativeCaptures.length > MAX_PENDING_NATIVE_CAPTURES) pendingNativeCaptures.shift()
    }
    storageStatusMessage.value = storageStatus(
      '操作已完成，但恢复期间捕获的内容需要稍后重试。',
      'The operation completed, but captures received during it need to be retried later.',
    )
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
      storageStatusMessage.value = storageStatus('备份未能完成，现有历史未改变。', 'Backup failed. Existing history was unchanged.')
      return
    }
    if (result.status === 'cancelled') {
      storageStatusMessage.value = storageStatus('已取消备份，现有历史未改变。', 'Backup cancelled. Existing history was unchanged.')
      return
    }
    storageStatusMessage.value = storageStatus('备份已安全保存。', 'Backup saved safely.')
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
      storageStatusMessage.value = storageStatus('备份验证失败，当前历史未改变。', 'Backup validation failed. Current history was unchanged.')
      return
    }
    if (result.status === 'cancelled') {
      storageStatusMessage.value = storageStatus('已取消恢复，当前历史未改变。', 'Restore cancelled. Current history was unchanged.')
      return
    }
    preparedRestore.value = result
    storageStatusMessage.value = storageStatus('备份验证完成，请确认是否替换当前历史。', 'Backup validated. Confirm whether to replace current history.')
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
      storageStatusMessage.value = storageStatus(
        '无法安全停止旧 OCR 任务，历史恢复未开始。',
        'Old OCR work could not be invalidated safely, so restore did not start.',
      )
      return
    }
    const result = await commitNativeHistoryRestore(token)
    if (!result) {
      preparedRestore.value = null
      storageStatusMessage.value = storageStatus(
        '恢复未提交，可能因为验证后历史已发生变化；当前历史保持不变。',
        'Restore was not committed, possibly because history changed after validation. Current history was preserved.',
      )
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
      storageStatusMessage.value = storageStatus(
        '历史已恢复，但重新读取失败；请重启应用后再操作。',
        'History was restored, but reloading failed. Restart the app before making changes.',
      )
      return
    }
    await refreshManagerCollections()
    await refreshStorageState()
    storageStatusMessage.value = storageStatus(
      `已恢复 ${result.importedCount} 条历史记录。`,
      `Restored ${result.importedCount} history records.`,
    )
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
      storageStatusMessage.value = storageStatus('无法清理待恢复文件，请重试。', 'The staged restore could not be discarded. Try again.')
      return
    }
    preparedRestore.value = null
    storageStatusMessage.value = storageStatus('已取消恢复，当前历史未改变。', 'Restore cancelled. Current history was unchanged.')
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
      storageStatusMessage.value = storageStatus('数据库压缩未能完成。', 'Database compaction failed.')
      return
    }
    storageStats.value = stats
    storageStatusMessage.value = storageStatus('数据库压缩完成，统计已刷新。', 'Database compaction completed and statistics were refreshed.')
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
      ? storageStatus('存储统计已刷新。', 'Storage statistics refreshed.')
      : storageStatus('存储统计暂时不可用。', 'Storage statistics are temporarily unavailable.')
  } finally {
    busyStorageOperation.value = null
  }
}

async function openHistoryDataDirectory() {
  const opened = await openNativeHistoryDataDirectory()
  storageStatusMessage.value = opened
    ? storageStatus('已打开数据目录。', 'Data folder opened.')
    : storageStatus('无法打开数据目录，请确认程序目录仍然可用。', 'The data folder could not be opened. Check that the application directory is still available.')
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
  if (surface === 'preview') return previewPasteButton.value
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

function openSensitiveApps() {
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
  nextTick(() => clearHistoryCancel.value?.focus())
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
  nextTick(() => retentionChangeCancel.value?.focus())
}

function closeRetentionChange() {
  pendingRetentionChange.value = null
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
  showToast(managerText(
    `已清除 ${result.removedCount} 条普通记录，固定内容和永久片段均已保留。`,
    `Cleared ${result.removedCount} ordinary records. Pinned items and permanent snippets were kept.`,
  ))
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
  if (resetFilter) activeFilter.value = 'all'
  nextTick(() => searchInput.value?.focus())
}

function clearManagerSearch() {
  managerQuery.value = ''
  nextTick(() => managerSearchInput.value?.focus())
}

function startSearchComposition(surface: ClipFocusSurface) {
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
    queueNativeHistoryRefresh()
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
      previewPasteButton.value?.focus()
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
  } finally {
    pasteInFlight.value = false
  }
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

function managerText(zhCN: string, enUS: string): string {
  return locale.value === 'zh-CN' ? zhCN : enUS
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

function finishOnboarding() {
  onboardingPracticePending.value = false
  onboardingCompleted.value = true
  onboardingStep.value = -1
  if (nativeRuntime) void setOnboardingWindowActive(false)
  nextTick(() => searchInput.value?.focus())
}

function createOnboardingSample(): LoadedClipboardItem {
  return createClipboardItem({
    kind: 'text',
    content: locale.value === 'zh-CN'
      ? '欢迎使用闪电剪贴板！这是你的第一次快捷粘贴。'
      : 'Welcome to QuickPaste! This is your first quick paste.',
    capturedAt: new Date().toISOString(),
    sourceApp: 'QuickPaste',
    formats: ['text'],
  }, ONBOARDING_SAMPLE_ID)
}

async function addOnboardingSample(): Promise<boolean> {
  const existing = items.value.find((clip) => clip.id === ONBOARDING_SAMPLE_ID)
  if (existing) {
    selectedId.value = existing.id
    return true
  }

  const sample = createOnboardingSample()
  if (!nativeRuntime) {
    items.value = [sample, ...items.value]
    selectedId.value = sample.id
    return true
  }

  const result = await runSerializedManagerOperation(() => applyNativeHistoryMutation({
    upserts: [sample],
    deleteIds: [],
    policy: currentHistoryPolicy(),
  }), 0)
  if (result.status === 'failed') return false
  selectedId.value = ONBOARDING_SAMPLE_ID
  return true
}

async function finishOnboardingWithSample() {
  if (onboardingSampleBusy.value) return
  onboardingSampleBusy.value = true
  try {
    if (!await addOnboardingSample()) {
      showToast(t('onboardingSampleFailed'), true)
      return
    }
    onboardingPracticePending.value = true
    onboardingCompleted.value = true
    onboardingStep.value = -1
    if (nativeRuntime) void setOnboardingWindowActive(false)
    nextTick(() => searchInput.value?.focus())
  } finally {
    onboardingSampleBusy.value = false
  }
}

function dismissOnboardingPractice() {
  onboardingPracticePending.value = false
  nextTick(() => searchInput.value?.focus())
}

function focusOnboardingStep() {
  const dialog = onboardingDialog.value
  const backdrop = document.querySelector<HTMLElement>('.onboarding-backdrop')
  const dialogOverflows = Boolean(dialog && dialog.scrollHeight > dialog.clientHeight + 1)
  dialog?.scrollTo({ top: 0, left: 0 })
  backdrop?.scrollTo({ top: 0, left: 0 })

  if (window.innerWidth <= 360 || window.innerHeight <= 360 || dialogOverflows) {
    dialog?.focus({ preventScroll: true })
  } else {
    onboardingPrimary.value?.focus({ preventScroll: true })
  }
}

function advanceOnboarding() {
  if (onboardingStep.value < onboardingSteps.value.length - 1) {
    onboardingStep.value += 1
  } else {
    finishOnboarding()
  }
  nextTick(focusOnboardingStep)
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
    } else if (!event.shiftKey && (query.value || activeFilter.value !== 'all')) {
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
      excludedAppsSyncState.confirmed = []
      excludedAppsSyncState.desired = []
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
  disconnectUpdateCheckRequested?.()
  historyPersistence.cancel()
  void historyPersistence.flush()
  if (toastTimer) clearTimeout(toastTimer)
  if (undoTimer) clearTimeout(undoTimer)
  if (targetExpiryTimer) clearTimeout(targetExpiryTimer)
  if (relativeTimeTimer) clearInterval(relativeTimeTimer)
  if (autoUpdateCheckTimer) clearTimeout(autoUpdateCheckTimer)
  if (updateNoticeTimer) clearTimeout(updateNoticeTimer)
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
      <section v-if="currentView === 'quick'" key="quick" class="quick-panel" :aria-label="`${t('productName')} ${t('quickPanel')}`" :inert="onboardingStep >= 0 || modalOverlayOpen">
        <header class="panel-chrome" data-tauri-drag-region="deep">
          <div class="brand-lockup">
            <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
            <span class="brand-name">{{ t('productName') }}</span>
            <span class="capture-state" :class="{ paused: capturePaused, unavailable: captureAvailability === 'unavailable' }">
              <span class="state-dot"></span>{{ captureStatusText }}
            </span>
            <div
              data-testid="paste-target"
              class="chrome-target"
              aria-live="polite"
              aria-atomic="true"
              :title="`${t('pasteTo')} ${targetApp ?? t('currentApp')}`"
            >
              <SourceAppIcon
                class="target-icon"
                :source="targetApp ?? t('currentApp')"
                :icon="targetAppIcon ?? undefined"
              />
              <span class="sr-only">{{ t('pasteTo') }}</span>
              <strong>{{ targetApp ?? t('currentApp') }}</strong>
              <span v-if="targetElevated" class="target-admin" :title="t('administratorWindow')"><ShieldCheck :size="11" /><span class="sr-only">{{ t('administratorWindow') }}</span></span>
            </div>
          </div>
          <div class="chrome-actions">
            <button
              data-testid="pin-quick-panel"
              class="icon-button"
              :class="{ active: quickPanelPinned }"
              type="button"
              :disabled="quickPanelPinInFlight || (nativeRuntime && !nativeSettingsReady)"
              :aria-label="quickPanelPinned ? t('unpinQuickPanel') : t('pinQuickPanel')"
              :title="quickPanelPinned ? t('unpinQuickPanel') : t('pinQuickPanel')"
              :aria-pressed="quickPanelPinned"
              @click="toggleQuickPanelPinned"
            >
              <Pin :size="16" :fill="quickPanelPinned ? 'currentColor' : 'none'" />
            </button>
            <button class="icon-button" type="button" :aria-label="theme === 'light' ? t('toggleDarkTheme') : t('toggleLightTheme')" @click="toggleTheme">
              <Moon v-if="theme === 'light'" :size="16" />
              <Sun v-else :size="16" />
            </button>
            <button data-testid="open-library" class="icon-button" type="button" :aria-label="t('manageClipboardShort')" :title="t('manageClipboardShort')" @click="openLibrary()">
              <LayoutList :size="16" />
            </button>
            <button class="icon-button" type="button" :aria-label="t('openSettings')" @click="openLibrary('settings')">
              <Settings2 :size="16" />
            </button>
            <span class="window-divider" aria-hidden="true"></span>
            <button data-testid="window-minimize" class="icon-button window-control" type="button" :disabled="windowModeTransitioning || windowActionInFlight" :aria-label="t('minimizeWindow')" @click="performWindowAction('minimize')">
              <Minus :size="16" />
            </button>
            <button data-testid="window-close" class="icon-button window-control close" type="button" :disabled="windowModeTransitioning || windowActionInFlight" :aria-label="t('closeWindow')" @click="performWindowAction('close')">
              <X :size="16" />
            </button>
          </div>
        </header>

        <Transition name="notice">
          <div v-if="nativeRuntime && !quitSubscriptionReady" class="privacy-banner" role="alert">
            <ShieldCheck :size="17" />
            <span>{{ t('desktopExitUnavailable') }}</span>
          </div>
          <div v-else-if="captureAvailability === 'unavailable'" class="privacy-banner" role="status">
            <ShieldCheck :size="17" />
            <span>{{ t('captureUnavailableNotice') }}</span>
          </div>
          <div v-else-if="capturePaused" class="privacy-banner" role="status">
            <ShieldCheck :size="17" />
            <span>{{ t('pausedNotice') }}</span>
            <button type="button" @click="capturePaused = false">{{ t('resume') }}</button>
          </div>
        </Transition>

        <div class="search-area">
          <Search class="search-icon" :size="19" aria-hidden="true" />
          <input
            ref="searchInput"
            v-model="query"
            data-testid="search-input"
            class="search-input"
            type="search"
            autocomplete="off"
            spellcheck="false"
            aria-controls="clipboard-results"
            :aria-activedescendant="previewId === null && selectedClip ? clipResultId(selectedClip.id) : undefined"
            :aria-label="t('searchClipboard')"
            :placeholder="t('searchClipboard')"
            @compositionstart="startSearchComposition('quick')"
            @compositionend="finishSearchComposition('quick')"
            @blur="cancelSearchComposition('quick')"
          />
          <button v-if="query" class="clear-search" type="button" :aria-label="t('clearSearch')" @click="clearSearchAndFocus()">
            <X :size="15" />
          </button>
          <span v-else class="search-hint">Ctrl K</span>
        </div>

        <nav class="filter-strip" :aria-label="t('contentTypes')">
          <button
            v-for="(filter, index) in filters"
            :key="filter.id"
            :data-testid="`filter-${filter.id}`"
            class="filter-chip"
            :class="{ active: activeFilter === filter.id }"
            type="button"
            :tabindex="activeFilter === filter.id ? 0 : -1"
            :aria-pressed="activeFilter === filter.id"
            @click="setFilter(filter.id)"
            @keydown="handleFilterKeydown($event, index)"
          >
            {{ filter.label }}
            <span v-if="filter.id === 'pinned'" class="chip-count">{{ pinnedCount }}</span>
          </button>
        </nav>

        <Transition name="notice">
          <aside
            v-if="onboardingPracticeVisible"
            data-testid="onboarding-practice"
            class="onboarding-practice"
            role="status"
            aria-live="polite"
          >
            <Keyboard :size="17" aria-hidden="true" />
            <span><strong>{{ t('onboardingPracticeTitle') }}</strong>{{ t('onboardingPracticeDescription', { shortcut: displayShortcut(globalShortcut) }) }}</span>
            <button type="button" :aria-label="t('dismissOnboardingPractice')" @click="dismissOnboardingPractice"><X :size="14" /></button>
          </aside>
        </Transition>

        <div class="content-stage">
          <Transition name="preview-swap" mode="out-in" @after-enter="focusCurrentQuickContent">
            <section v-if="previewClip" key="preview" data-testid="preview-panel" :data-preview-clip-id="previewClip.id" class="preview-panel" :aria-label="t('clipboardPreview')">
              <div class="preview-header">
                <button data-testid="close-preview" class="back-button" type="button" @click="closePreview">
                  <ArrowLeft :size="17" /> {{ t('backToHistory') }}
                </button>
                <span v-if="previewClip.kind === 'image'" class="preview-image-title">{{ previewClip.title }}</span>
                <span v-else class="preview-type">{{ kindLabel(previewClip.kind) }}</span>
              </div>
              <div class="preview-body" :class="{ 'image-preview-body': previewClip.kind === 'image' }">
                <div v-if="previewClip.kind !== 'image'" class="preview-heading">
                  <span class="kind-icon large" :style="{ '--source-color': previewClip.color }">
                    <component :is="kindIcon(previewClip.kind)" :size="20" />
                  </span>
                  <div>
                    <h1>{{ previewClip.title }}</h1>
                    <p>{{ previewClip.sourceApp }} · {{ formatRelativeTime(previewClip.copiedAt, relativeTimeNow, locale) }}</p>
                  </div>
                </div>
                <div v-if="previewClip.kind !== 'image' && previewClip.formats?.length" class="format-badges" :aria-label="previewClip.formats.join(', ')">
                  <span v-for="format in previewClip.formats" :key="format" class="format-badge">{{ format.toUpperCase() }}</span>
                </div>
                <p v-if="previewClip.kind !== 'image' && previewClip.omittedFormats?.length" class="format-omission-warning" role="status">
                  {{ t('omittedFormatsWarning', { formats: previewClip.omittedFormats.map((format) => format.toUpperCase()).join(', ') }) }}
                </p>
                <div v-if="previewClip.kind === 'image'" class="image-preview-content">
                  <img class="preview-image" :src="previewClip.imageUrl" :alt="previewClip.title" />
                  <details v-if="previewClip.ocrStatus === 'completed' && previewClip.ocrText" data-testid="preview-ocr-text" class="preview-ocr-text">
                    <summary><strong>{{ t('ocrRecognizedText') }}</strong></summary>
                    <div>{{ previewClip.ocrText }}</div>
                  </details>
                </div>
                <CodePreview
                  v-else-if="previewClip.kind === 'code'"
                  class="preview-code"
                  :code="previewClip.content"
                  :language="previewCodeLanguage"
                />
                <ul v-else-if="previewClip.kind === 'file'" data-testid="preview-file-list" class="preview-file-list">
                  <li v-for="file in previewClip.files" :key="file.path" :data-file-exists="String(file.exists)" :class="{ 'is-missing': !file.exists }">
                    <span class="preview-file-name">{{ file.name }}</span>
                    <span class="preview-file-status">{{ file.exists ? t('fileAvailable') : t('fileMissing') }}</span>
                    <span class="preview-file-path">{{ file.path }}</span>
                  </li>
                </ul>
                <p v-else-if="previewClip.kind === 'link'" class="preview-link">{{ previewClip.content }}</p>
                <p v-else class="preview-copy">{{ previewClip.content }}</p>
              </div>
              <div class="preview-actions">
                <template v-if="defaultPasteMode(previewClip) === 'preserve'">
                  <button ref="previewPasteButton" data-testid="preview-paste-preserve" class="primary-button" type="button" :disabled="pasteInFlight" @click="pasteClip(previewClip, 'preserve')">
                    {{ t('pastePreserve') }}
                  </button>
                  <button data-testid="preview-paste-plain" class="secondary-button" type="button" :disabled="pasteInFlight" @click="pasteClip(previewClip, 'plain')">
                    {{ t('pastePlain') }}
                  </button>
                </template>
                <button v-else ref="previewPasteButton" data-testid="preview-paste" class="primary-button" type="button" :disabled="pasteInFlight || getClipActions(previewClip, 'quick')[0]?.disabled" @click="pasteClip(previewClip)">
                  {{ t('paste') }}
                </button>
              </div>
            </section>

            <div v-else key="list" class="results-panel" :aria-busy="historyState === 'loading'">
              <p v-if="historyState === 'ready'" data-testid="quick-results-status" class="selection-announcement sr-only" aria-live="polite" aria-atomic="true">{{ selectionAnnouncement }}</p>
              <p v-if="nativeRuntime && historyState === 'ready'" data-testid="quick-history-page-status" class="sr-only">{{ t('showingHistoryPage', { loaded: visibleItems.length, total: nativeHistoryTotalCount }) }}</p>
              <div v-if="historyState === 'loading'" data-testid="history-loading" class="empty-state history-state" role="status">
                <span class="history-loader" aria-hidden="true"><span></span><span></span><span></span></span>
                <h2>{{ t('historyLoading') }}</h2>
                <p>{{ t('historyLoadingHint') }}</p>
              </div>

              <div v-else-if="historyState === 'error'" data-testid="history-error" class="empty-state history-state error" role="alert">
                <span class="empty-symbol"><ShieldCheck :size="25" /></span>
                <h2>{{ t('historyUnavailable') }}</h2>
                <p>{{ t('historyLoadFailed') }}</p>
                <button data-testid="history-retry" class="secondary-button" type="button" @click="retryHistoryLoad">{{ t('retryHistory') }}</button>
              </div>

              <template v-else-if="visibleItems.length">
                <div id="clipboard-results" class="clip-list" role="list" :aria-label="t('clipboardResults')">
                <article
                  v-for="(clip, index) in visibleItems"
                  :key="clip.id"
                  :id="clipResultId(clip.id)"
                  :data-clip-id="clip.id"
                  class="clip-row"
                  :class="{ 'is-selected': selectedId === clip.id }"
                  role="listitem"
                  :aria-current="selectedId === clip.id ? 'true' : undefined"
                >
                  <button
                    class="clip-primary"
                    type="button"
                    :tabindex="selectedId === clip.id ? 0 : -1"
                    :aria-keyshortcuts="directPasteAriaShortcuts(index)"
                    @mousedown.left.prevent
                    @click="selectedId = clip.id"
                    @dblclick="pasteClip(clip)"
                  >
                    <span v-if="index < DIRECT_PASTE_ITEM_COUNT" class="quick-number" aria-hidden="true">{{ directPasteLabel(index) }}</span>
                    <span class="kind-icon" :style="{ '--source-color': clip.color }">
                      <ClipImageThumbnail v-if="clip.kind === 'image'" :clip-id="clip.id" :image-url="clip.imageUrl" :image-hash="clip.imageHash" />
                      <component v-else :is="kindIcon(clip.kind)" :size="18" />
                    </span>
                    <span class="clip-copy">
                      <span class="clip-content">
                        <span class="clip-content-text">
                          <template v-for="(segment, segmentIndex) in highlightSegments(quickClipText(clip))" :key="`content-${segmentIndex}`">
                            <mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark>
                            <template v-else>{{ segment.text }}</template>
                          </template>
                        </span>
                        <span v-if="isOcrOnlyMatch(clip)" class="ocr-match">{{ t('ocrMatch') }}</span>
                        <span v-else-if="isPhoneticOnlyMatch(clip)" class="phonetic-match">{{ t(nativeRuntime ? 'indexMatch' : 'pinyinMatch') }}</span>
                        <span v-else-if="clip.kind === 'image' && clip.ocrStatus" class="ocr-status compact">{{ ocrStatusLabel(clip) }}</span>
                        <span v-if="hasMissingFiles(clip)" :data-testid="`quick-file-availability-${clip.id}`" class="file-availability">{{ fileAvailabilityLabel(clip) }}</span>
                      </span>
                    </span>
                    <span class="clip-meta">
                      <span class="source-app">
                        <SourceAppIcon
                          class="app-dot"
                          :source="clip.sourceApp"
                          :icon="clip.sourceAppIcon"
                          :fallback-color="clip.color"
                        />
                        <span class="source-name">
                          <template v-for="(segment, segmentIndex) in highlightSegments(clip.sourceApp)" :key="`source-${segmentIndex}`">
                            <mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark>
                            <template v-else>{{ segment.text }}</template>
                          </template>
                        </span>
                      </span>
                      <span class="clip-time">{{ formatRelativeTime(clip.copiedAt, relativeTimeNow, locale) }}</span>
                    </span>
                  </button>
                  <div class="row-actions">
                    <button :data-testid="`preview-clip-${clip.id}`" type="button" :tabindex="selectedId === clip.id ? 0 : -1" :aria-label="t('preview')" :title="t('preview')" @focus="selectedId = clip.id" @pointerdown="selectedId = clip.id" @click="openPreview(clip.id)"><Eye :size="15" /></button>
                  </div>
                </article>
                  <button
                    v-if="nativeRuntime && nativeHistoryNextCursor"
                    data-testid="history-load-more"
                    class="secondary-button history-load-more"
                    type="button"
                    :disabled="nativeHistoryPageLoading"
                    @click="loadMoreNativeHistory"
                  >{{ nativeHistoryPageLoading ? t('loadingMoreHistory') : t('loadMoreHistory') }}</button>
                </div>
              </template>

              <div v-else-if="items.length === 0 && !query && activeFilter === 'all'" data-testid="empty-history" class="empty-state">
                <span class="empty-symbol"><Database :size="25" /></span>
                <h2>{{ t('emptyHistory') }}</h2>
                <p>{{ t('emptyHistoryHint') }}</p>
              </div>

              <div v-else data-testid="no-results" class="empty-state">
                <span class="empty-symbol"><Search :size="25" /></span>
                <h2>{{ t('noResults') }}</h2>
                <p>{{ t('noResultsHint') }}</p>
                <button class="secondary-button" type="button" @click="clearSearchAndFocus(true)">{{ t('clearFilters') }}</button>
              </div>
            </div>
          </Transition>
        </div>

      </section>

      <section v-else key="library" data-testid="library-view" class="library-shell" :aria-label="t('clipboardManager')" :inert="modalOverlayOpen">
        <aside class="library-sidebar">
          <div class="sidebar-brand">
            <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
            <span>{{ t('productName') }}</span>
          </div>
          <nav :aria-label="t('managerCategories')">
            <button data-testid="library-section-all" :class="{ active: librarySection === 'all' }" type="button" :title="t('allHistory')" :aria-current="librarySection === 'all' ? 'page' : undefined" @click="selectLibrarySection('all')"><Clock3 :size="17" />{{ t('allHistory') }}<span>{{ nativeRuntime ? nativeHistoryTotalCount : items.length }}</span></button>
            <button data-testid="library-section-pinned" :class="{ active: librarySection === 'pinned' }" type="button" :title="t('pinned')" :aria-current="librarySection === 'pinned' ? 'page' : undefined" @click="selectLibrarySection('pinned')"><Pin :size="17" />{{ t('pinned') }}<span v-if="!nativeRuntime">{{ pinnedCount }}</span></button>
            <button data-testid="library-section-images" :class="{ active: librarySection === 'images' }" type="button" :title="t('images')" :aria-current="librarySection === 'images' ? 'page' : undefined" @click="selectLibrarySection('images')"><ImageIcon :size="17" />{{ t('images') }}<span v-if="!nativeRuntime">{{ imageCount }}</span></button>
          </nav>
          <section v-if="nativeRuntime" data-testid="manager-collections" class="manager-collections" :aria-label="t('managerCollections')">
            <header>
              <strong>{{ t('managerCollections') }}</strong>
              <button data-testid="manager-create-collection" type="button" :disabled="managerOperationBusy" @click="beginCreateCollection">{{ t('managerNewCollection') }}</button>
            </header>
            <nav :aria-label="t('managerCollectionFilters')">
              <button data-testid="manager-collection-all" type="button" :aria-current="managerCollectionFilter === 'any' ? 'page' : undefined" @click="selectManagerCollection('any')">{{ t('managerAllCollections') }}</button>
              <button data-testid="manager-collection-unfiled" type="button" :aria-current="managerCollectionFilter === 'unfiled' ? 'page' : undefined" @click="selectManagerCollection('unfiled')">{{ t('managerUnfiled') }}</button>
              <div v-for="collection in collections" :key="collection.id" class="manager-collection-row">
                <button :data-testid="`manager-collection-${collection.id}`" type="button" :aria-current="managerCollectionFilter === `collection:${collection.id}` ? 'page' : undefined" @click="selectManagerCollection(`collection:${collection.id}`)">{{ collection.name }}</button>
                <button :data-testid="`manager-rename-collection-${collection.id}`" type="button" :disabled="managerOperationBusy" :aria-label="t('managerRenameCollection', { name: collection.name })" @click="beginRenameCollection(collection)">{{ t('managerEdit') }}</button>
                <button :data-testid="`manager-delete-collection-${collection.id}`" type="button" :disabled="managerOperationBusy" :aria-label="t('managerDeleteCollectionLabel', { name: collection.name })" @click="requestDeleteCollection(collection, $event)">{{ t('managerDeleteShort') }}</button>
              </div>
            </nav>
            <form v-if="collectionEditor" data-testid="manager-collection-editor" @submit.prevent="saveCollectionEditor">
              <input data-testid="manager-collection-name" type="text" :value="collectionEditor.name" :disabled="managerOperationBusy" :aria-label="t('managerCollectionName')" @input="updateCollectionEditorName" />
              <button data-testid="manager-save-collection" type="submit" :disabled="managerOperationBusy" @click.prevent="saveCollectionEditor">{{ t('managerSave') }}</button>
              <button data-testid="manager-cancel-collection" type="button" :disabled="managerOperationBusy" @click="closeCollectionEditor">{{ t('cancel') }}</button>
            </form>
            <p v-if="collectionError" data-testid="manager-collection-error" role="alert">{{ collectionError }}</p>
          </section>
          <div class="sidebar-divider"></div>
          <nav :aria-label="t('appSettings')">
            <button data-testid="library-section-settings" :class="{ active: librarySection === 'settings' }" type="button" :title="t('settings')" :aria-current="librarySection === 'settings' ? 'page' : undefined" @click="selectLibrarySection('settings')"><Settings2 :size="17" />{{ t('settings') }}</button>
          </nav>
          <div class="sidebar-privacy"><ShieldCheck :size="15" /><span>{{ t('localOnly') }}</span></div>
        </aside>

        <main class="library-main">
          <header class="library-header" data-tauri-drag-region="deep">
            <div>
              <button ref="libraryBackButton" class="back-button subtle" type="button" @click="returnToQuickPanel"><ChevronLeft :size="17" />{{ t('backToQuick') }}</button>
              <h1>{{ librarySection === 'settings' ? t('settings') : t('manageClipboard') }}</h1>
              <p v-if="librarySection !== 'settings'">{{ t('manageDescription') }}</p>
              <p v-else>{{ t('settingsDescription') }}</p>
            </div>
            <div class="library-header-actions">
              <button class="icon-button manager-theme" type="button" :aria-label="t('toggleTheme')" @click="toggleTheme">
                <Moon v-if="theme === 'light'" :size="17" />
                <Sun v-else :size="17" />
              </button>
              <button class="icon-button window-control" type="button" :disabled="windowModeTransitioning || windowActionInFlight" :aria-label="t('minimizeWindow')" @click="performWindowAction('minimize')"><Minus :size="17" /></button>
              <button data-testid="window-toggle-maximize" class="icon-button window-control" type="button" :disabled="windowModeTransitioning || windowActionInFlight" :aria-label="windowMaximized ? t('restoreWindow') : t('maximizeWindow')" @click="performWindowAction('toggle-maximize')"><Minimize2 v-if="windowMaximized" :size="15" /><Maximize2 v-else :size="15" /></button>
              <button class="icon-button window-control close" type="button" :disabled="windowModeTransitioning || windowActionInFlight" :aria-label="t('closeWindow')" @click="performWindowAction('close')"><X :size="17" /></button>
            </div>
          </header>

          <section v-if="librarySection !== 'settings'" ref="libraryContent" class="library-content">
            <div class="manager-toolbar">
              <div class="manager-search">
                <Search :size="14" aria-hidden="true" />
                <input ref="managerSearchInput" v-model="managerQuery" data-testid="manager-search-input" type="search" autocomplete="off" spellcheck="false" :aria-label="t('searchManager')" :placeholder="t('searchManager')" @keydown.down="handleManagerSearchArrowDown" @compositionstart="startSearchComposition('manager')" @compositionend="finishSearchComposition('manager')" @blur="cancelSearchComposition('manager')" />
                <button v-if="managerQuery" data-testid="clear-manager-search" class="manager-search-clear" type="button" :aria-label="t('clearSearch')" @mousedown.prevent @click="clearManagerSearch"><X :size="13" /></button>
              </div>
              <ManagerFilters
                v-model:kinds="managerKinds"
                :locale="locale"
              />
              <div class="manager-toolbar-actions">
                <span data-testid="manager-results-status" :aria-live="historyState === 'ready' ? 'polite' : 'off'" aria-atomic="true">{{ historyState === 'ready' ? nativeRuntime ? t('showingHistoryPage', { loaded: libraryItems.length, total: nativeHistoryTotalCount }) : t('showingItems', { count: libraryItems.length }) : '' }}</span>
                <button v-if="nativeRuntime" data-testid="new-snippet" class="manager-primary-action" type="button" :disabled="managerOperationBusy || snippetLoading" @click="openNewSnippet"><Plus :size="14" />{{ t('managerNewSnippet') }}</button>
                <button
                  v-if="librarySection === 'all' && !nativeRuntime"
                  ref="clearHistoryTrigger"
                  data-testid="clear-history"
                  class="manager-clear"
                  type="button"
                  :disabled="ordinaryHistoryCount === 0"
                  @click="requestClearHistory"
                >
                  <Trash2 :size="14" />{{ ordinaryClearLabel }}
                </button>
              </div>
            </div>
            <ManagerBulkToolbar
              v-if="nativeRuntime"
              :key="managerBulkToolbarKey"
              :locale="locale"
              :selection-state="managerBulkSelectionState"
              :selected-count="managerSelectedCount"
              :collections="collections"
              :busy="managerSelectionBusy"
              :error-message="managerBatchError"
              :includes-pinned="managerSelectionIncludesPinned"
              :includes-permanent="managerSelectionIncludesPermanent"
              @select-all="selectAllManagerMatches"
              @clear-selection="clearManagerSelection"
              @apply="applyManagerBatch"
            />
            <div class="manager-list" role="listbox" aria-multiselectable="true" :aria-label="t('clipboardResults')">
              <div v-if="historyState === 'loading'" class="empty-state compact" role="status">
                <span class="history-loader compact" aria-hidden="true"><span></span><span></span><span></span></span>
                <h2>{{ t('historyLoading') }}</h2>
                <p>{{ t('historyLoadingHint') }}</p>
              </div>
              <div v-else-if="historyState === 'error'" class="empty-state compact history-state error" role="alert">
                <ShieldCheck :size="22" />
                <h2>{{ t('historyUnavailable') }}</h2>
                <p>{{ t('historyLoadFailed') }}</p>
                <button data-testid="history-retry" class="secondary-button" type="button" @click="retryHistoryLoad">{{ t('retryHistory') }}</button>
              </div>
              <article
                v-for="(clip, index) in historyState === 'ready' ? libraryItems : []"
                :key="clip.id"
                :data-manager-clip-id="clip.id"
                class="manager-row"
                role="option"
                :tabindex="managerSelectedId === clip.id ? 0 : -1"
                :aria-current="managerSelectedId === clip.id ? 'true' : undefined"
                :aria-selected="managerClipSelected(clip)"
                :aria-label="`${clip.title}, ${clip.sourceApp}`"
                @focus="managerSelectedId = clip.id"
                @click="handleManagerRowClick($event, clip)"
                @keydown="handleManagerRowKeydown($event, index, clip.id)"
              >
                <span class="kind-icon" :style="{ '--source-color': clip.color }">
                  <ClipImageThumbnail v-if="clip.kind === 'image'" :clip-id="clip.id" :image-url="clip.imageUrl" :image-hash="clip.imageHash" />
                  <component v-else :is="kindIcon(clip.kind)" :size="17" />
                </span>
                <div>
                  <strong><span class="manager-title-text"><template v-for="(segment, segmentIndex) in managerHighlightSegments(clip.title)" :key="`manager-title-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span><span v-if="isOcrOnlyMatch(clip, true)" class="ocr-match">{{ t('ocrMatch') }}</span><span v-else-if="isPhoneticOnlyMatch(clip, true)" class="phonetic-match">{{ t(nativeRuntime ? 'indexMatch' : 'pinyinMatch') }}</span><span v-else-if="clip.kind === 'image' && clip.ocrStatus" :data-testid="`manager-ocr-status-${clip.id}`" class="ocr-status compact">{{ ocrStatusLabel(clip) }}</span><span v-if="hasMissingFiles(clip)" :data-testid="`manager-file-availability-${clip.id}`" class="file-availability">{{ fileAvailabilityLabel(clip) }}</span></strong>
                  <p><template v-for="(segment, segmentIndex) in managerHighlightSegments(clip.content)" :key="`manager-content-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></p>
                </div>
                <div class="manager-meta">
                  <span class="manager-source"><SourceAppIcon class="manager-app-icon" :source="clip.sourceApp" :icon="clip.sourceAppIcon" :fallback-color="clip.color" /><span><template v-for="(segment, segmentIndex) in managerHighlightSegments(clip.sourceApp)" :key="`manager-source-${segmentIndex}`"><mark v-if="segment.matched" class="search-highlight">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span></span>
                  <span class="manager-time">{{ formatRelativeTime(clip.copiedAt, relativeTimeNow, locale) }}</span>
                </div>
                <div class="manager-actions">
                  <button v-if="clip.permanent && (clip.kind === 'text' || clip.kind === 'code')" :data-testid="`manager-edit-snippet-${clip.id}`" type="button" :tabindex="managerSelectedId === clip.id ? 0 : -1" :aria-label="t('managerEditSnippet', { title: clip.title })" @focus="managerSelectedId = clip.id" @click="openSnippetEditor(clip)">{{ t('managerEdit') }}</button>
                  <button :data-testid="`manager-copy-${clip.id}`" type="button" :tabindex="managerSelectedId === clip.id ? 0 : -1" :aria-label="`${t('copyContent')}: ${clip.title}`" :title="t('copyContent')" @focus="managerSelectedId = clip.id" @click="copyClip(clip)"><Copy :size="15" /></button>
                  <button :data-testid="`manager-pin-${clip.id}`" type="button" :tabindex="managerSelectedId === clip.id ? 0 : -1" :aria-label="`${clip.pinned ? t('unpin') : t('pinClip')}: ${clip.title}`" :aria-pressed="clip.pinned" @focus="managerSelectedId = clip.id" @click="pinClip(clip.id, 'manager')"><Pin :size="15" :fill="clip.pinned ? 'currentColor' : 'none'" /></button>
                  <button :data-testid="`manager-delete-${clip.id}`" type="button" :tabindex="managerSelectedId === clip.id ? 0 : -1" :aria-label="`${t('deleteClip')}: ${clip.title}`" @focus="managerSelectedId = clip.id" @click="deleteClip(clip.id, 'manager')"><Trash2 :size="15" /></button>
                </div>
              </article>
              <button
                v-if="nativeRuntime && nativeHistoryNextCursor"
                data-testid="history-load-more"
                class="secondary-button history-load-more"
                type="button"
                :disabled="nativeHistoryPageLoading"
                @click="loadMoreNativeHistory"
              >{{ nativeHistoryPageLoading ? t('loadingMoreHistory') : t('loadMoreHistory') }}</button>
              <div v-if="historyState === 'ready' && libraryItems.length === 0" data-testid="manager-empty-state" class="empty-state compact"><component :is="managerEmptyState.icon" :size="22" /><h2>{{ managerEmptyState.title }}</h2><p>{{ managerEmptyState.hint }}</p><button v-if="managerEmptyState.canClear" data-testid="clear-empty-manager-search" class="secondary-button" type="button" @click="clearManagerSearch">{{ t('clearSearch') }}</button></div>
            </div>
          </section>

          <section v-else class="settings-content" :aria-busy="nativeRuntime && !nativeSettingsReady">
            <p v-if="nativeRuntime && !nativeSettingsReady" class="settings-loading" role="status">{{ t('settingsLoading') }}</p>
            <section class="settings-primary-actions" data-testid="settings-primary-actions" :aria-label="t('settingsPrimaryActions')">
              <button data-testid="settings-open-clipboard" class="settings-primary-card settings-clipboard-card" type="button" :aria-label="t('manageClipboard')" @click="selectLibrarySection('all')">
                <span class="settings-primary-icon" aria-hidden="true"><LayoutList :size="19" /></span>
                <span class="settings-primary-copy"><strong>{{ t('manageClipboard') }}</strong><small>{{ t('settingsClipboardEntryDescription') }}</small></span>
                <span class="settings-primary-link">{{ t('manageClipboardShort') }}</span>
              </button>
              <article class="shortcut-card" :class="{ recording: shortcutRecording, unavailable: !globalShortcutAvailable }">
                <span class="settings-primary-icon" aria-hidden="true"><Keyboard :size="19" /></span>
                <div><strong>{{ t('openQuickPaste') }}</strong><p>{{ shortcutRecording ? t('shortcutRecordingHint') : t('globalShortcutDescription') }}</p><small v-if="!globalShortcutAvailable" id="shortcut-status" data-testid="shortcut-status">{{ t('shortcutInactive') }}</small></div>
                <button data-testid="shortcut-recorder" class="shortcut-recorder" type="button" :disabled="shortcutApplyInFlight || (nativeRuntime && !nativeSettingsReady)" :aria-label="t('globalShortcutControl', { shortcut: shortcutRecording ? t('shortcutRecording') : displayShortcut(globalShortcut) })" :aria-invalid="!globalShortcutAvailable ? 'true' : undefined" :aria-describedby="!globalShortcutAvailable ? 'shortcut-status' : undefined" @click="startShortcutRecording" @blur="cancelShortcutRecording()">
                  <kbd>{{ shortcutRecording ? t('shortcutRecording') : displayShortcut(globalShortcut) }}</kbd>
                </button>
              </article>
            </section>
            <article class="setting-group">
              <div class="setting-heading"><Monitor :size="18" /><div><h2>{{ t('startupAppearance') }}</h2><p>{{ t('startupAppearanceDescription') }}</p></div></div>
              <label class="setting-row"><span><strong>{{ t('launchAtStartup') }}</strong><small>{{ t('launchAtStartupDescription') }}</small></span><input v-model="launchAtStartup" data-testid="launch-at-startup-toggle" class="switch" type="checkbox" :disabled="nativeRuntime && !nativeSettingsReady" /></label>
              <div class="setting-row"><span><strong>{{ t('interfaceTheme') }}</strong><small>{{ t('themeDescription', { theme: theme === 'light' ? t('light') : t('dark') }) }}</small></span><button data-testid="settings-theme-button" class="select-button" type="button" :aria-label="t('interfaceThemeControl', { theme: theme === 'light' ? t('light') : t('dark') })" @click="toggleTheme">{{ theme === 'light' ? t('light') : t('dark') }}</button></div>
              <label class="setting-row"><span><strong>{{ t('language') }}</strong><small>{{ t('languageDescription') }}</small></span><select data-testid="locale-select" v-model="locale"><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
            </article>
            <article class="setting-group">
              <div class="setting-heading"><ShieldCheck :size="18" /><div><h2>{{ t('privacy') }}</h2><p>{{ t('privacyDescription') }}</p></div></div>
              <label class="setting-row"><span><strong>{{ t('retention') }}</strong><small id="retention-description">{{ historyState === 'loading' ? t('retentionUnavailableLoading') : historyState === 'error' ? t('retentionUnavailableError') : t('retentionDescription') }}</small></span><select ref="retentionSelect" data-testid="retention-select" :value="retentionSelectValue" :disabled="historyState !== 'ready' || busyStorageOperation !== null" aria-describedby="retention-description" @change="requestRetentionChange"><option v-if="customRetentionDays !== null" :value="String(customRetentionDays)">{{ locale === 'zh-CN' ? `当前自定义 ${customRetentionDays} 天` : `Current custom value: ${customRetentionDays} days` }}</option><option value="7">{{ t('daysOption', { count: 7 }) }}</option><option value="30">{{ t('daysOption', { count: 30 }) }}</option><option value="90">{{ t('daysOption', { count: 90 }) }}</option><option value="forever">{{ t('forever') }}</option></select></label>
              <label class="setting-row"><span><strong>{{ t('captureProtection') }}</strong><small>{{ t('captureProtectionDescription') }}</small></span><input v-model="hideDuringSharing" data-testid="capture-protection-toggle" class="switch" type="checkbox" :disabled="nativeRuntime && !nativeSettingsReady" /></label>
              <label v-if="nativeRuntime" class="setting-row"><span><strong>{{ t('localImageOcr') }}</strong><small id="ocr-setting-description">{{ t('localImageOcrDescription') }}</small></span><input v-model="ocrEnabled" data-testid="ocr-enabled-toggle" class="switch" type="checkbox" :disabled="!nativeSettingsReady" aria-describedby="ocr-setting-description" /></label>
              <label class="setting-row"><span><strong>{{ t('elevatedPaste') }}</strong><small>{{ t('elevatedPasteDescription') }}</small></span><input v-model="elevatedPasteEnabled" data-testid="elevated-paste-toggle" class="switch" type="checkbox" :disabled="nativeRuntime && !nativeSettingsReady" /></label>
              <button ref="sensitiveAppsTrigger" data-testid="open-sensitive-apps" class="setting-row action" type="button" :disabled="nativeRuntime && !nativeSettingsReady" @click="openSensitiveApps"><span><strong>{{ t('excludeSensitiveApps') }}</strong><small>{{ t('excludedAppsCount', { count: excludedApps.length }) }}</small></span><span class="select-button">{{ t('manage') }}</span></button>
            </article>
            <StorageManager
              v-if="nativeRuntime"
              :locale="locale"
              :stats="storageStats"
              :health="historyHealth"
              :prepared-restore="preparedRestore"
              :busy-operation="busyStorageOperation"
              :status-message="storageStatusMessage"
              @backup="createHistoryBackup"
              @prepare-restore="prepareHistoryRestore"
              @commit-restore="commitHistoryRestore"
              @discard-restore="discardHistoryRestore"
              @compact="compactHistoryDatabase"
              @open-data-directory="openHistoryDataDirectory"
              @refresh="refreshHistoryStorage"
            />
            <article class="update-card" :aria-busy="updateBusy">
              <Download :size="18" aria-hidden="true" />
              <div class="update-copy">
                <div class="update-title"><strong>{{ t('softwareUpdate') }}</strong><span data-testid="current-version">v{{ currentVersion }}</span></div>
                <p data-testid="update-status" :class="{ error: updateState === 'error' }">{{ updateStatusText }}</p>
                <div v-if="updateProgress && ['downloading', 'verifying', 'installing'].includes(updateState)" class="update-progress" role="progressbar" :aria-label="updateStatusText" :aria-valuenow="updateProgress.percent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${updateProgress.percent}%` }"></span></div>
                <small v-if="updateStatus?.assetSize">{{ formatUpdateSize(updateStatus.assetSize) }} · {{ t('updateIntegrityNotice') }}</small>
                <small v-else>{{ t('updatePrivacyNotice') }}</small>
              </div>
              <div class="update-actions">
                <label class="update-auto"><input v-model="autoCheckUpdates" class="switch" type="checkbox" /><span>{{ t('autoCheckUpdates') }}</span></label>
                <button data-testid="check-update" class="select-button" type="button" :disabled="!nativeRuntime || updateBusy" @click="runUpdateCheck(true)"><RefreshCw :size="14" />{{ t('checkUpdates') }}</button>
                <button v-if="updateStatus?.updateAvailable && updateStatus.automaticInstallAvailable" data-testid="install-update" class="select-button primary" type="button" :disabled="updateBusy" @click="installAvailableUpdate"><Download :size="14" />{{ t('downloadInstall') }}</button>
              </div>
            </article>
          </section>
        </main>
      </section>
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
      <div v-if="collectionDeleteTarget" class="settings-modal-backdrop" @click.self="closeDeleteCollection">
        <section data-testid="manager-collection-delete-confirmation" class="settings-modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="manager-collection-delete-title" aria-describedby="manager-collection-delete-description" @keydown="trapModalFocus">
          <header>
            <div><Trash2 :size="19" /><span><strong id="manager-collection-delete-title">{{ t('managerDeleteCollectionTitle') }}</strong><small id="manager-collection-delete-description">{{ t('managerDeleteCollectionDescription', { name: collectionDeleteTarget.name }) }}</small></span></div>
          </header>
          <div class="confirm-actions">
            <button data-testid="manager-cancel-delete-collection" class="secondary-button" type="button" :disabled="managerOperationBusy" @click="closeDeleteCollection">{{ t('cancel') }}</button>
            <button data-testid="manager-confirm-delete-collection" class="danger-button" type="button" :disabled="managerOperationBusy" @click="confirmDeleteCollection">{{ t('managerDeleteCollectionConfirm') }}</button>
          </div>
          <p v-if="collectionError" data-testid="manager-collection-delete-error" role="alert">{{ collectionError }}</p>
        </section>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="permanentSnippetDeleteTarget" class="settings-modal-backdrop" @click.self="closeDeletePermanentSnippet">
        <section data-testid="manager-permanent-delete-confirmation" class="settings-modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="manager-permanent-delete-title" aria-describedby="manager-permanent-delete-description" @keydown="trapModalFocus">
          <header>
            <div><Trash2 :size="19" /><span><strong id="manager-permanent-delete-title">{{ t('managerPermanentDeleteTitle') }}</strong><small id="manager-permanent-delete-description">{{ t('managerPermanentDeleteDescription', { title: permanentSnippetDeleteTarget.title }) }}</small></span></div>
          </header>
          <div class="confirm-actions">
            <button data-testid="manager-cancel-delete-permanent" class="secondary-button" type="button" :disabled="managerOperationBusy" @click="closeDeletePermanentSnippet">{{ t('cancel') }}</button>
            <button data-testid="manager-confirm-delete-permanent" class="danger-button" type="button" :disabled="managerOperationBusy" @click="confirmDeletePermanentSnippet">{{ t('managerConfirmDelete') }}</button>
          </div>
          <p v-if="permanentSnippetDeleteError" data-testid="manager-permanent-delete-error" role="alert">{{ permanentSnippetDeleteError }}</p>
        </section>
      </div>
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
      <div v-if="clearHistoryOpen" class="settings-modal-backdrop" @click.self="closeClearHistory">
        <section data-testid="clear-history-dialog" class="settings-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="clear-history-title" aria-describedby="clear-history-description" @keydown="trapModalFocus">
          <header>
            <div><Trash2 :size="19" /><span><strong id="clear-history-title">{{ t('clearHistoryTitle') }}</strong><small id="clear-history-description">{{ ordinaryClearDescription }}</small></span></div>
          </header>
          <div class="confirm-actions">
            <button ref="clearHistoryCancel" data-testid="cancel-clear-history" class="secondary-button" type="button" @click="closeClearHistory">{{ t('cancel') }}</button>
            <button data-testid="confirm-clear-history" class="danger-button" type="button" @click="confirmClearHistory">{{ t('confirmClear') }}</button>
          </div>
        </section>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="pendingRetentionChange" class="settings-modal-backdrop" @click.self="closeRetentionChange">
        <section data-testid="retention-change-dialog" class="settings-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="retention-change-title" aria-describedby="retention-change-description" @keydown="trapModalFocus">
          <header>
            <div><Trash2 :size="19" /><span><strong id="retention-change-title">{{ t('retentionChangeTitle') }}</strong><small id="retention-change-description">{{ t('retentionChangeDescription', { count: pendingRetentionChange.removedCount, period: retentionPeriodLabel(pendingRetentionChange.value) }) }}</small></span></div>
          </header>
          <div class="confirm-actions">
            <button ref="retentionChangeCancel" data-testid="cancel-retention-change" class="secondary-button" type="button" @click="closeRetentionChange">{{ t('cancel') }}</button>
            <button data-testid="confirm-retention-change" class="danger-button" type="button" @click="confirmRetentionChange">{{ t('confirmRetentionChange') }}</button>
          </div>
        </section>
      </div>
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
      <div v-if="onboardingStep >= 0" class="onboarding-backdrop">
        <section
          ref="onboardingDialog"
          data-testid="onboarding-dialog"
          class="onboarding-dialog"
          tabindex="-1"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
          aria-describedby="onboarding-description"
          @keydown="trapModalFocus"
        >
          <header class="onboarding-header" data-tauri-drag-region="deep">
            <div class="onboarding-brand">
              <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
              <span>{{ t('productName') }}</span>
            </div>
            <button class="skip-button" type="button" :aria-label="t('skipOnboarding')" @click="finishOnboarding">{{ t('skip') }}</button>
          </header>

          <div class="onboarding-visual" :data-step="onboardingStep">
            <div v-if="onboardingStep === 0" class="shortcut-visual">
              <span class="floating-sheet sheet-back"></span>
              <span class="floating-sheet sheet-front"><Keyboard :size="27" /></span>
              <div class="shortcut-keys">
                <template v-for="(part, index) in globalShortcut.split('+')" :key="part">
                  <span v-if="index">+</span><kbd>{{ part }}</kbd>
                </template>
              </div>
            </div>
            <div v-else-if="onboardingStep === 1" class="search-visual">
              <div class="mini-search"><Search :size="15" /><span>{{ locale === 'zh-CN' ? 'huiyi' : 'meeting' }}</span><kbd>Enter</kbd></div>
              <div class="mini-result selected"><AlignLeft :size="15" /><span><strong>{{ t('exampleMeetingTitle') }}</strong><small>{{ t('exampleChatApp') }} · {{ formatRelativeTime(relativeTimeNow.toISOString(), relativeTimeNow, locale) }}</small></span><Check :size="15" /></div>
              <div class="mini-result"><ImageIcon :size="15" /><span><strong>{{ t('exampleImageTitle') }}</strong><small>{{ t('exampleCaptureApp') }} · {{ t('twoHoursAgo') }}</small></span></div>
            </div>
            <div v-else class="privacy-visual">
              <span class="privacy-orbit"><ShieldCheck :size="32" /></span>
              <div class="privacy-pill"><span><span class="state-dot"></span>{{ t('localStorage') }}</span><strong>{{ t('enabled') }}</strong></div>
            </div>
          </div>

          <div class="onboarding-copy">
            <span>{{ currentOnboardingStep.eyebrow }}</span>
            <h1 id="onboarding-title">{{ currentOnboardingStep.title }}</h1>
            <p id="onboarding-description">{{ currentOnboardingStep.description }}</p>
          </div>

          <footer class="onboarding-footer">
            <div class="step-dots" role="progressbar" :aria-label="t('guideProgress')" aria-valuemin="1" :aria-valuemax="onboardingSteps.length" :aria-valuenow="onboardingStep + 1">
              <span v-for="(_, index) in onboardingSteps" :key="index" :class="{ active: onboardingStep === index }"></span>
            </div>
            <button
              v-if="onboardingStep < onboardingSteps.length - 1"
              ref="onboardingPrimary"
              data-testid="onboarding-next"
              class="primary-button onboarding-next"
              type="button"
              @click="advanceOnboarding"
            >{{ t('next') }}</button>
            <div v-else class="onboarding-choice-actions">
              <button
                data-testid="onboarding-skip-sample"
                class="secondary-button onboarding-next"
                type="button"
                :disabled="onboardingSampleBusy"
                @click="finishOnboarding"
              >{{ t('onboardingSkipSample') }}</button>
              <button
                ref="onboardingPrimary"
                data-testid="onboarding-add-sample"
                class="primary-button onboarding-next"
                type="button"
                :disabled="onboardingSampleBusy || (nativeRuntime && historyState !== 'ready')"
                @click="finishOnboardingWithSample"
              >{{ onboardingSampleBusy ? t('onboardingAddingSample') : t('onboardingAddSample') }}</button>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </div>
</template>
