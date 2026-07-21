import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { shouldAutoCheckUpdate } from '../domain/update'
import type { MessageKey } from '../i18n'
import {
  checkForUpdate,
  connectUpdateCheckRequested,
  downloadUpdate,
  getCurrentVersion,
  installDownloadedUpdate,
  type UpdateProgress,
  type UpdateStatus,
} from '../platform/updater'

type Translator = (key: MessageKey, replacements?: Record<string, string | number>) => string

interface UseUpdaterOptions {
  nativeRuntime: boolean
  autoCheckUpdates: Ref<boolean>
  nativeSettingsReady: Ref<boolean>
  t: Translator
  showToast: (message: string, urgent?: boolean) => void
  openSettings: () => Promise<void>
  flushHistory: () => Promise<boolean>
  isUnmounted: () => boolean
}

const UPDATE_CHECK_STORAGE_KEY = 'quickpaste-update-check-v1'
const AUTO_UPDATE_CHECK_DELAY_MS = 15_000

function readLastUpdateCheckAt(): number | null {
  try {
    const value = Number(localStorage.getItem(UPDATE_CHECK_STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeLastUpdateCheckAt(value: number): void {
  try {
    localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, String(value))
  } catch {
    // 检查时间只用于本地节流，存储不可用不应阻止更新检查。
  }
}

export function useUpdater(options: UseUpdaterOptions) {
  const currentVersion = ref('—')
  const updateStatus = ref<UpdateStatus | null>(null)
  const updateProgress = ref<UpdateProgress | null>(null)
  const updateState = ref<'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'verifying' | 'installing' | 'error'>('idle')
  const updateError = ref('')
  const updateNoticeVisible = ref(false)
  let disconnectUpdateCheckRequested: (() => void) | undefined
  let autoUpdateCheckTimer: ReturnType<typeof setTimeout> | undefined
  let updateNoticeTimer: ReturnType<typeof setTimeout> | undefined

  const updateBusy = computed(() => ['checking', 'downloading', 'verifying', 'installing'].includes(updateState.value))
  const updateStatusText = computed(() => {
    if (updateState.value === 'checking') return options.t('updateChecking')
    if (updateState.value === 'downloading') return options.t('updateDownloading', { percent: updateProgress.value?.percent ?? 0 })
    if (updateState.value === 'verifying') return options.t('updateVerifying')
    if (updateState.value === 'installing') return options.t('updateInstalling')
    if (updateState.value === 'available' && updateStatus.value) {
      return options.t('updateAvailableVersion', { version: updateStatus.value.latestVersion })
    }
    if (updateState.value === 'latest') return options.t('updateLatest')
    if (updateState.value === 'error') return updateError.value || options.t('updateCheckFailed')
    return options.t('updateNotChecked')
  })

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

  async function runUpdateCheck(manual: boolean) {
    if (!options.nativeRuntime || updateBusy.value) return
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
          : options.t('updateCheckFailed')
        updateState.value = 'error'
        options.showToast(options.t('updateCheckFailed'), true)
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
      if (!prepared) throw new Error(options.t('updateInstallFailed'))
      if (!await options.flushHistory()) throw new Error(options.t('historyQuitSaveFailed'))
      updateState.value = 'installing'
      const result = await installDownloadedUpdate(prepared.token)
      if (!result) throw new Error(options.t('updateInstallFailed'))
    } catch (error) {
      updateError.value = error instanceof Error && error.message.trim()
        ? error.message
        : options.t('updateInstallFailed')
      updateState.value = 'error'
      options.showToast(updateError.value, true)
    }
  }

  function scheduleAutomaticUpdateCheck() {
    if (autoUpdateCheckTimer) clearTimeout(autoUpdateCheckTimer)
    autoUpdateCheckTimer = undefined
    if (!options.nativeRuntime
      || !options.autoCheckUpdates.value
      || !shouldAutoCheckUpdate(readLastUpdateCheckAt())) return
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
        await options.openSettings()
        await runUpdateCheck(true)
      })()
    })
    if (disconnect) {
      if (options.isUnmounted()) disconnect()
      else disconnectUpdateCheckRequested = disconnect
    }
    scheduleAutomaticUpdateCheck()
  }

  watch(options.autoCheckUpdates, () => {
    if (options.nativeSettingsReady.value) scheduleAutomaticUpdateCheck()
  })

  onBeforeUnmount(() => {
    disconnectUpdateCheckRequested?.()
    if (autoUpdateCheckTimer) clearTimeout(autoUpdateCheckTimer)
    if (updateNoticeTimer) clearTimeout(updateNoticeTimer)
  })

  return {
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
  }
}
