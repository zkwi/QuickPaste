import { watch, type Ref } from 'vue'
import type { MessageKey } from '../i18n'
import { setNativeCapturePaused } from '../platform/desktop'
import {
  setCaptureExclusions,
  setElevatedPasteEnabled,
  setLaunchAtStartup,
  setScreenCaptureProtection,
} from '../platform/settings'

type Translator = (key: MessageKey, replacements?: Record<string, string | number>) => string

interface BooleanSyncState {
  confirmed: boolean
  desired: boolean
  running: boolean
  suppressNext: boolean
}

interface UseNativeSettingsSyncOptions {
  nativeRuntime: boolean
  ready: Ref<boolean>
  capturePaused: Ref<boolean>
  launchAtStartup: Ref<boolean>
  hideDuringSharing: Ref<boolean>
  elevatedPasteEnabled: Ref<boolean>
  excludedApps: Ref<string[]>
  t: Translator
  showToast: (message: string, urgent?: boolean) => void
}

export function useNativeSettingsSync(options: UseNativeSettingsSyncOptions) {
  const booleanStates = new Map<string, BooleanSyncState>()
  const excludedAppsState = {
    confirmed: [...options.excludedApps.value],
    desired: [...options.excludedApps.value],
    running: false,
    suppressNext: false,
  }

  function syncBooleanSetting(
    key: string,
    enabled: boolean,
    previous: boolean,
    apply: (value: boolean) => Promise<boolean>,
    rollback: (value: boolean) => void,
  ) {
    if (!options.nativeRuntime || !options.ready.value) return
    let state = booleanStates.get(key)
    if (!state) {
      state = { confirmed: previous, desired: previous, running: false, suppressNext: false }
      booleanStates.set(key, state)
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
          options.showToast(options.t('settingApplyFailed'), true)
          break
        }
      }
      state.running = false
    })()
  }

  function resetExcludedApps(apps: readonly string[]) {
    excludedAppsState.confirmed = [...apps]
    excludedAppsState.desired = [...apps]
  }

  watch(options.capturePaused, (enabled, previous) => {
    syncBooleanSetting('capturePaused', enabled, previous, setNativeCapturePaused, (value) => {
      options.capturePaused.value = value
    })
  })

  watch(options.launchAtStartup, (enabled, previous) => {
    syncBooleanSetting('launchAtStartup', enabled, previous, setLaunchAtStartup, (value) => {
      options.launchAtStartup.value = value
    })
  })

  watch(options.hideDuringSharing, (enabled, previous) => {
    syncBooleanSetting('hideDuringSharing', enabled, previous, setScreenCaptureProtection, (value) => {
      options.hideDuringSharing.value = value
    })
  })

  watch(options.elevatedPasteEnabled, (enabled, previous) => {
    syncBooleanSetting('elevatedPasteEnabled', enabled, previous, setElevatedPasteEnabled, (value) => {
      options.elevatedPasteEnabled.value = value
    })
  })

  watch(options.excludedApps, (apps) => {
    if (!options.nativeRuntime || !options.ready.value) return
    const nextApps = [...apps]
    if (excludedAppsState.suppressNext
      && JSON.stringify(nextApps) === JSON.stringify(excludedAppsState.confirmed)) {
      excludedAppsState.suppressNext = false
      return
    }

    excludedAppsState.desired = nextApps
    if (excludedAppsState.running) return
    excludedAppsState.running = true
    void (async () => {
      while (JSON.stringify(excludedAppsState.desired) !== JSON.stringify(excludedAppsState.confirmed)) {
        const requested = [...excludedAppsState.desired]
        const applied = await setCaptureExclusions(requested)
        if (applied) {
          excludedAppsState.confirmed = requested
          continue
        }
        if (JSON.stringify(excludedAppsState.desired) === JSON.stringify(requested)) {
          excludedAppsState.desired = [...excludedAppsState.confirmed]
          excludedAppsState.suppressNext = true
          options.excludedApps.value = [...excludedAppsState.confirmed]
          options.showToast(options.t('settingApplyFailed'), true)
          break
        }
      }
      excludedAppsState.running = false
    })()
  }, { deep: true })

  return { syncBooleanSetting, resetExcludedApps }
}
