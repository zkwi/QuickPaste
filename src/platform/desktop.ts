import type { CapturedClipboardPayload } from '../domain/clipboard'

export type NativeListen<T = CapturedClipboardPayload> = (
  eventName: string,
  callback: (payload: T) => void,
) => Promise<() => void>

export type NativeInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function listenThroughTauri<T>(
  eventName: string,
  callback: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(eventName, (event) => callback(event.payload))
}

export interface PasteTargetInfo {
  sourceApp: string
  sourceAppIcon?: string
  elevated: boolean
  sessionId?: number
}

export interface QuickPanelSessionInfo extends PasteTargetInfo {
  sessionId: number
}

export interface CaptureAvailability {
  available: boolean
  initialized: boolean
}

interface CaptureStatePayload {
  paused: boolean
}

export async function connectCaptureState(
  onStateChanged: (paused: boolean) => void,
  listenAdapter?: NativeListen<CaptureStatePayload>,
): Promise<(() => void) | null> {
  if (!listenAdapter && !isTauriRuntime()) return () => undefined

  try {
    return await (listenAdapter ?? listenThroughTauri<CaptureStatePayload>)(
      'capture://state-changed',
      (payload) => onStateChanged(payload.paused),
    )
  } catch {
    return null
  }
}

export async function connectPasteTarget(
  onTargetChanged: (target: PasteTargetInfo) => void,
  listenAdapter?: NativeListen<PasteTargetInfo>,
): Promise<(() => void) | null> {
  if (!listenAdapter && !isTauriRuntime()) return () => undefined

  try {
    return await (listenAdapter ?? listenThroughTauri<PasteTargetInfo>)(
      'paste-target://changed',
      onTargetChanged,
    )
  } catch {
    return null
  }
}

export async function connectQuickPanelSession(
  onInvoked: (session: QuickPanelSessionInfo) => void,
  listenAdapter?: NativeListen<QuickPanelSessionInfo>,
): Promise<(() => void) | null> {
  if (!listenAdapter && !isTauriRuntime()) return () => undefined

  try {
    return await (listenAdapter ?? listenThroughTauri<QuickPanelSessionInfo>)(
      'quick-panel://invoked',
      onInvoked,
    )
  } catch {
    return null
  }
}

export async function connectNativeClipboard(
  onCaptured: (payload: CapturedClipboardPayload) => void,
  listenAdapter?: NativeListen,
): Promise<(() => void) | null> {
  if (!listenAdapter && !isTauriRuntime()) return () => undefined

  try {
    return await (listenAdapter ?? listenThroughTauri)('clipboard://changed', onCaptured)
  } catch {
    return null
  }
}

export async function connectCaptureAvailability(
  onAvailabilityChanged: (availability: CaptureAvailability) => void,
  listenAdapter?: NativeListen<CaptureAvailability>,
): Promise<(() => void) | null> {
  if (!listenAdapter && !isTauriRuntime()) return () => undefined

  try {
    return await (listenAdapter ?? listenThroughTauri<CaptureAvailability>)(
      'capture://availability-changed',
      onAvailabilityChanged,
    )
  } catch {
    return null
  }
}

export async function connectQuitRequested(
  onQuitRequested: () => void,
  listenAdapter?: NativeListen<Record<string, never>>,
): Promise<(() => void) | null> {
  if (!listenAdapter && !isTauriRuntime()) return () => undefined

  try {
    return await (listenAdapter ?? listenThroughTauri<Record<string, never>>)(
      'app://quit-requested',
      onQuitRequested,
    )
  } catch {
    return null
  }
}

async function invokeThroughTauri(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

export async function getNativeCaptureAvailability(
  invokeAdapter?: NativeInvoke,
): Promise<CaptureAvailability | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null

  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('get_capture_availability', {})
    if (!result || typeof result !== 'object') return null
    const available = (result as Record<string, unknown>).available
    const initialized = (result as Record<string, unknown>).initialized
    return typeof available === 'boolean' && typeof initialized === 'boolean'
      ? { available, initialized }
      : null
  } catch {
    return null
  }
}

export async function exitNativeApp(invokeAdapter?: NativeInvoke): Promise<boolean> {
  if (!invokeAdapter && !isTauriRuntime()) return false

  try {
    await (invokeAdapter ?? invokeThroughTauri)('exit_app', {})
    return true
  } catch {
    return false
  }
}

export async function cancelNativeQuit(invokeAdapter?: NativeInvoke): Promise<boolean> {
  if (!invokeAdapter && !isTauriRuntime()) return false

  try {
    await (invokeAdapter ?? invokeThroughTauri)('cancel_app_quit', {})
    return true
  } catch {
    return false
  }
}

export async function setNativeCapturePaused(
  paused: boolean,
  invokeAdapter?: NativeInvoke,
): Promise<boolean> {
  if (!invokeAdapter && !isTauriRuntime()) return false

  try {
    await (invokeAdapter ?? invokeThroughTauri)('set_capture_paused', { paused })
    return true
  } catch {
    return false
  }
}
