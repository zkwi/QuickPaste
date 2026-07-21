import { ref, type Ref } from 'vue'
import type { MessageKey } from '../i18n'
import {
  compactNativeHistoryDatabase,
  commitNativeHistoryRestore,
  createNativeHistoryBackup,
  discardNativeHistoryRestore,
  getNativeHistoryHealth,
  getNativeStorageStats,
  openNativeHistoryDataDirectory,
  prepareNativeHistoryRestore,
  type CapacityPolicy,
  type HistoryExclusiveLease,
  type PreparedRestore,
  type StorageOperation,
} from '../platform/history'

type Translator = (key: MessageKey, replacements?: Record<string, string | number>) => string
type HistoryState = 'loading' | 'ready' | 'error'

interface UseStorageOperationsOptions {
  nativeRuntime: boolean
  historyState: Ref<HistoryState>
  ocrEnabled: Ref<boolean>
  t: Translator
  isUnmounted: () => boolean
  acquireLease: (
    operation: Exclude<StorageOperation, null | 'refresh'>,
    allowReadOnly?: boolean,
  ) => Promise<HistoryExclusiveLease | null>
  releaseLease: (lease: HistoryExclusiveLease) => Promise<void>
  beforeRestore: () => Promise<boolean>
  adoptPolicy: (policy: CapacityPolicy) => Promise<void>
  reloadHistory: () => Promise<boolean>
  refreshCollections: () => Promise<boolean>
  resumePendingOcr: () => void
}

export function useStorageOperations(options: UseStorageOperationsOptions) {
  const storageStats = ref<Awaited<ReturnType<typeof getNativeStorageStats>>>(null)
  const historyHealth = ref<Awaited<ReturnType<typeof getNativeHistoryHealth>>>(null)
  const preparedRestore = ref<PreparedRestore | null>(null)
  const busyStorageOperation = ref<StorageOperation>(null)
  const storageStatusMessage = ref('')
  let storageRefreshGeneration = 0

  async function refreshStorageState(): Promise<boolean> {
    if (!options.nativeRuntime) return false
    const generation = ++storageRefreshGeneration
    const [health, stats] = await Promise.all([getNativeHistoryHealth(), getNativeStorageStats()])
    if (options.isUnmounted() || generation !== storageRefreshGeneration) return false
    if (health) historyHealth.value = health
    if (stats) storageStats.value = stats
    return health !== null && stats !== null
  }

  async function createHistoryBackup() {
    if (preparedRestore.value) return
    const lease = await options.acquireLease('backup')
    if (!lease) return
    try {
      const result = await createNativeHistoryBackup()
      if (!result) {
        storageStatusMessage.value = options.t('storageBackupFailed')
        return
      }
      if (result.status === 'cancelled') {
        storageStatusMessage.value = options.t('storageBackupCancelled')
        return
      }
      storageStatusMessage.value = options.t('storageBackupSaved')
      const stats = await getNativeStorageStats()
      if (stats && !options.isUnmounted()) storageStats.value = stats
    } finally {
      await options.releaseLease(lease)
    }
  }

  async function prepareHistoryRestore() {
    if (preparedRestore.value) return
    const lease = await options.acquireLease('prepare-restore')
    if (!lease) return
    try {
      const result = await prepareNativeHistoryRestore()
      if (!result) {
        storageStatusMessage.value = options.t('storageRestoreValidationFailed')
        return
      }
      if (result.status === 'cancelled') {
        storageStatusMessage.value = options.t('storageRestoreCancelled')
        return
      }
      preparedRestore.value = result
      storageStatusMessage.value = options.t('storageRestoreValidated')
    } finally {
      await options.releaseLease(lease)
    }
  }

  async function commitHistoryRestore(token: string) {
    if (!preparedRestore.value || preparedRestore.value.token !== token) return
    const lease = await options.acquireLease('commit-restore')
    if (!lease) return
    try {
      if (!await options.beforeRestore()) {
        storageStatusMessage.value = options.t('storageRestoreOcrInvalidationFailed')
        return
      }
      const result = await commitNativeHistoryRestore(token)
      if (!result) {
        preparedRestore.value = null
        storageStatusMessage.value = options.t('storageRestoreCommitFailed')
        return
      }

      preparedRestore.value = null
      storageRefreshGeneration += 1
      storageStats.value = result.stats
      await options.adoptPolicy(result.policy)
      options.historyState.value = 'loading'
      if (!await options.reloadHistory()) {
        options.historyState.value = 'error'
        storageStatusMessage.value = options.t('storageRestoreReloadFailed')
        return
      }
      await options.refreshCollections()
      await refreshStorageState()
      storageStatusMessage.value = options.t('storageRestoreCompleted', { count: result.importedCount })
    } finally {
      await options.releaseLease(lease)
      if (!options.isUnmounted() && options.ocrEnabled.value) options.resumePendingOcr()
    }
  }

  async function discardHistoryRestore(token: string) {
    if (!preparedRestore.value || preparedRestore.value.token !== token) return
    const lease = await options.acquireLease('discard-restore', true)
    if (!lease) return
    try {
      const result = await discardNativeHistoryRestore(token)
      if (!result) {
        storageStatusMessage.value = options.t('storageRestoreDiscardFailed')
        return
      }
      preparedRestore.value = null
      storageStatusMessage.value = options.t('storageRestoreCancelled')
    } finally {
      await options.releaseLease(lease)
    }
  }

  async function compactHistoryDatabase() {
    if (preparedRestore.value) return
    const lease = await options.acquireLease('compact')
    if (!lease) return
    try {
      const stats = await compactNativeHistoryDatabase()
      if (!stats) {
        storageStatusMessage.value = options.t('storageCompactionFailed')
        return
      }
      storageStats.value = stats
      storageStatusMessage.value = options.t('storageCompactionCompleted')
    } finally {
      await options.releaseLease(lease)
    }
  }

  async function refreshHistoryStorage() {
    if (busyStorageOperation.value !== null) return
    busyStorageOperation.value = 'refresh'
    storageStatusMessage.value = ''
    try {
      const refreshed = await refreshStorageState()
      storageStatusMessage.value = refreshed
        ? options.t('storageStatsRefreshed')
        : options.t('storageStatsUnavailable')
    } finally {
      busyStorageOperation.value = null
    }
  }

  async function openHistoryDataDirectory() {
    const opened = await openNativeHistoryDataDirectory()
    storageStatusMessage.value = opened
      ? options.t('storageDirectoryOpened')
      : options.t('storageDirectoryOpenFailed')
  }

  return {
    storageStats,
    historyHealth,
    preparedRestore,
    busyStorageOperation,
    storageStatusMessage,
    refreshStorageState,
    createHistoryBackup,
    prepareHistoryRestore,
    commitHistoryRestore,
    discardHistoryRestore,
    compactHistoryDatabase,
    refreshHistoryStorage,
    openHistoryDataDirectory,
  }
}
