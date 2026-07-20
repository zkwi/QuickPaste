import {
  DEFAULT_HISTORY_POLICY,
  SETTINGS_SCHEMA_VERSION,
  defaultStoredSettings,
  normalizeStoredSettings,
  parseStoredSettingsJson,
  retentionPeriodForPolicy,
} from './settings'

describe('stored settings normalization', () => {
  it('defaults OCR on when the setting is missing, malformed, or storage is corrupt', () => {
    expect(defaultStoredSettings().ocrEnabled).toBe(true)
    expect(defaultStoredSettings().onboardingPracticePending).toBe(false)
    expect(normalizeStoredSettings({}).ocrEnabled).toBe(true)
    expect(normalizeStoredSettings({ ocrEnabled: 'false' }).ocrEnabled).toBe(true)
    expect(normalizeStoredSettings({ ocrEnabled: null }).ocrEnabled).toBe(true)
    expect(parseStoredSettingsJson('{not json')).toEqual(defaultStoredSettings())
  })

  it('preserves only an explicit pending onboarding practice choice', () => {
    expect(normalizeStoredSettings({ onboardingPracticePending: true }).onboardingPracticePending).toBe(true)
    expect(normalizeStoredSettings({ onboardingPracticePending: 'true' }).onboardingPracticePending).toBe(false)
  })

  it.each([0, 1, 2, 4, SETTINGS_SCHEMA_VERSION])(
    'preserves an explicit false OCR preference from settings schema %s',
    (settingsVersion) => {
      const normalized = normalizeStoredSettings({ settingsVersion, ocrEnabled: false })
      expect(normalized.settingsVersion).toBe(SETTINGS_SCHEMA_VERSION)
      expect(normalized.ocrEnabled).toBe(false)
      expect(normalizeStoredSettings(JSON.parse(JSON.stringify(normalized))).ocrEnabled).toBe(false)
    },
  )

  it('returns fresh default arrays and policy objects instead of shared mutable state', () => {
    const first = defaultStoredSettings()
    first.excludedApps.push('mutated')
    first.historyPolicy.maxRecords = 1

    const second = defaultStoredSettings()
    expect(second.excludedApps).toEqual(['1Password', 'Bitwarden'])
    expect(second.historyPolicy).toEqual(DEFAULT_HISTORY_POLICY)
  })

  it('normalizes existing settings and rejects unsafe capacity values', () => {
    const normalized = normalizeStoredSettings({
      settingsVersion: 4,
      theme: 'dark',
      locale: 'en-US',
      historyPolicy: { maxRecords: 10_000, maxImageBytes: 512, retentionDays: null },
      launchAtStartup: true,
      hideDuringSharing: true,
      elevatedPasteEnabled: false,
      capturePaused: true,
      excludedApps: [' Word ', 'word', '', 42, 'KeePass'],
      globalShortcut: 'Ctrl+Alt+K',
      onboardingCompleted: true,
      quickPanelPinned: true,
      autoCheckUpdates: false,
      ocrEnabled: false,
    })

    expect(normalized).toMatchObject({
      settingsVersion: SETTINGS_SCHEMA_VERSION,
      theme: 'dark',
      locale: 'en-US',
      retentionDays: 'forever',
      historyPolicy: { maxRecords: 10_000, maxImageBytes: 512, retentionDays: null },
      excludedApps: ['Word', 'KeePass'],
      ocrEnabled: false,
    })
    expect(retentionPeriodForPolicy(normalized.historyPolicy)).toBe('forever')

    const unsafe = normalizeStoredSettings({
      historyPolicy: {
        maxRecords: Number.MAX_SAFE_INTEGER + 1,
        maxImageBytes: 512,
        retentionDays: 30,
      },
    })
    expect(unsafe.historyPolicy).toEqual(DEFAULT_HISTORY_POLICY)
    expect(unsafe.retentionDays).toBe('30')
  })

  it('keeps the old capture-protection migration while treating current booleans explicitly', () => {
    expect(normalizeStoredSettings({ settingsVersion: 1, hideDuringSharing: true }).hideDuringSharing).toBe(false)
    expect(normalizeStoredSettings({ settingsVersion: 2, hideDuringSharing: true }).hideDuringSharing).toBe(true)
    expect(normalizeStoredSettings({ settingsVersion: 4, autoCheckUpdates: false }).autoCheckUpdates).toBe(false)
  })
})
