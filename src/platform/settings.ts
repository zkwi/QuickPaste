import { normalizeStoredSettings, type StoredSettings } from '../domain/settings'
import { isTauriRuntime } from './desktop'

export type SettingsInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

async function invokeThroughTauri(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

async function invokeSetting(
  command: string,
  args: Record<string, unknown>,
  invokeAdapter?: SettingsInvoke,
): Promise<unknown> {
  if (!invokeAdapter && !isTauriRuntime()) throw new Error('not running inside Tauri')
  return (invokeAdapter ?? invokeThroughTauri)(command, args)
}

export async function getLaunchAtStartup(invokeAdapter?: SettingsInvoke): Promise<boolean | null> {
  try {
    return Boolean(await invokeSetting('get_launch_at_startup', {}, invokeAdapter))
  } catch {
    return null
  }
}

export async function setLaunchAtStartup(
  enabled: boolean,
  invokeAdapter?: SettingsInvoke,
): Promise<boolean> {
  try {
    await invokeSetting('set_launch_at_startup', { enabled }, invokeAdapter)
    return true
  } catch {
    return false
  }
}

export async function setScreenCaptureProtection(
  enabled: boolean,
  invokeAdapter?: SettingsInvoke,
): Promise<boolean> {
  try {
    await invokeSetting('set_screen_capture_protection', { enabled }, invokeAdapter)
    return true
  } catch {
    return false
  }
}

export async function setCaptureExclusions(
  apps: string[],
  invokeAdapter?: SettingsInvoke,
): Promise<boolean> {
  try {
    await invokeSetting('set_capture_exclusions', { apps }, invokeAdapter)
    return true
  } catch {
    return false
  }
}

export async function setGlobalShortcut(
  shortcut: string,
  invokeAdapter?: SettingsInvoke,
): Promise<boolean> {
  try {
    await invokeSetting('set_global_shortcut', { shortcut }, invokeAdapter)
    return true
  } catch {
    return false
  }
}

export async function setElevatedPasteEnabled(
  enabled: boolean,
  invokeAdapter?: SettingsInvoke,
): Promise<boolean> {
  try {
    await invokeSetting('set_elevated_paste_enabled', { enabled }, invokeAdapter)
    return true
  } catch {
    return false
  }
}

export async function loadPortableSettings(invokeAdapter?: SettingsInvoke): Promise<StoredSettings | null | undefined> {
  try {
    const value = await invokeSetting('load_user_settings', {}, invokeAdapter)
    if (value === null) return null
    if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeStoredSettings(value)
  } catch {
    // WebView storage remains available if the portable settings file cannot be read.
  }
}

export async function savePortableSettings(settings: StoredSettings, invokeAdapter?: SettingsInvoke): Promise<boolean> {
  try {
    await invokeSetting('save_user_settings', { settings }, invokeAdapter)
    return true
  } catch {
    return false
  }
}
