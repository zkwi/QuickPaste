<script setup lang="ts">
import { Download, Keyboard, LayoutList, Monitor, RefreshCw, ShieldCheck } from 'lucide-vue-next'
import { displayShortcut } from '../domain/shortcut'
import { formatUpdateSize } from '../domain/update'
import type { Theme } from '../domain/settings'
import type { Locale, MessageKey } from '../i18n'
import type { HistoryHealth, PreparedRestore, StorageOperation, StorageStats } from '../platform/history'
import type { UpdateProgress, UpdateStatus } from '../platform/updater'
import StorageManager from './StorageManager.vue'

type Translator = (key: MessageKey, replacements?: Record<string, string | number>) => string
type HistoryState = 'loading' | 'ready' | 'error'
type UpdateState = 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'verifying' | 'installing' | 'error'

defineProps<{
  nativeRuntime: boolean
  nativeSettingsReady: boolean
  globalShortcut: string
  globalShortcutAvailable: boolean
  shortcutRecording: boolean
  shortcutApplyInFlight: boolean
  shortcutConflictMessage: string
  historyState: HistoryState
  retentionSelectValue: string
  customRetentionDays: number | null
  excludedAppsCount: number
  storageStats: StorageStats | null
  historyHealth: HistoryHealth | null
  preparedRestore: PreparedRestore | null
  busyStorageOperation: StorageOperation
  storageStatusMessage: string
  currentVersion: string
  updateStatus: UpdateStatus | null
  updateProgress: UpdateProgress | null
  updateState: UpdateState
  updateBusy: boolean
  updateStatusText: string
  t: Translator
}>()

const launchAtStartup = defineModel<boolean>('launchAtStartup', { required: true })
const theme = defineModel<Theme>('theme', { required: true })
const locale = defineModel<Locale>('locale', { required: true })
const hideDuringSharing = defineModel<boolean>('hideDuringSharing', { required: true })
const ocrEnabled = defineModel<boolean>('ocrEnabled', { required: true })
const elevatedPasteEnabled = defineModel<boolean>('elevatedPasteEnabled', { required: true })
const autoCheckUpdates = defineModel<boolean>('autoCheckUpdates', { required: true })

const emit = defineEmits<{
  openClipboard: []
  toggleTheme: []
  startShortcutRecording: []
  cancelShortcutRecording: []
  retentionChange: [event: Event]
  openSensitiveApps: [trigger: HTMLButtonElement]
  backup: []
  prepareRestore: []
  commitRestore: [token: string]
  discardRestore: [token: string]
  compact: []
  openDataDirectory: []
  refreshStorage: []
  checkUpdate: []
  installUpdate: []
}>()

function openSensitiveApps(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLButtonElement) emit('openSensitiveApps', event.currentTarget)
}
</script>

