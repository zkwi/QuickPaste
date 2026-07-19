import { flushPromises, mount } from '@vue/test-utils'
import App from './App.vue'

const settingsMocks = vi.hoisted(() => ({
  getLaunchAtStartup: vi.fn(),
  setCaptureExclusions: vi.fn(),
  setElevatedPasteEnabled: vi.fn(),
  setGlobalShortcut: vi.fn(),
  setLaunchAtStartup: vi.fn(),
  setScreenCaptureProtection: vi.fn(),
}))

const desktopMocks = vi.hoisted(() => ({
  cancelNativeQuit: vi.fn(),
  connectCaptureAvailability: vi.fn(),
  connectNativeClipboard: vi.fn(),
  connectQuitRequested: vi.fn(),
  connectQuickPanelSession: vi.fn(),
  exitNativeApp: vi.fn(),
  getNativeCaptureAvailability: vi.fn(),
  connectPasteTarget: vi.fn(),
  setNativeCapturePaused: vi.fn(),
}))

const windowMocks = vi.hoisted(() => ({
  observeWindowMaximizedState: vi.fn().mockResolvedValue(() => undefined),
  runWindowAction: vi.fn().mockResolvedValue(true),
  setQuickPanelPinned: vi.fn().mockResolvedValue(true),
  setWindowMode: vi.fn().mockResolvedValue(true),
}))

const historyMocks = vi.hoisted(() => ({
  loadNativeHistory: vi.fn(),
  saveNativeHistory: vi.fn(),
}))

const clipboardMocks = vi.hoisted(() => ({
  copyImage: vi.fn().mockResolvedValue(true),
  copyText: vi.fn().mockResolvedValue(true),
  pasteImage: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteText: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
}))

const updaterMocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  connectUpdateCheckRequested: vi.fn(),
  downloadUpdate: vi.fn(),
  getCurrentVersion: vi.fn(),
  installDownloadedUpdate: vi.fn(),
}))

vi.mock('./platform/settings', () => settingsMocks)
vi.mock('./platform/desktop', () => ({
  cancelNativeQuit: desktopMocks.cancelNativeQuit,
  connectCaptureAvailability: desktopMocks.connectCaptureAvailability,
  connectCaptureState: vi.fn().mockResolvedValue(() => undefined),
    connectNativeClipboard: desktopMocks.connectNativeClipboard,
    connectPasteTarget: desktopMocks.connectPasteTarget,
    connectQuitRequested: desktopMocks.connectQuitRequested,
    connectQuickPanelSession: desktopMocks.connectQuickPanelSession,
  exitNativeApp: desktopMocks.exitNativeApp,
  getNativeCaptureAvailability: desktopMocks.getNativeCaptureAvailability,
  isTauriRuntime: () => true,
  setNativeCapturePaused: desktopMocks.setNativeCapturePaused,
}))
vi.mock('./platform/history', async (importOriginal) => ({
  ...await importOriginal<typeof import('./platform/history')>(),
  ...historyMocks,
}))
vi.mock('./platform/clipboard', () => clipboardMocks)
vi.mock('./platform/window', () => windowMocks)
vi.mock('./platform/updater', () => updaterMocks)

