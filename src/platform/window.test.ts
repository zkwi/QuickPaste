import {
  observeWindowMaximizedState,
  runWindowAction,
  setQuickPanelPinned,
  setWindowMode,
  type DesktopWindow,
  type WindowInvoke,
} from './window'
import * as windowModule from './window'

describe('desktop window actions', () => {
  it('centers first-run UI and starts dragging through explicit native window methods', async () => {
    const center = vi.fn().mockResolvedValue(undefined)
    const startDragging = vi.fn().mockResolvedValue(undefined)
    const desktopWindow = { center, startDragging }
    const platform = windowModule as unknown as {
      centerCurrentWindow?: (resolveWindow: () => Promise<unknown>) => Promise<boolean>
      startWindowDragging?: (resolveWindow: () => Promise<unknown>) => Promise<boolean>
    }

    expect(platform.centerCurrentWindow).toEqual(expect.any(Function))
    expect(platform.startWindowDragging).toEqual(expect.any(Function))
    await expect(platform.centerCurrentWindow?.(async () => desktopWindow)).resolves.toBe(true)
    await expect(platform.startWindowDragging?.(async () => desktopWindow)).resolves.toBe(true)
    expect(center).toHaveBeenCalledOnce()
    expect(startDragging).toHaveBeenCalledOnce()
  })

  it('runs the requested action against the resolved desktop window', async () => {
    const minimize = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const hide = vi.fn().mockResolvedValue(undefined)
    const toggleMaximize = vi.fn().mockResolvedValue(undefined)
    const isMaximized = vi.fn().mockResolvedValue(false)
    const onResized = vi.fn().mockResolvedValue(() => undefined)
    const desktopWindow: DesktopWindow = { minimize, close, hide, toggleMaximize, isMaximized, onResized }

    await expect(runWindowAction('minimize', async () => desktopWindow)).resolves.toBe(true)
    await expect(runWindowAction('close', async () => desktopWindow)).resolves.toBe(true)
    await expect(runWindowAction('toggle-maximize', async () => desktopWindow)).resolves.toBe(true)
    expect(minimize).toHaveBeenCalledOnce()
    expect(hide).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    expect(toggleMaximize).toHaveBeenCalledOnce()
  })

  it('fails quietly when the page is not running inside Tauri', async () => {
    await expect(runWindowAction('close', async () => null)).resolves.toBe(false)
  })

  it('does not apply a titlebar action after its UI session became stale', async () => {
    const hide = vi.fn().mockResolvedValue(undefined)
    const desktopWindow: DesktopWindow = {
      minimize: vi.fn(),
      close: vi.fn(),
      hide,
      toggleMaximize: vi.fn(),
      isMaximized: vi.fn(),
      onResized: vi.fn(),
    }

    await expect(runWindowAction('close', async () => desktopWindow, () => false)).resolves.toBe(false)
    expect(hide).not.toHaveBeenCalled()
  })

  it('reports the initial maximized state and keeps it synchronized after native resizes', async () => {
    let maximized = false
    let resized: (() => void) | undefined
    const disconnect = vi.fn()
    const isMaximized = vi.fn(async () => maximized)
    const onResized = vi.fn(async (listener: () => void) => {
      resized = listener
      return disconnect
    })
    const desktopWindow: DesktopWindow = {
      minimize: vi.fn(),
      close: vi.fn(),
      hide: vi.fn(),
      toggleMaximize: vi.fn(),
      isMaximized,
      onResized,
    }
    const states: boolean[] = []

    const stop = await observeWindowMaximizedState((state) => states.push(state), async () => desktopWindow)
    expect(states).toEqual([false])
    expect(onResized).toHaveBeenCalledBefore(isMaximized)

    maximized = true
    resized?.()
    await vi.waitFor(() => expect(states).toEqual([false, true]))

    stop()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('asks the native shell to switch between quick and library window modes', async () => {
    const invoke: WindowInvoke = vi.fn().mockResolvedValue(undefined)

    await expect(setWindowMode('library', invoke)).resolves.toBe(true)
    await expect(setWindowMode('quick', invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenNthCalledWith(1, 'set_window_mode', { mode: 'library' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_window_mode', { mode: 'quick' })
  })

  it('tells the native shell whether the quick panel should persist on focus loss', async () => {
    const invoke: WindowInvoke = vi.fn().mockResolvedValue(undefined)

    await expect(setQuickPanelPinned(true, invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('set_quick_panel_pinned', { enabled: true })
  })
})
