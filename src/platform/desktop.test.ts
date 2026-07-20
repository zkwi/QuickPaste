import {
  cancelNativeQuit,
  connectCaptureAvailability,
  connectCaptureState,
  connectNativeClipboard,
  connectPasteTarget,
  connectQuickPanelSession,
  connectQuitRequested,
  exitNativeApp,
  getNativeCaptureAvailability,
  setNativeCapturePaused,
  type NativeListen,
} from './desktop'

describe('Tauri desktop bridge', () => {
  const sourceAppIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3voZ8QAAAABJRU5ErkJggg=='

  it('forwards native clipboard events and returns the cleanup callback', async () => {
    const cleanup = vi.fn()
    const handler = vi.fn()
    const listen: NativeListen = async (eventName, callback) => {
      expect(eventName).toBe('clipboard://changed')
      callback({
        kind: 'text',
        content: '来自 Windows',
        capturedAt: '2026-07-18T08:00:00.000Z',
        sourceAppIcon,
      })
      return cleanup
    }

    const disconnect = await connectNativeClipboard(handler, listen)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      content: '来自 Windows',
      sourceAppIcon,
    }))
    expect(disconnect).not.toBeNull()
    disconnect?.()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('forwards rich text and ordered multi-file payloads without reshaping them', async () => {
    const handler = vi.fn()
    const richPayload = {
      kind: 'text' as const,
      content: '富文本',
      capturedAt: '2026-07-19T08:00:00.000Z',
      formats: ['text', 'html', 'rtf'] as const,
      html: '<b>富文本</b>',
      rtfBase64: 'e1xydGYxXGFuc2k=',
    }
    const filesPayload = {
      kind: 'file' as const,
      content: 'C:\\Fixtures\\first.txt\nC:\\Fixtures\\folder',
      capturedAt: '2026-07-19T08:01:00.000Z',
      formats: ['files'] as const,
      files: [
        { path: 'C:\\Fixtures\\first.txt', name: 'first.txt', size: 12, directory: false, exists: true },
        { path: 'C:\\Fixtures\\folder', name: 'folder', directory: true, exists: false },
      ],
    }
    const listen: NativeListen = async (_eventName, callback) => {
      callback(richPayload)
      callback(filesPayload)
      return () => undefined
    }

    await connectNativeClipboard(handler, listen)

    expect(handler).toHaveBeenNthCalledWith(1, richPayload)
    expect(handler).toHaveBeenNthCalledWith(2, filesPayload)
  })

  it('exposes a failed clipboard event subscription instead of pretending it is connected', async () => {
    const listen: NativeListen = vi.fn().mockRejectedValue(new Error('event bus unavailable'))

    await expect(connectNativeClipboard(vi.fn(), listen)).resolves.toBeNull()
  })

  it('queries and subscribes to native capture availability', async () => {
    const invoke = vi.fn().mockResolvedValue({ available: false, initialized: true })
    const handler = vi.fn()
    const listen: NativeListen<{ available: boolean; initialized: boolean }> = async (eventName, callback) => {
      expect(eventName).toBe('capture://availability-changed')
      callback({ available: true, initialized: true })
      return () => undefined
    }

    await expect(getNativeCaptureAvailability(invoke)).resolves.toEqual({ available: false, initialized: true })
    await expect(connectCaptureAvailability(handler, listen)).resolves.toEqual(expect.any(Function))
    expect(handler).toHaveBeenCalledWith({ available: true, initialized: true })
  })

  it('flushes through the quit event before requesting native exit', async () => {
    const onQuit = vi.fn()
    const listen: NativeListen<Record<string, never>> = async (eventName, callback) => {
      expect(eventName).toBe('app://quit-requested')
      callback({})
      return () => undefined
    }
    const invoke = vi.fn().mockResolvedValue(undefined)

    await connectQuitRequested(onQuit, listen)
    await exitNativeApp(invoke)

    expect(onQuit).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('exit_app', {})
  })

  it('cancels a pending native quit when history cannot be saved', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)

    await expect(cancelNativeQuit(invoke)).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith('cancel_app_quit', {})
  })

  it('sends privacy pause state through the command boundary', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)

    await expect(setNativeCapturePaused(true, invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('set_capture_paused', { paused: true })
  })

  it('forwards the real destination application shown by the global shortcut', async () => {
    const handler = vi.fn()
    const listen: NativeListen<{ sourceApp: string; sourceAppIcon?: string; elevated: boolean }> = async (eventName, callback) => {
      expect(eventName).toBe('paste-target://changed')
      callback({ sourceApp: 'Windows Terminal', sourceAppIcon, elevated: true })
      return () => undefined
    }

    await connectPasteTarget(handler, listen)
    expect(handler).toHaveBeenCalledWith({ sourceApp: 'Windows Terminal', sourceAppIcon, elevated: true })
  })

  it('keeps quick-panel invocation separate from paste-target changes', async () => {
    const handler = vi.fn()
    const listen: NativeListen<{ sessionId: number; sourceApp: string; sourceAppIcon?: string; elevated: boolean }> = async (eventName, callback) => {
      expect(eventName).toBe('quick-panel://invoked')
      callback({ sessionId: 7, sourceApp: 'Windows Terminal', sourceAppIcon, elevated: true })
      return () => undefined
    }

    await connectQuickPanelSession(handler, listen)
    expect(handler).toHaveBeenCalledWith({ sessionId: 7, sourceApp: 'Windows Terminal', sourceAppIcon, elevated: true })
  })

  it('reports a failed quick-panel session subscription', async () => {
    const listen: NativeListen<{ sessionId: number; sourceApp: string; elevated: boolean }> = vi.fn().mockRejectedValue(new Error('event bus unavailable'))

    await expect(connectQuickPanelSession(vi.fn(), listen)).resolves.toBeNull()
  })

  it('reports a failed paste-target subscription instead of pretending it is connected', async () => {
    const listen: NativeListen<{ sessionId: number; sourceApp: string; elevated: boolean }> = vi.fn().mockRejectedValue(new Error('event bus unavailable'))

    await expect(connectPasteTarget(vi.fn(), listen)).resolves.toBeNull()
  })

  it('keeps the panel capture indicator in sync with tray actions', async () => {
    const handler = vi.fn()
    const listen: NativeListen<{ paused: boolean }> = async (eventName, callback) => {
      expect(eventName).toBe('capture://state-changed')
      callback({ paused: true })
      return () => undefined
    }

    await connectCaptureState(handler, listen)
    expect(handler).toHaveBeenCalledWith(true)
  })

  it('reports a failed tray capture-state subscription', async () => {
    const listen: NativeListen<{ paused: boolean }> = vi.fn().mockRejectedValue(new Error('event bus unavailable'))

    await expect(connectCaptureState(vi.fn(), listen)).resolves.toBeNull()
  })
})
