export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'
export type WindowMode = 'quick' | 'library'
export type WindowInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

export interface DesktopWindow {
  minimize(): Promise<void>
  close(): Promise<void>
  hide(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  onResized(listener: () => void): Promise<() => void>
}

type WindowResolver = () => Promise<DesktopWindow | null>

async function resolveTauriWindow(): Promise<DesktopWindow | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null

  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

async function invokeThroughTauri(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

export async function setWindowMode(
  mode: WindowMode,
  invokeAdapter?: WindowInvoke,
): Promise<boolean> {
  if (!invokeAdapter && !('__TAURI_INTERNALS__' in window)) return false

  try {
    await (invokeAdapter ?? invokeThroughTauri)('set_window_mode', { mode })
    return true
  } catch {
    return false
  }
}

export async function setQuickPanelPinned(
  enabled: boolean,
  invokeAdapter?: WindowInvoke,
): Promise<boolean> {
  if (!invokeAdapter && !('__TAURI_INTERNALS__' in window)) return false

  try {
    await (invokeAdapter ?? invokeThroughTauri)('set_quick_panel_pinned', { enabled })
    return true
  } catch {
    return false
  }
}

export async function runWindowAction(
  action: WindowAction,
  resolveWindow: WindowResolver = resolveTauriWindow,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  try {
    const desktopWindow = await resolveWindow()
    if (!desktopWindow || !isCurrent()) return false
    if (action === 'close') await desktopWindow.hide()
    else if (action === 'toggle-maximize') await desktopWindow.toggleMaximize()
    else await desktopWindow.minimize()
    return true
  } catch {
    return false
  }
}

export async function observeWindowMaximizedState(
  listener: (maximized: boolean) => void,
  resolveWindow: WindowResolver = resolveTauriWindow,
): Promise<() => void> {
  try {
    const desktopWindow = await resolveWindow()
    if (!desktopWindow) return () => undefined

    let stopped = false
    let updateGeneration = 0
    const update = async () => {
      const generation = ++updateGeneration
      try {
        const maximized = await desktopWindow.isMaximized()
        if (!stopped && generation === updateGeneration) listener(maximized)
      } catch {
        // Resize events are advisory; keep the last confirmed state when Windows rejects a query.
      }
    }

    const disconnect = await desktopWindow.onResized(() => {
      void update()
    })
    await update()
    return () => {
      stopped = true
      updateGeneration += 1
      disconnect()
    }
  } catch {
    return () => undefined
  }
}