describe('native setting reliability', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({ onboardingCompleted: true }))
    vi.clearAllMocks()
    settingsMocks.getLaunchAtStartup.mockResolvedValue(false)
    settingsMocks.setCaptureExclusions.mockResolvedValue(true)
    settingsMocks.setElevatedPasteEnabled.mockResolvedValue(true)
    settingsMocks.setGlobalShortcut.mockResolvedValue(true)
    settingsMocks.setLaunchAtStartup.mockResolvedValue(true)
    settingsMocks.setScreenCaptureProtection.mockResolvedValue(true)
    desktopMocks.setNativeCapturePaused.mockResolvedValue(true)
    desktopMocks.cancelNativeQuit.mockResolvedValue(true)
    desktopMocks.connectCaptureAvailability.mockResolvedValue(() => undefined)
    desktopMocks.connectNativeClipboard.mockResolvedValue(() => undefined)
    desktopMocks.connectPasteTarget.mockResolvedValue(() => undefined)
    desktopMocks.connectQuitRequested.mockResolvedValue(() => undefined)
    desktopMocks.connectQuickPanelSession.mockResolvedValue(() => undefined)
    desktopMocks.exitNativeApp.mockResolvedValue(true)
    desktopMocks.getNativeCaptureAvailability.mockResolvedValue({ available: true, initialized: true })
    windowMocks.setQuickPanelPinned.mockReset().mockResolvedValue(true)
    windowMocks.observeWindowMaximizedState.mockReset().mockResolvedValue(() => undefined)
    windowMocks.runWindowAction.mockReset().mockResolvedValue(true)
    windowMocks.setWindowMode.mockReset().mockResolvedValue(true)
    historyMocks.loadNativeHistory.mockReset().mockResolvedValue([])
    historyMocks.saveNativeHistory.mockReset().mockResolvedValue(true)
    clipboardMocks.pasteImage.mockReset().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })
    clipboardMocks.pasteText.mockReset().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })
    updaterMocks.checkForUpdate.mockReset().mockResolvedValue(null)
    updaterMocks.connectUpdateCheckRequested.mockReset().mockResolvedValue(() => undefined)
    updaterMocks.downloadUpdate.mockReset().mockResolvedValue(null)
    updaterMocks.getCurrentVersion.mockReset().mockResolvedValue('0.1.0')
    updaterMocks.installDownloadedUpdate.mockReset().mockResolvedValue(null)
  })

  it('shows a compact update status and installs only after a user check', async () => {
    updaterMocks.checkForUpdate.mockResolvedValueOnce({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      prerelease: true,
      releaseName: 'QuickPaste 0.2.0',
      releaseNotes: '交互优化',
      releaseUrl: 'https://github.com/zkwi/QuickPaste/releases/tag/v0.2.0',
      publishedAt: '2026-07-19T08:00:00Z',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
      assetSize: 12_582_912,
      automaticInstallAvailable: true,
    })
    updaterMocks.downloadUpdate.mockImplementationOnce(async (_version, onProgress) => {
      onProgress({ phase: 'downloading', downloadedBytes: 6_291_456, totalBytes: 12_582_912, percent: 50 })
      return { token: 'prepared-token', version: '0.2.0', assetName: 'QuickPaste_0.2.0_x64-setup.exe' }
    })
    updaterMocks.installDownloadedUpdate.mockResolvedValueOnce({
      version: '0.2.0',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
    })

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect(wrapper.get('[data-testid="current-version"]').text()).toContain('0.1.0')
    await wrapper.get('[data-testid="check-update"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="update-status"]').text()).toContain('0.2.0')

    await wrapper.get('[data-testid="install-update"]').trigger('click')
    await flushPromises()
    expect(updaterMocks.downloadUpdate).toHaveBeenCalledWith('0.2.0', expect.any(Function))
    expect(updaterMocks.installDownloadedUpdate).toHaveBeenCalledWith('prepared-token')
  })

  it('downloads first and refuses to launch the installer when the latest history cannot be saved', async () => {
    vi.useFakeTimers()
    updaterMocks.checkForUpdate.mockResolvedValueOnce({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      prerelease: true,
      releaseName: 'QuickPaste 0.2.0',
      releaseNotes: '交互优化',
      releaseUrl: 'https://github.com/zkwi/QuickPaste/releases/tag/v0.2.0',
      publishedAt: '2026-07-19T08:00:00Z',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
      assetSize: 12_582_912,
      automaticInstallAvailable: true,
    })
    updaterMocks.downloadUpdate.mockResolvedValueOnce({
      token: 'prepared-token',
      version: '0.2.0',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
    })
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'clip-before-update',
      kind: 'text',
      title: '更新前待保存',
      content: '更新前待保存',
      sourceApp: 'Notepad',
      copiedAt: '2026-07-19T08:00:00Z',
      pinned: false,
      searchTerms: [],
    }])

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="pin-clip-clip-before-update"]').trigger('click')
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="check-update"]').trigger('click')
    await flushPromises()

    historyMocks.saveNativeHistory.mockClear()
    historyMocks.saveNativeHistory.mockResolvedValue(false)
    await wrapper.get('[data-testid="install-update"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(updaterMocks.downloadUpdate).toHaveBeenCalledOnce()
    expect(historyMocks.saveNativeHistory).toHaveBeenCalled()
    expect(updaterMocks.installDownloadedUpdate).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="update-status"]').text()).toContain('历史仍未保存')
  })

  it.each([
    ['launch-at-startup-toggle', settingsMocks.setLaunchAtStartup],
    ['capture-protection-toggle', settingsMocks.setScreenCaptureProtection],
    ['elevated-paste-toggle', settingsMocks.setElevatedPasteEnabled],
  ])('rolls back %s when Windows rejects the native change', async (testId, nativeSetter) => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const toggle = wrapper.get(`[data-testid="${testId}"]`)
    const initialValue = (toggle.element as HTMLInputElement).checked
    nativeSetter.mockClear()
    nativeSetter.mockResolvedValueOnce(false)

    await toggle.setValue(!initialValue)
    await flushPromises()

    expect((toggle.element as HTMLInputElement).checked).toBe(initialValue)
    expect(wrapper.get('[role="alert"]').text()).toContain('设置未能应用')
  })

  it('reports an initialization sync failure instead of silently showing success', async () => {
    settingsMocks.setScreenCaptureProtection.mockResolvedValueOnce(false)

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('设置未能应用')
  })

  it('keeps the window available to screenshots by default', async () => {
    mount(App)
    await flushPromises()

    expect(settingsMocks.setScreenCaptureProtection).toHaveBeenCalledWith(false)
  })

  it('restores capture protection only after the user has opted in on the current settings version', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      settingsVersion: 2,
      onboardingCompleted: true,
      hideDuringSharing: true,
    }))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect(settingsMocks.setScreenCaptureProtection).toHaveBeenCalledWith(true)
    expect((wrapper.get('[data-testid="capture-protection-toggle"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('keeps native settings read-only until Windows initialization finishes', async () => {
    let finishInitialization: ((enabled: boolean) => void) | undefined
    settingsMocks.getLaunchAtStartup.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishInitialization = resolve
    }))
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    expect(wrapper.get('.settings-content').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-testid="launch-at-startup-toggle"]').attributes()).toHaveProperty('disabled')

    finishInitialization?.(false)
    await flushPromises()

    expect(wrapper.get('.settings-content').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('[data-testid="launch-at-startup-toggle"]').attributes()).not.toHaveProperty('disabled')
  })

  it('keeps shortcut recording disabled until initial native registration settles', async () => {
    let finishShortcutRegistration: ((applied: boolean) => void) | undefined
    settingsMocks.setGlobalShortcut.mockImplementationOnce(() => new Promise((resolve) => {
      finishShortcutRegistration = resolve
    }))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const recorder = wrapper.get('[data-testid="shortcut-recorder"]')

    expect(recorder.attributes('disabled')).toBeDefined()

    finishShortcutRegistration?.(true)
    await flushPromises()
    expect(recorder.attributes('disabled')).toBeUndefined()
  })

  it('restores the persisted quick-panel pin state in the native window layer', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      quickPanelPinned: true,
    }))

    const wrapper = mount(App)
    await flushPromises()

    expect(windowMocks.setQuickPanelPinned).toHaveBeenCalledWith(true)
    expect(wrapper.get('[data-testid="pin-quick-panel"]').attributes('aria-pressed')).toBe('true')
  })

  it('serializes rapid quick-panel pin changes', async () => {
    const wrapper = mount(App)
    await flushPromises()
    windowMocks.setQuickPanelPinned.mockClear()
    let finishPinChange: ((applied: boolean) => void) | undefined
    windowMocks.setQuickPanelPinned.mockImplementationOnce(() => new Promise((resolve) => {
      finishPinChange = resolve
    }))
    const pin = wrapper.get('[data-testid="pin-quick-panel"]')

    await pin.trigger('click')
    await pin.trigger('click')

    expect(windowMocks.setQuickPanelPinned).toHaveBeenCalledTimes(1)
    expect(pin.attributes('disabled')).toBeDefined()

    finishPinChange?.(true)
    await flushPromises()
    expect(pin.attributes('disabled')).toBeUndefined()
  })

  it('keeps the current view when Windows rejects a window-mode transition', async () => {
    const wrapper = mount(App)
    await flushPromises()
    windowMocks.setWindowMode.mockResolvedValueOnce(false)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain('窗口布局')
  })

  it('rolls failed initialization settings back to known native defaults', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      capturePaused: true,
      hideDuringSharing: false,
      elevatedPasteEnabled: false,
      excludedApps: ['KeePassXC'],
    }))
    desktopMocks.setNativeCapturePaused.mockResolvedValue(false)
    settingsMocks.setScreenCaptureProtection.mockResolvedValue(false)
    settingsMocks.setElevatedPasteEnabled.mockResolvedValue(false)
    settingsMocks.setCaptureExclusions.mockResolvedValue(false)

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect((wrapper.get('[data-testid="capture-protection-toggle"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.get('[data-testid="elevated-paste-toggle"]').element as HTMLInputElement).checked).toBe(true)
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    expect(wrapper.findAll('.sensitive-app-row')).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      capturePaused: false,
      hideDuringSharing: false,
      elevatedPasteEnabled: true,
      excludedApps: [],
    })
  })

  it('uses an empty native database as truth without rewriting unchanged history', async () => {
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'stale-local-item',
      kind: 'text',
      title: '不应恢复',
      content: 'stale',
      sourceApp: 'Notepad',
      copiedAt: '2026-07-18T09:00:00.000Z',
      pinned: false,
      searchTerms: [],
    }]))

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).not.toContain('不应恢复')
    expect(historyMocks.saveNativeHistory).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="empty-history"]').text()).toContain('复制任意内容')
    expect(wrapper.find('[data-testid="no-results"]').exists()).toBe(false)
  })

  it('shows loading separately from an empty clipboard history', async () => {
    historyMocks.loadNativeHistory.mockImplementationOnce(() => new Promise(() => undefined))

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.get('[data-testid="history-loading"]').text()).toContain('正在读取')
    expect(wrapper.find('[data-testid="no-results"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('buffers clipboard captures that arrive while native history is still loading', async () => {
    let capture: ((payload: {
      kind: 'text'
      content: string
      capturedAt: string
      sourceApp?: string
    }) => void) | undefined
    let finishHistoryLoad: ((items: Array<Record<string, unknown>>) => void) | undefined
    desktopMocks.connectNativeClipboard.mockImplementation(async (callback) => {
      capture = callback
      return () => undefined
    })
    historyMocks.loadNativeHistory.mockImplementationOnce(() => new Promise((resolve) => {
      finishHistoryLoad = resolve
    }))

    const wrapper = mount(App)
    await flushPromises()
    expect(capture).toBeTypeOf('function')

    capture?.({
      kind: 'text',
      content: '冷启动期间复制的内容',
      capturedAt: '2026-07-18T10:01:00.000Z',
      sourceApp: 'Notepad',
    })
    finishHistoryLoad?.([{
      id: 'persisted-before-startup',
      kind: 'text',
      title: '已保存内容',
      content: '历史库中的内容',
      sourceApp: 'Notepad',
      copiedAt: '2026-07-18T10:00:00.000Z',
      pinned: false,
      searchTerms: [],
    }])
    await flushPromises()

    expect(wrapper.text()).toContain('冷启动期间复制的内容')
    expect(wrapper.text()).toContain('已保存内容')
  })

  it('keeps retention read-only while native history loading is unresolved', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      retentionDays: 'forever',
    }))
    historyMocks.loadNativeHistory.mockImplementation(() => new Promise(() => undefined))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const retention = wrapper.get('[data-testid="retention-select"]')

    expect(retention.attributes()).toHaveProperty('disabled')
    expect(retention.attributes('aria-describedby')).toBe('retention-description')
    expect(wrapper.get('#retention-description').text()).toContain('历史仍在加载')
    ;(retention.element as HTMLSelectElement).value = '7'
    await retention.trigger('change')
    await wrapper.vm.$nextTick()

    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').retentionDays).toBe('forever')
    expect(wrapper.find('[data-testid="retention-change-dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps native history read-only after bounded loading retries fail', async () => {
    vi.useFakeTimers()
    let capture: ((payload: {
      kind: 'text'
      content: string
      capturedAt: string
      sourceApp?: string
    }) => void) | undefined
    desktopMocks.connectNativeClipboard.mockImplementation(async (callback) => {
      capture = callback
      return () => undefined
    })
    historyMocks.loadNativeHistory.mockResolvedValue(null)

    const wrapper = mount(App)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    capture?.({
      kind: 'text',
      content: '加载失败后复制的新内容',
      capturedAt: '2026-07-18T10:00:00.000Z',
      sourceApp: 'Notepad',
    })
    await flushPromises()

    expect(historyMocks.loadNativeHistory).toHaveBeenCalledTimes(3)
    expect(historyMocks.saveNativeHistory).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="history-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="history-error"]').text()).toContain('为保护现有数据，本次运行不会写入历史')
  })

  it('keeps retention read-only after native history loading fails', async () => {
    vi.useFakeTimers()
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      retentionDays: 'forever',
    }))
    historyMocks.loadNativeHistory.mockResolvedValue(null)

    const wrapper = mount(App)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const retention = wrapper.get('[data-testid="retention-select"]')

    expect(retention.attributes()).toHaveProperty('disabled')
    expect(wrapper.get('#retention-description').text()).toContain('历史读取失败')
    ;(retention.element as HTMLSelectElement).value = '7'
    await retention.trigger('change')
    await wrapper.vm.$nextTick()

    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').retentionDays).toBe('forever')
    expect(wrapper.find('[data-testid="retention-change-dialog"]').exists()).toBe(false)
  })

  it('times out a hung history load and lets the user recover in place', async () => {
    vi.useFakeTimers()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      historyMocks.loadNativeHistory.mockImplementationOnce(() => new Promise(() => undefined))
    }
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'recovered', kind: 'text', title: '已恢复历史', content: 'recovered', sourceApp: 'Notepad',
      copiedAt: new Date().toISOString(), pinned: false, searchTerms: [], color: '#337C74',
    }])

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()

    expect(historyMocks.loadNativeHistory).toHaveBeenCalledTimes(3)
    expect(wrapper.get('[data-testid="history-error"]').text()).toContain('暂时无法读取历史')
    expect(wrapper.get('[data-testid="history-retry"]').text()).toContain('重新加载')

    const retry = wrapper.get('[data-testid="history-retry"]')
    ;(retry.element as HTMLElement).focus()
    await retry.trigger('click')
    await flushPromises()

    expect(historyMocks.loadNativeHistory).toHaveBeenCalledTimes(4)
    expect(wrapper.text()).toContain('已恢复历史')
    expect(wrapper.find('[data-testid="history-error"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="search-input"]').element)
    wrapper.unmount()
  })

  it('starts every global quick-panel invocation with a clean transient session', async () => {
    let targetChanged: ((target: { sourceApp: string; elevated: boolean }) => void) | undefined
    let quickPanelInvoked: (() => void) | undefined
    desktopMocks.connectPasteTarget.mockImplementation(async (callback) => {
      targetChanged = callback
      return () => undefined
    })
    desktopMocks.connectQuickPanelSession.mockImplementation(async (callback) => {
      quickPanelInvoked = callback
      return () => undefined
    })
    historyMocks.loadNativeHistory.mockResolvedValueOnce([
      {
        id: 'first', kind: 'text', title: '第一条', content: 'first', sourceApp: 'Notepad',
        copiedAt: '2026-07-18T10:00:00.000Z', pinned: false, searchTerms: [],
      },
      {
        id: 'second', kind: 'image', title: '第二条图片', content: 'second', sourceApp: 'Snipping Tool',
        copiedAt: '2026-07-18T09:00:00.000Z', pinned: false, searchTerms: [], imageUrl: 'data:image/png;base64,AA==',
      },
    ])
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="filter-image"]').trigger('click')
    await wrapper.get('[data-testid="search-input"]').setValue('second')
    const list = wrapper.get('.clip-list').element as HTMLElement
    list.scrollTop = 120

    targetChanged?.({ sourceApp: 'WeChat', elevated: false })
    await wrapper.vm.$nextTick()

    expect((wrapper.get('[data-testid="search-input"]').element as HTMLInputElement).value).toBe('second')
    expect(wrapper.get('[data-testid="filter-image"]').attributes('aria-pressed')).toBe('true')

    quickPanelInvoked?.()
    await wrapper.vm.$nextTick()

    expect((wrapper.get('[data-testid="search-input"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="filter-all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-clip-id="first"]').classes()).toContain('is-selected')
    expect((wrapper.get('.clip-list').element as HTMLElement).scrollTop).toBe(0)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="search-input"]').element)
    wrapper.unmount()
  })

  it('subscribes to new quick-panel sessions before a slow history load finishes', async () => {
    let quickPanelInvoked: (() => void) | undefined
    historyMocks.loadNativeHistory.mockImplementation(() => new Promise(() => undefined))
    desktopMocks.connectQuickPanelSession.mockImplementation(async (callback) => {
      quickPanelInvoked = callback
      return () => undefined
    })

    const wrapper = mount(App)
    await flushPromises()

    expect(desktopMocks.connectQuickPanelSession).toHaveBeenCalledOnce()
    expect(quickPanelInvoked).toEqual(expect.any(Function))
    wrapper.unmount()
  })

  it('retries transient lifecycle subscription failures', async () => {
    desktopMocks.connectQuickPanelSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(() => undefined)
    desktopMocks.connectPasteTarget
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(() => undefined)

    const wrapper = mount(App)
    await flushPromises()

    expect(desktopMocks.connectQuickPanelSession).toHaveBeenCalledTimes(2)
    expect(desktopMocks.connectPasteTarget).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.feedback-toast').exists()).toBe(false)
  })

  it('updates the paste target atomically with a session and expires a stale label', async () => {
    vi.useFakeTimers()
    const sourceAppIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3voZ8QAAAABJRU5ErkJggg=='
    let quickPanelInvoked: ((session: { sessionId: number; sourceApp: string; sourceAppIcon?: string; elevated: boolean }) => void) | undefined
    desktopMocks.connectQuickPanelSession.mockImplementation(async (callback) => {
      quickPanelInvoked = callback
      return () => undefined
    })

    const wrapper = mount(App)
    await flushPromises()
    quickPanelInvoked?.({ sessionId: 4, sourceApp: 'WeChat', sourceAppIcon, elevated: true })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="paste-target"]').text()).toContain('WeChat')
    expect(wrapper.get('[data-testid="paste-target"]').text()).toContain('管理员')
    expect(wrapper.get('[data-testid="paste-target"] .source-app-icon img').attributes('src')).toBe(sourceAppIcon)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="paste-target"]').text()).toContain('当前应用')
    expect(wrapper.get('[data-testid="paste-target"]').text()).not.toContain('WeChat')
    expect(wrapper.find('[data-testid="paste-target"] .source-app-icon img').exists()).toBe(false)
  })

  it('expires a future paste target even when the matching quick-panel event is lost', async () => {
    vi.useFakeTimers()
    let pasteTargetChanged: ((target: {
      sessionId: number
      sourceApp: string
      sourceAppIcon?: string
      elevated: boolean
    }) => void) | undefined
    desktopMocks.connectQuickPanelSession.mockResolvedValue(null)
    desktopMocks.connectPasteTarget.mockImplementation(async (callback) => {
      pasteTargetChanged = callback
      return () => undefined
    })

    const wrapper = mount(App)
    await flushPromises()
    pasteTargetChanged?.({
      sessionId: 11,
      sourceApp: 'Windows Terminal',
      sourceAppIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3voZ8QAAAABJRU5ErkJggg==',
      elevated: true,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="paste-target"]').text()).toContain('Windows Terminal')

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="paste-target"]').text()).toContain('当前应用')
    expect(wrapper.find('[data-testid="paste-target"] .source-app-icon img').exists()).toBe(false)
  })

  it('does not let an older manager transition overwrite a newer quick-panel invocation', async () => {
    let quickPanelInvoked: (() => void) | undefined
    let finishManagerTransition: ((applied: boolean) => void) | undefined
    desktopMocks.connectQuickPanelSession.mockImplementation(async (callback) => {
      quickPanelInvoked = callback
      return () => undefined
    })
    windowMocks.setWindowMode.mockImplementationOnce(() => new Promise((resolve) => {
      finishManagerTransition = resolve
    }))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(true)

    quickPanelInvoked?.()
    await wrapper.vm.$nextTick()
    finishManagerTransition?.(false)
    await flushPromises()

    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(false)
    expect(wrapper.find('.feedback-toast').exists()).toBe(false)
  })

  it('blocks titlebar actions until the native window-mode transition has settled', async () => {
    let finishModeChange: ((completed: boolean) => void) | undefined
    windowMocks.setWindowMode.mockImplementationOnce(() => new Promise((resolve) => {
      finishModeChange = resolve
    }))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.vm.$nextTick()
    const maximize = wrapper.get('[data-testid="window-toggle-maximize"]')

    expect(maximize.attributes('disabled')).toBeDefined()
    await maximize.trigger('click')
    expect(windowMocks.runWindowAction).not.toHaveBeenCalled()

    finishModeChange?.(true)
    await flushPromises()
    expect(maximize.attributes('disabled')).toBeUndefined()
  })

  it('keeps the manager shell and restore control synchronized with the native maximized state', async () => {
    let reportMaximized: ((maximized: boolean) => void) | undefined
    windowMocks.observeWindowMaximizedState.mockImplementationOnce(async (listener) => {
      reportMaximized = listener
      listener(false)
      return () => undefined
    })

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="window-toggle-maximize"]').attributes('aria-label')).toBe('最大化窗口')
    expect(wrapper.get('.app-stage').classes()).not.toContain('is-window-maximized')

    reportMaximized?.(true)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="window-toggle-maximize"]').attributes('aria-label')).toBe('还原窗口')
    expect(wrapper.get('.app-stage').classes()).toContain('is-window-maximized')
  })

  it('keeps paste fallback feedback bound to the target captured before the native call', async () => {
    let targetChanged: ((target: { sourceApp: string; elevated: boolean }) => void) | undefined
    let finishPaste: ((result: { copied: boolean; pasted: boolean; requiresElevation: boolean }) => void) | undefined
    desktopMocks.connectPasteTarget.mockImplementation(async (callback) => {
      targetChanged = callback
      return () => undefined
    })
    clipboardMocks.pasteText.mockImplementationOnce(() => new Promise((resolve) => {
      finishPaste = resolve
    }))
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'target-race', kind: 'text', title: '目标竞态', content: 'target race', sourceApp: 'Notepad',
      copiedAt: new Date().toISOString(), pinned: false, searchTerms: [],
    }])

    const wrapper = mount(App)
    await flushPromises()
    targetChanged?.({ sourceApp: 'WeChat', elevated: false })
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-clip-id="target-race"] .clip-primary').trigger('dblclick')
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledWith('target race')

    targetChanged?.({ sourceApp: '', elevated: false })
    finishPaste?.({ copied: true, pasted: false, requiresElevation: false })
    await flushPromises()

    expect(wrapper.get('.feedback-toast').text()).toContain('WeChat')
  })

  it('does not leak feedback from an earlier paste into a newly invoked quick session', async () => {
    let quickPanelInvoked: (() => void) | undefined
    let finishPaste: ((result: { copied: boolean; pasted: boolean; requiresElevation: boolean }) => void) | undefined
    desktopMocks.connectQuickPanelSession.mockImplementation(async (callback) => {
      quickPanelInvoked = callback
      return () => undefined
    })
    clipboardMocks.pasteText.mockImplementationOnce(() => new Promise((resolve) => {
      finishPaste = resolve
    }))
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'old-session-paste', kind: 'text', title: '旧会话粘贴', content: 'old session', sourceApp: 'Notepad',
      copiedAt: new Date().toISOString(), pinned: false, searchTerms: [],
    }])

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-clip-id="old-session-paste"] .clip-primary').trigger('dblclick')
    await flushPromises()

    quickPanelInvoked?.()
    await wrapper.get('[data-clip-id="old-session-paste"] .clip-primary').trigger('dblclick')
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledTimes(1)

    finishPaste?.({ copied: true, pasted: false, requiresElevation: false })
    await flushPromises()

    expect(wrapper.find('.feedback-toast').exists()).toBe(false)

    await wrapper.get('[data-clip-id="old-session-paste"] .clip-primary').trigger('dblclick')
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledTimes(2)
  })

  it('does not leak copy feedback from the manager into a newly invoked quick session', async () => {
    let quickPanelInvoked: (() => void) | undefined
    let finishCopy: ((copied: boolean) => void) | undefined
    desktopMocks.connectQuickPanelSession.mockImplementation(async (callback) => {
      quickPanelInvoked = callback
      return () => undefined
    })
    clipboardMocks.copyText.mockImplementationOnce(() => new Promise((resolve) => {
      finishCopy = resolve
    }))
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'old-session-copy', kind: 'text', title: '旧会话复制', content: 'old copy', sourceApp: 'Notepad',
      copiedAt: new Date().toISOString(), pinned: false, searchTerms: [],
    }])

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-copy-old-session-copy"]').trigger('click')
    await flushPromises()

    quickPanelInvoked?.()
    finishCopy?.(true)
    await flushPromises()

    expect(wrapper.find('.feedback-toast').exists()).toBe(false)
  })

  it('serializes rapid native setting changes so the latest choice wins', async () => {
    let finishFirst: ((result: boolean) => void) | undefined
    settingsMocks.setLaunchAtStartup.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishFirst = resolve
    }))
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const toggle = wrapper.get('[data-testid="launch-at-startup-toggle"]')
    settingsMocks.setLaunchAtStartup.mockClear()

    await toggle.setValue(true)
    await toggle.setValue(false)
    await flushPromises()

    expect(settingsMocks.setLaunchAtStartup).toHaveBeenCalledTimes(1)
    finishFirst?.(true)
    await flushPromises()

    expect(settingsMocks.setLaunchAtStartup.mock.calls).toEqual([[true], [false]])
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
  })

  it('preserves the stored launch preference when initialization cannot read Windows state', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      launchAtStartup: true,
    }))
    settingsMocks.getLaunchAtStartup.mockResolvedValueOnce(null)

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect((wrapper.get('[data-testid="launch-at-startup-toggle"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('does not display an unregistered default shortcut when both registrations fail', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      globalShortcut: 'Ctrl+Alt+K',
    }))
    settingsMocks.setGlobalShortcut.mockResolvedValue(false)

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect(settingsMocks.setGlobalShortcut.mock.calls).toEqual([
      ['Ctrl+Alt+K'],
      ['Ctrl+Shift+V'],
    ])
    expect(wrapper.get('[data-testid="shortcut-recorder"]').text()).toContain('Ctrl + Alt + K')
    expect(wrapper.get('[data-testid="shortcut-recorder"]').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('[data-testid="shortcut-status"]').text()).toContain('当前快捷键未启用')
    expect(wrapper.get('[role="alert"]').text()).toContain('组合键不可用')
  })

  it('rolls back excluded apps when native synchronization fails', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    settingsMocks.setCaptureExclusions.mockClear()
    settingsMocks.setCaptureExclusions.mockResolvedValueOnce(false)

    const initialRows = wrapper.findAll('.sensitive-app-row').length
    await wrapper.get('.sensitive-app-row button').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.sensitive-app-row')).toHaveLength(initialRows)
    expect(wrapper.get('[role="alert"]').text()).toContain('设置未能应用')
  })

  it('shows native capture initialization failure and disables the pause control', async () => {
    desktopMocks.getNativeCaptureAvailability.mockResolvedValueOnce({ available: false, initialized: true })

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.get('.capture-state').text()).toContain('记录不可用')
    expect(wrapper.get('[data-testid="capture-toggle"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[role="status"]').text()).toContain('无法监听系统剪贴板')
  })

  it('exposes clipboard event subscription failure even when native initialization succeeded', async () => {
    desktopMocks.connectNativeClipboard.mockResolvedValueOnce(null)

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.get('.capture-state').text()).toContain('记录不可用')
    expect(wrapper.get('[data-testid="capture-toggle"]').attributes()).toHaveProperty('disabled')
  })

  it('exposes capture-health event subscription failure', async () => {
    desktopMocks.connectCaptureAvailability.mockResolvedValueOnce(null)

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.get('.capture-state').text()).toContain('记录不可用')
    expect(wrapper.get('[data-testid="capture-toggle"]').attributes()).toHaveProperty('disabled')
  })

  it('flushes the latest history before acknowledging a tray quit request', async () => {
    let requestQuit: (() => void) | undefined
    desktopMocks.connectQuitRequested.mockImplementation(async (callback: () => void) => {
      requestQuit = callback
      return () => undefined
    })
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'clip-1',
      kind: 'text',
      title: '待固定',
      content: 'quit flush',
      sourceApp: 'Notepad',
      copiedAt: new Date().toISOString(),
      pinned: false,
      searchTerms: [],
    }])
    const wrapper = mount(App)
    await flushPromises()
    historyMocks.saveNativeHistory.mockClear()

    await wrapper.get('[data-testid="pin-clip-clip-1"]').trigger('click')
    requestQuit?.()
    await flushPromises()

    expect(historyMocks.saveNativeHistory).toHaveBeenCalled()
    expect(desktopMocks.exitNativeApp).toHaveBeenCalledOnce()
    expect(desktopMocks.cancelNativeQuit).not.toHaveBeenCalled()
  })

  it('does not acknowledge a tray quit when bounded history flush retries keep failing', async () => {
    vi.useFakeTimers()
    let requestQuit: (() => void) | undefined
    desktopMocks.connectQuitRequested.mockImplementation(async (callback: () => void) => {
      requestQuit = callback
      return () => undefined
    })
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'clip-1',
      kind: 'text',
      title: '待固定',
      content: 'quit retry failure',
      sourceApp: 'Notepad',
      copiedAt: '2026-07-18T10:00:00.000Z',
      pinned: false,
      searchTerms: [],
    }])
    const wrapper = mount(App)
    await flushPromises()
    historyMocks.saveNativeHistory.mockClear()
    historyMocks.saveNativeHistory.mockResolvedValue(false)

    await wrapper.get('[data-testid="pin-clip-clip-1"]').trigger('click')
    requestQuit?.()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(historyMocks.saveNativeHistory).toHaveBeenCalledTimes(3)
    expect(desktopMocks.exitNativeApp).not.toHaveBeenCalled()
    expect(desktopMocks.cancelNativeQuit).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="alert"]').text()).toContain('历史仍未保存')
  })

  it('stops waiting before the native quit fallback when history saving hangs', async () => {
    vi.useFakeTimers()
    let requestQuit: (() => void) | undefined
    desktopMocks.connectQuitRequested.mockImplementation(async (callback: () => void) => {
      requestQuit = callback
      return () => undefined
    })
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'clip-1',
      kind: 'text',
      title: '待固定',
      content: 'hung quit flush',
      sourceApp: 'Notepad',
      copiedAt: '2026-07-18T10:00:00.000Z',
      pinned: false,
      searchTerms: [],
    }])
    const wrapper = mount(App)
    await flushPromises()
    historyMocks.saveNativeHistory.mockClear()
    historyMocks.saveNativeHistory.mockImplementation(() => new Promise<boolean>(() => undefined))

    await wrapper.get('[data-testid="pin-clip-clip-1"]').trigger('click')
    requestQuit?.()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3_100)
    await flushPromises()

    expect(desktopMocks.exitNativeApp).not.toHaveBeenCalled()
    expect(desktopMocks.cancelNativeQuit).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="alert"]').text()).toContain('历史仍未保存')
  })
})
