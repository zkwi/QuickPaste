import { trimSearchWhitespace, type RetentionPeriod } from './clipboard'
import { DEFAULT_GLOBAL_SHORTCUT } from './shortcut'

export type Theme = 'light' | 'dark'
export type SettingsLocale = 'zh-CN' | 'en-US'

export interface CapacityPolicy {
  maxRecords: number
  maxImageBytes: number
  retentionDays: number | null
}

export interface StoredSettings {
  settingsVersion: number
  theme: Theme
  locale: SettingsLocale
  retentionDays: string
  historyPolicy: CapacityPolicy
  launchAtStartup: boolean
  hideDuringSharing: boolean
  elevatedPasteEnabled: boolean
  capturePaused: boolean
  excludedApps: string[]
  globalShortcut: string
  onboardingCompleted: boolean
  quickPanelPinned: boolean
  autoCheckUpdates: boolean
  ocrEnabled: boolean
}

export const SETTINGS_SCHEMA_VERSION = 5
export const DEFAULT_HISTORY_POLICY: Readonly<CapacityPolicy> = Object.freeze({
  maxRecords: 500,
  maxImageBytes: 256 * 1024 * 1024,
  retentionDays: 30,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function cloneDefaultPolicy(): CapacityPolicy {
  return { ...DEFAULT_HISTORY_POLICY }
}

function parseStoredHistoryPolicy(value: unknown): CapacityPolicy | null {
  if (!isRecord(value)) return null
  const expectedKeys = ['maxRecords', 'maxImageBytes', 'retentionDays']
  if (Object.keys(value).length !== expectedKeys.length
    || !Object.keys(value).every((key) => expectedKeys.includes(key))
    || !Number.isSafeInteger(value.maxRecords)
    || (value.maxRecords as number) < 0
    || !Number.isSafeInteger(value.maxImageBytes)
    || (value.maxImageBytes as number) < 0
    || value.retentionDays !== null
      && (!Number.isSafeInteger(value.retentionDays) || (value.retentionDays as number) < 0)) {
    return null
  }
  return {
    maxRecords: value.maxRecords as number,
    maxImageBytes: value.maxImageBytes as number,
    retentionDays: value.retentionDays as number | null,
  }
}

function normalizeExcludedApps(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  return value.reduce<string[]>((apps, candidate) => {
    if (typeof candidate !== 'string') return apps
    const app = trimSearchWhitespace(candidate)
    if (!app || apps.some((current) => current.toLocaleLowerCase() === app.toLocaleLowerCase())) {
      return apps
    }
    apps.push(app)
    return apps
  }, [])
}

export function defaultStoredSettings(): StoredSettings {
  return {
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    theme: 'light',
    locale: 'zh-CN',
    retentionDays: '30',
    historyPolicy: cloneDefaultPolicy(),
    launchAtStartup: false,
    hideDuringSharing: false,
    elevatedPasteEnabled: true,
    capturePaused: false,
    excludedApps: ['1Password', 'Bitwarden'],
    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
    onboardingCompleted: false,
    quickPanelPinned: false,
    autoCheckUpdates: true,
    ocrEnabled: true,
  }
}

export function retentionPeriodForPolicy(policy: CapacityPolicy): RetentionPeriod {
  if (policy.retentionDays === null) return 'forever'
  const value = String(policy.retentionDays)
  return value === '7' || value === '30' || value === '90' ? value : 'forever'
}

export function normalizeStoredSettings(value: unknown): StoredSettings {
  const defaults = defaultStoredSettings()
  if (!isRecord(value)) return defaults

  const hasCurrentCaptureProtectionSemantics = typeof value.settingsVersion === 'number'
    && value.settingsVersion >= 2
  const legacyRetention = typeof value.retentionDays === 'string'
    && ['7', '30', '90', 'forever'].includes(value.retentionDays)
    ? value.retentionDays as RetentionPeriod
    : null
  const parsedHistoryPolicy = parseStoredHistoryPolicy(value.historyPolicy)
  const historyPolicy = parsedHistoryPolicy
    ?? (value.historyPolicy === undefined && legacyRetention
      ? {
          ...DEFAULT_HISTORY_POLICY,
          retentionDays: legacyRetention === 'forever' ? null : Number(legacyRetention),
        }
      : cloneDefaultPolicy())

  return {
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    theme: value.theme === 'dark' ? 'dark' : 'light',
    locale: value.locale === 'en-US' ? 'en-US' : 'zh-CN',
    retentionDays: historyPolicy.retentionDays === null ? 'forever' : String(historyPolicy.retentionDays),
    historyPolicy,
    launchAtStartup: storedBoolean(value.launchAtStartup, defaults.launchAtStartup),
    // v1 无法区分旧默认值和用户选择；v2 起才保留明确开启。
    hideDuringSharing: hasCurrentCaptureProtectionSemantics
      ? storedBoolean(value.hideDuringSharing, defaults.hideDuringSharing)
      : defaults.hideDuringSharing,
    elevatedPasteEnabled: storedBoolean(value.elevatedPasteEnabled, defaults.elevatedPasteEnabled),
    capturePaused: storedBoolean(value.capturePaused, defaults.capturePaused),
    excludedApps: normalizeExcludedApps(value.excludedApps, defaults.excludedApps),
    globalShortcut: typeof value.globalShortcut === 'string'
      ? value.globalShortcut
      : defaults.globalShortcut,
    onboardingCompleted: storedBoolean(value.onboardingCompleted, defaults.onboardingCompleted),
    quickPanelPinned: storedBoolean(value.quickPanelPinned, defaults.quickPanelPinned),
    autoCheckUpdates: storedBoolean(value.autoCheckUpdates, defaults.autoCheckUpdates),
    // OCR 是本地能力且默认开启；只有真正的布尔 false 才代表用户关闭。
    ocrEnabled: storedBoolean(value.ocrEnabled, defaults.ocrEnabled),
  }
}

export function parseStoredSettingsJson(value: string | null): StoredSettings {
  if (!value) return defaultStoredSettings()
  try {
    return normalizeStoredSettings(JSON.parse(value))
  } catch {
    return defaultStoredSettings()
  }
}
