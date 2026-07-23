import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import {
  OFFICIAL_RELEASES_URL,
  classifyUpdateFailure,
  shouldAutoCheckUpdate,
  updateCheckLocalDateKey,
  type UpdateFailureKind,
} from '../domain/update'
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
import { openExternalLink } from '../platform/system'

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
const UPDATE_CHECK_LOCAL_DATE_STORAGE_KEY = 'quickpaste-update-check-local-date-v1'
const AUTO_UPDATE_CHECK_DELAY_MS = 15_000

function readLastUpdateCheckAt(): number | null {
  try {
    const value = Number(localStorage.getItem(UPDATE_CHECK_STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function readLastUpdateCheckLocalDate(): string | null {
  try {
    return localStorage.getItem(UPDATE_CHECK_LOCAL_DATE_STORAGE_KEY)?.trim() || null
  } catch {
    return null
  }
}

function writeLastUpdateCheckAt(value: number): void {
  try {
    localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, String(value))
  } catch {
    // 日期键仍可独立完成当天节流。
  }
  const localDate = updateCheckLocalDateKey(value)
  try {
    if (localDate) localStorage.setItem(UPDATE_CHECK_LOCAL_DATE_STORAGE_KEY, localDate)
    else localStorage.removeItem(UPDATE_CHECK_LOCAL_DATE_STORAGE_KEY)
  } catch {
    try {
      localStorage.removeItem(UPDATE_CHECK_LOCAL_DATE_STORAGE_KEY)
    } catch {
      // 存储不可用时保持 fail-open，不应阻止更新检查。
    }
  }
}

export function useUpdater(options: UseUpdaterOptions) {
  const currentVersion = ref('—')
  const updateStatus = ref<UpdateStatus | null>(null)
  const updateProgress = ref<UpdateProgress | null>(null)
  const updateState = ref<'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'verifying' | 'installing' | 'error'>('idle')
  const updateError = ref('')
  const updateFailurePhase = ref<'check' | 'download' | 'install' | null>(null)
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

  function updateFailureMessage(
    phase: 'check' | 'download' | 'install',
    kind: UpdateFailureKind,
  ): string {
    if (phase === 'check') {
      if (kind === 'timeout') return options.t('updateCheckTimeout')
      if (kind === 'unreachable') return options.t('updateCheckUnreachable')
      return options.t('updateCheckFailed')
    }
    if (phase === 'download') {
      if (kind === 'timeout') return options.t('updateDownloadTimeout')
      if (kind === 'unreachable') return options.t('updateDownloadUnreachable')
      return options.t('updateDownloadFailed')
    }
    return options.t('updateInstallFailed')
  }

  function setUpdateFailure(phase: 'check' | 'download' | 'install', error: unknown) {
    updateFailurePhase.value = phase
    updateError.value = updateFailureMessage(phase, classifyUpdateFailure(error))
    updateState.value = 'error'
    options.showToast(updateError.value, true)
  }

  async function runUpdateCheck(manual: boolean) {
    if (!options.nativeRuntime || updateBusy.value) return
    if (manual && autoUpdateCheckTimer) {
      clearTimeout(autoUpdateCheckTimer)
      autoUpdateCheckTimer = undefined
    }
    updateState.value = 'checking'
    updateError.value = ''
    updateFailurePhase.value = null
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
        setUpdateFailure('check', error)
      } else {
        updateState.value = 'idle'
        updateFailurePhase.value = null
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
    updateFailurePhase.value = null
    updateProgress.value = null
    let failurePhase: 'download' | 'install' = 'download'
    try {
      const prepared = await downloadUpdate(status.latestVersion, (progress) => {
        updateProgress.value = progress
        updateState.value = progress.phase
      })
      if (!prepared) throw new Error(options.t('updateInstallFailed'))
      failurePhase = 'install'
      if (!await options.flushHistory()) throw new Error(options.t('historyQuitSaveFailed'))
      updateState.value = 'installing'
      const result = await installDownloadedUpdate(prepared.token)
      if (!result) throw new Error(options.t('updateInstallFailed'))
    } catch (error) {
      if (failurePhase === 'install'
        && error instanceof Error
        && error.message === options.t('historyQuitSaveFailed')) {
        updateFailurePhase.value = 'install'
        updateError.value = error.message
        updateState.value = 'error'
        options.showToast(updateError.value, true)
      } else {
        setUpdateFailure(failurePhase, error)
      }
    }
  }

  async function retryFailedUpdate() {
    if (updateBusy.value) return
    const phase = updateFailurePhase.value
    if (phase === 'check') await runUpdateCheck(true)
    else if (phase === 'download') await installAvailableUpdate()
  }

  async function openOfficialReleases() {
    if (!await openExternalLink(OFFICIAL_RELEASES_URL)) {
      options.showToast(options.t('releasesOpenFailed'), true)
    }
  }

  function scheduleAutomaticUpdateCheck() {
    if (autoUpdateCheckTimer) clearTimeout(autoUpdateCheckTimer)
    autoUpdateCheckTimer = undefined
    if (!options.nativeRuntime
      || !options.autoCheckUpdates.value
      || !shouldAutoCheckUpdate(
        readLastUpdateCheckAt(),
        Date.now(),
        readLastUpdateCheckLocalDate(),
      )) return
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
    updateFailurePhase,
    updateBusy,
    updateStatusText,
    hideUpdateNotice,
    runUpdateCheck,
    installAvailableUpdate,
    retryFailedUpdate,
    openOfficialReleases,
    connectUpdaterBridge,
  }
}