<template>
  <section class="settings-content" :aria-busy="nativeRuntime && !nativeSettingsReady">
    <p v-if="nativeRuntime && !nativeSettingsReady" class="settings-loading" role="status">{{ t('settingsLoading') }}</p>
    <section class="settings-primary-actions" data-testid="settings-primary-actions" :aria-label="t('settingsPrimaryActions')">
      <button data-testid="settings-open-clipboard" class="settings-primary-card settings-clipboard-card" type="button" :aria-label="t('manageClipboard')" @click="emit('openClipboard')">
        <span class="settings-primary-icon" aria-hidden="true"><LayoutList :size="19" /></span>
        <span class="settings-primary-copy"><strong>{{ t('manageClipboard') }}</strong><small>{{ t('settingsClipboardEntryDescription') }}</small></span>
        <span class="settings-primary-link">{{ t('manageClipboardShort') }}</span>
      </button>
      <article class="shortcut-card" :class="{ recording: shortcutRecording, unavailable: !globalShortcutAvailable }">
        <span class="settings-primary-icon" aria-hidden="true"><Keyboard :size="19" /></span>
        <div><strong>{{ t('openQuickPaste') }}</strong><p>{{ shortcutRecording ? t('shortcutRecordingHint') : t('globalShortcutDescription') }}</p><small v-if="!globalShortcutAvailable" id="shortcut-status" data-testid="shortcut-status">{{ t('shortcutInactive') }}</small><small v-else-if="shortcutConflictMessage" id="shortcut-conflict" data-testid="shortcut-conflict" class="shortcut-conflict">{{ shortcutConflictMessage }}</small></div>
        <button data-testid="shortcut-recorder" class="shortcut-recorder" type="button" :disabled="shortcutApplyInFlight || (nativeRuntime && !nativeSettingsReady)" :aria-label="t('globalShortcutControl', { shortcut: shortcutRecording ? t('shortcutRecording') : displayShortcut(globalShortcut) })" :title="t('globalShortcutControl', { shortcut: shortcutRecording ? t('shortcutRecording') : displayShortcut(globalShortcut) })" :aria-invalid="!globalShortcutAvailable ? 'true' : undefined" :aria-describedby="!globalShortcutAvailable ? 'shortcut-status' : shortcutConflictMessage ? 'shortcut-conflict' : undefined" @click="emit('startShortcutRecording')" @blur="emit('cancelShortcutRecording')">
          <kbd>{{ shortcutRecording ? t('shortcutRecording') : displayShortcut(globalShortcut) }}</kbd>
        </button>
      </article>
    </section>
    <article class="setting-group">
      <div class="setting-heading"><Monitor :size="18" /><div><h2>{{ t('startupAppearance') }}</h2><p>{{ t('startupAppearanceDescription') }}</p></div></div>
      <label class="setting-row"><span><strong>{{ t('launchAtStartup') }}</strong><small>{{ t('launchAtStartupDescription') }}</small></span><input v-model="launchAtStartup" data-testid="launch-at-startup-toggle" class="switch" type="checkbox" :disabled="nativeRuntime && !nativeSettingsReady" /></label>
      <div class="setting-row"><span><strong>{{ t('interfaceTheme') }}</strong><small>{{ t('themeDescription', { theme: theme === 'light' ? t('light') : t('dark') }) }}</small></span><button data-testid="settings-theme-button" class="select-button" type="button" :aria-label="t('interfaceThemeControl', { theme: theme === 'light' ? t('light') : t('dark') })" @click="emit('toggleTheme')">{{ theme === 'light' ? t('light') : t('dark') }}</button></div>
      <label class="setting-row"><span><strong>{{ t('language') }}</strong><small>{{ t('languageDescription') }}</small></span><select v-model="locale" data-testid="locale-select"><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
    </article>
    <article class="setting-group">
      <div class="setting-heading"><ShieldCheck :size="18" /><div><h2>{{ t('privacy') }}</h2><p>{{ t('privacyDescription') }}</p></div></div>
      <label class="setting-row"><span><strong>{{ t('retention') }}</strong><small id="retention-description">{{ historyState === 'loading' ? t('retentionUnavailableLoading') : historyState === 'error' ? t('retentionUnavailableError') : t('retentionDescription') }}</small></span><select data-testid="retention-select" :value="retentionSelectValue" :disabled="historyState !== 'ready' || busyStorageOperation !== null" aria-describedby="retention-description" @change="emit('retentionChange', $event)"><option v-if="customRetentionDays !== null" :value="String(customRetentionDays)">{{ t('currentCustomRetentionDays', { count: customRetentionDays }) }}</option><option value="7">{{ t('daysOption', { count: 7 }) }}</option><option value="30">{{ t('daysOption', { count: 30 }) }}</option><option value="90">{{ t('daysOption', { count: 90 }) }}</option><option value="forever">{{ t('forever') }}</option></select></label>
      <label class="setting-row"><span><strong>{{ t('captureProtection') }}</strong><small>{{ t('captureProtectionDescription') }}</small></span><input v-model="hideDuringSharing" data-testid="capture-protection-toggle" class="switch" type="checkbox" :disabled="nativeRuntime && !nativeSettingsReady" /></label>
      <label v-if="nativeRuntime" class="setting-row"><span><strong>{{ t('localImageOcr') }}</strong><small id="ocr-setting-description">{{ t('localImageOcrDescription') }}</small></span><input v-model="ocrEnabled" data-testid="ocr-enabled-toggle" class="switch" type="checkbox" :disabled="!nativeSettingsReady" aria-describedby="ocr-setting-description" /></label>
      <label class="setting-row"><span><strong>{{ t('elevatedPaste') }}</strong><small>{{ t('elevatedPasteDescription') }}</small></span><input v-model="elevatedPasteEnabled" data-testid="elevated-paste-toggle" class="switch" type="checkbox" :disabled="nativeRuntime && !nativeSettingsReady" /></label>
      <button data-testid="open-sensitive-apps" class="setting-row action" type="button" :disabled="nativeRuntime && !nativeSettingsReady" @click="openSensitiveApps"><span><strong>{{ t('excludeSensitiveApps') }}</strong><small>{{ t('excludedAppsCount', { count: excludedAppsCount }) }}</small></span><span class="select-button">{{ t('manage') }}</span></button>
    </article>
    <StorageManager
      v-if="nativeRuntime"
      :locale="locale"
      :stats="storageStats"
      :health="historyHealth"
      :prepared-restore="preparedRestore"
      :busy-operation="busyStorageOperation"
      :status-message="storageStatusMessage"
      @backup="emit('backup')"
      @prepare-restore="emit('prepareRestore')"
      @commit-restore="emit('commitRestore', $event)"
      @discard-restore="emit('discardRestore', $event)"
      @compact="emit('compact')"
      @open-data-directory="emit('openDataDirectory')"
      @refresh="emit('refreshStorage')"
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
        <button data-testid="check-update" class="select-button" type="button" :disabled="!nativeRuntime || updateBusy" @click="emit('checkUpdate')"><RefreshCw :size="14" />{{ t('checkUpdates') }}</button>
        <button v-if="updateStatus?.updateAvailable && updateStatus.automaticInstallAvailable" data-testid="install-update" class="select-button primary" type="button" :disabled="updateBusy" @click="emit('installUpdate')"><Download :size="14" />{{ t('downloadInstall') }}</button>
      </div>
    </article>
  </section>
</template>
