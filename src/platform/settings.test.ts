import {
  getLaunchAtStartup,
  setCaptureExclusions,
  setElevatedPasteEnabled,
  setGlobalShortcut,
  setLaunchAtStartup,
  setScreenCaptureProtection,
  type SettingsInvoke,
} from './settings'

describe('native settings bridge', () => {
  it('reads and updates Windows launch-at-login state', async () => {
    const invoke: SettingsInvoke = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(undefined)

    await expect(getLaunchAtStartup(invoke)).resolves.toBe(true)
    await expect(setLaunchAtStartup(false, invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenNthCalledWith(1, 'get_launch_at_startup', {})
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_launch_at_startup', { enabled: false })
  })

  it('preserves the stored launch preference when the native getter fails', async () => {
    const invoke: SettingsInvoke = vi.fn().mockRejectedValue(new Error('registry unavailable'))

    await expect(getLaunchAtStartup(invoke)).resolves.toBeNull()
  })

  it('applies screen-capture protection and sensitive-app exclusions', async () => {
    const invoke: SettingsInvoke = vi.fn().mockResolvedValue(undefined)

    await expect(setScreenCaptureProtection(false, invoke)).resolves.toBe(true)
    await expect(setScreenCaptureProtection(true, invoke)).resolves.toBe(true)
    await expect(setCaptureExclusions(['1Password', 'Bitwarden'], invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenNthCalledWith(1, 'set_screen_capture_protection', { enabled: false })
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_screen_capture_protection', { enabled: true })
    expect(invoke).toHaveBeenNthCalledWith(3, 'set_capture_exclusions', { apps: ['1Password', 'Bitwarden'] })
  })

  it('registers a user-selected global shortcut through the native boundary', async () => {
    const invoke: SettingsInvoke = vi.fn().mockResolvedValue(undefined)

    await expect(setGlobalShortcut('Ctrl+Alt+K', invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('set_global_shortcut', { shortcut: 'Ctrl+Alt+K' })
  })

  it('configures the opt-in elevated paste helper', async () => {
    const invoke: SettingsInvoke = vi.fn().mockResolvedValue(undefined)

    await expect(setElevatedPasteEnabled(true, invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('set_elevated_paste_enabled', { enabled: true })
  })
})
