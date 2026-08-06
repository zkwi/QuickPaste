import {
  DEFAULT_HISTORY_POLICY,
  SETTINGS_SCHEMA_VERSION,
  defaultStoredSettings,
  normalizeStoredSettings,
  parseStoredSettingsJson,
  retentionPeriodForPolicy,
} from './settings'

describe('stored settings normalization', () => {
  it('defaults ordinary history to the unlimited compatibility value', () => {
    const defaults = defaultStoredSettings()

    expect(defaults.settingsVersion).toBe(7)
    expect(defaults.historyPolicy).toEqual({
      maxRecords: Number.MAX_SAFE_INTEGER,
      maxImageBytes: 256 * 1024 * 1024,
      retentionDays: 30,
    })
  })

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

  it.each([0, 1, 2, 4, 6, SETTINGS_SCHEMA_VERSION])(
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

  it('normalizes legacy record limits while preserving image capacity and retention', () => {
    const normalized = normalizeStoredSettings({
      settingsVersion: 6,
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
      historyPolicy: {
        maxRecords: Number.MAX_SAFE_INTEGER,
        maxImageBytes: 512,
        retentionDays: null,
      },
      excludedApps: ['Word', 'KeePass'],
      ocrEnabled: false,
    })
    expect(retentionPeriodForPolicy(normalized.historyPolicy)).toBe('forever')

    for (const retentionDays of [7, 30, 90]) {
      expect(normalizeStoredSettings({
        settingsVersion: 7,
        historyPolicy: { maxRecords: 1, maxImageBytes: 1024, retentionDays },
      }).historyPolicy).toEqual({
        maxRecords: Number.MAX_SAFE_INTEGER,
        maxImageBytes: 1024,
        retentionDays,
      })
    }
  })

  it('rejects unsafe capacity values', () => {
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
