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
  applyNativeHistoryBatch: vi.fn(),
  applyNativeHistoryMutation: vi.fn(),
  compactNativeHistoryDatabase: vi.fn(),
  commitNativeHistoryRestore: vi.fn(),
  createNativeHistoryCollection: vi.fn(),
  createNativeHistoryBackup: vi.fn(),
  deleteNativeHistoryCollection: vi.fn(),
  discardNativeHistoryRestore: vi.fn(),
  getNativeHistoryHealth: vi.fn(),
  getNativeStorageStats: vi.fn(),
  listNativeHistoryCollections: vi.fn(),
  loadNativeClipPayload: vi.fn(),
  loadNativeHistory: vi.fn(),
  prepareNativeHistoryRestore: vi.fn(),
  queryNativeHistory: vi.fn(),
  renameNativeHistoryCollection: vi.fn(),
  saveNativeHistorySnippet: vi.fn(),
}))

const ocrMocks = vi.hoisted(() => ({
  invalidateNativeClipboardOcr: vi.fn(),
  listNativePendingOcrImages: vi.fn(),
  markNativeClipOcrFailed: vi.fn(),
  recognizeNativeClipImage: vi.fn(),
  setNativeClipboardOcrEnabled: vi.fn(),
}))

const metricsMocks = vi.hoisted(() => ({
  acknowledgeQuickPanelFirstFrame: vi.fn(),
}))

const clipboardMocks = vi.hoisted(() => ({
  copyImage: vi.fn().mockResolvedValue(true),
  copyText: vi.fn().mockResolvedValue(true),
  pasteFiles: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteFormats: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteImage: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteText: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
}))

const systemMocks = vi.hoisted(() => ({
  openExternalLink: vi.fn().mockResolvedValue(true),
  openFilePath: vi.fn().mockResolvedValue(true),
  revealFilePath: vi.fn().mockResolvedValue(true),
  saveClipboardImage: vi.fn().mockResolvedValue('saved'),
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
vi.mock('./platform/ocr', async (importOriginal) => ({
  ...await importOriginal<typeof import('./platform/ocr')>(),
  ...ocrMocks,
}))
vi.mock('./platform/metrics', () => metricsMocks)
vi.mock('./platform/clipboard', () => clipboardMocks)
vi.mock('./platform/system', () => systemMocks)
vi.mock('./platform/window', () => windowMocks)
vi.mock('./platform/updater', () => updaterMocks)

const defaultStorageStats = {
  databaseBytes: 4096,
  walBytes: 0,
  shmBytes: 0,
  totalPhysicalBytes: 4096,
  recordCount: 0,
  pinnedCount: 0,
  permanentCount: 0,
  imageBytes: 0,
  richFormatBytes: 0,
  fileRecordCount: 0,
  logicalBytes: 0,
  oldestCopiedAt: null,
  newestCopiedAt: null,
  maxRecords: 500,
  maxImageBytes: 268_435_456,
  retentionDays: 30,
}

function pendingOcrImage(id = 'ocr-image', imageHash = 'a'.repeat(64)) {
  return {
    id,
    kind: 'image',
    title: '剪贴板图片',
    content: 'data:image/png;base64,iVBORw0KGgo=',
    sourceApp: 'SnippingTool',
    copiedAt: '2026-07-19T10:00:00.000Z',
    pinned: false,
    searchTerms: [],
    formats: ['image'],
    imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
    imageHash,
    ocrStatus: 'pending',
  }
}

describe('native setting reliability', () => {
  let legacyHistory: Array<Record<string, unknown>> | null = null

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
    historyMocks.queryNativeHistory.mockReset().mockImplementation(async (query) => {
      if (legacyHistory === null) {
        const loaded = await historyMocks.loadNativeHistory()
        if (loaded === null) return null
        legacyHistory = loaded
      }
      const normalizedText = String(query.text ?? '').normalize('NFKC').toLocaleLowerCase().trim()
      const kinds = Array.isArray(query.kinds) ? query.kinds : []
      const sourceApps = Array.isArray(query.sourceApps) ? query.sourceApps : []
      const filtered = (legacyHistory ?? []).filter((item) => {
        const visibleText = `${item.title ?? ''}\n${item.content ?? ''}\n${item.sourceApp ?? ''}`.normalize('NFKC').toLocaleLowerCase()
        return (!normalizedText || visibleText.includes(normalizedText))
          && (kinds.length === 0 || kinds.includes(item.kind))
          && (sourceApps.length === 0 || sourceApps.includes(item.sourceApp))
          && (query.pinned === undefined || item.pinned === query.pinned)
      })
      const summaries = filtered.map((item) => {
        const { imageUrl: _imageUrl, html: _html, rtfBase64: _rtf, ocrText: _ocr, ...summary } = item
        return { ...summary, searchTerms: [], payloadLoaded: false }
      })
      return { items: summaries, totalCount: summaries.length }
    })
    historyMocks.loadNativeClipPayload.mockReset().mockImplementation(async (id) => {
      const item = legacyHistory?.find((candidate) => candidate.id === id)
      return item ? { status: 'loaded', item: { ...item } } : { status: 'missing' }
    })
    historyMocks.applyNativeHistoryMutation.mockReset().mockImplementation(async (mutation: {
      deleteIds: string[]
      upserts: Array<Record<string, unknown> & { id: string }>
    }) => {
      if (legacyHistory !== null) {
        const deleted = new Set(mutation.deleteIds)
        const upsertById = new Map(mutation.upserts.map((item) => [item.id, item]))
        legacyHistory = legacyHistory
          .filter((item) => !deleted.has(String(item.id)) && !upsertById.has(String(item.id)))
        legacyHistory.unshift(...mutation.upserts.map((item) => ({ ...item })))
      }
      return { prunedIds: [] }
    })
    historyMocks.applyNativeHistoryBatch.mockReset().mockResolvedValue({
      matchedCount: 1,
      changedCount: 1,
      deletedCount: 0,
      prunedIds: [],
    })
    historyMocks.listNativeHistoryCollections.mockReset().mockResolvedValue([])
    historyMocks.createNativeHistoryCollection.mockReset().mockResolvedValue(null)
    historyMocks.renameNativeHistoryCollection.mockReset().mockResolvedValue(null)
    historyMocks.deleteNativeHistoryCollection.mockReset().mockResolvedValue(null)
    historyMocks.saveNativeHistorySnippet.mockReset().mockResolvedValue(null)
    historyMocks.compactNativeHistoryDatabase.mockReset().mockResolvedValue({ ...defaultStorageStats })
    historyMocks.commitNativeHistoryRestore.mockReset().mockResolvedValue(null)
    historyMocks.createNativeHistoryBackup.mockReset().mockResolvedValue({ status: 'cancelled' })
    historyMocks.discardNativeHistoryRestore.mockReset().mockResolvedValue({ status: 'discarded' })
    historyMocks.getNativeHistoryHealth.mockReset().mockResolvedValue({ status: 'healthy' })
    historyMocks.getNativeStorageStats.mockReset().mockResolvedValue({ ...defaultStorageStats })
    historyMocks.prepareNativeHistoryRestore.mockReset().mockResolvedValue({ status: 'cancelled' })
    ocrMocks.markNativeClipOcrFailed.mockReset().mockResolvedValue({
      status: 'applied', ocrStatus: 'failed',
    })
    ocrMocks.invalidateNativeClipboardOcr.mockReset().mockResolvedValue(true)
    ocrMocks.listNativePendingOcrImages.mockReset().mockResolvedValue({ items: [] })
    ocrMocks.recognizeNativeClipImage.mockReset().mockResolvedValue({ status: 'stale' })
    ocrMocks.setNativeClipboardOcrEnabled.mockReset().mockResolvedValue(true)
    metricsMocks.acknowledgeQuickPanelFirstFrame.mockReset().mockResolvedValue(true)
    legacyHistory = null
    clipboardMocks.pasteFiles.mockReset().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })
    clipboardMocks.pasteFormats.mockReset().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })
    clipboardMocks.pasteImage.mockReset().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })
    clipboardMocks.pasteText.mockReset().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })
    systemMocks.openExternalLink.mockReset().mockResolvedValue(true)
    systemMocks.openFilePath.mockReset().mockResolvedValue(true)
    systemMocks.revealFilePath.mockReset().mockResolvedValue(true)
    systemMocks.saveClipboardImage.mockReset().mockResolvedValue('saved')
    updaterMocks.checkForUpdate.mockReset().mockResolvedValue(null)
    updaterMocks.connectUpdateCheckRequested.mockReset().mockResolvedValue(() => undefined)
    updaterMocks.downloadUpdate.mockReset().mockResolvedValue(null)
    updaterMocks.getCurrentVersion.mockReset().mockResolvedValue('0.1.0')
    updaterMocks.installDownloadedUpdate.mockReset().mockResolvedValue(null)
  })

  it('defaults Windows-local OCR on, preserves explicit false, and keeps the control manager-only', async () => {
    historyMocks.loadNativeHistory.mockResolvedValueOnce([pendingOcrImage()])
    ocrMocks.listNativePendingOcrImages.mockResolvedValueOnce({
      items: [{ id: 'ocr-image', imageHash: 'a'.repeat(64) }],
    })
    const enabled = mount(App)
    await flushPromises()

    expect(ocrMocks.setNativeClipboardOcrEnabled).toHaveBeenCalledWith(true)
    expect(ocrMocks.recognizeNativeClipImage).toHaveBeenCalledWith('ocr-image', 'a'.repeat(64))
    expect(enabled.find('[data-testid="ocr-enabled-toggle"]').exists()).toBe(false)
    await enabled.get('[aria-label="打开设置"]').trigger('click')
    expect((enabled.get('[data-testid="ocr-enabled-toggle"]').element as HTMLInputElement).checked).toBe(true)
    expect(enabled.get('#ocr-setting-description').text()).toContain('不上传')
    enabled.unmount()

    vi.clearAllMocks()
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      settingsVersion: 5,
      onboardingCompleted: true,
      ocrEnabled: false,
    }))
    historyMocks.loadNativeHistory.mockResolvedValue([pendingOcrImage('disabled-image', 'b'.repeat(64))])
    historyMocks.queryNativeHistory.mockResolvedValue({
      items: [{
        ...pendingOcrImage('disabled-image', 'b'.repeat(64)),
        imageUrl: undefined,
        searchTerms: [],
        payloadLoaded: false,
      }],
      totalCount: 1,
    })
    desktopMocks.connectNativeClipboard.mockResolvedValue(() => undefined)
    desktopMocks.connectCaptureAvailability.mockResolvedValue(() => undefined)
    desktopMocks.connectPasteTarget.mockResolvedValue(() => undefined)
    desktopMocks.connectQuitRequested.mockResolvedValue(() => undefined)
    desktopMocks.connectQuickPanelSession.mockResolvedValue(() => undefined)
    desktopMocks.getNativeCaptureAvailability.mockResolvedValue({ available: true, initialized: true })
    settingsMocks.getLaunchAtStartup.mockResolvedValue(false)
    historyMocks.listNativeHistoryCollections.mockResolvedValue([])
    updaterMocks.connectUpdateCheckRequested.mockResolvedValue(() => undefined)
    updaterMocks.getCurrentVersion.mockResolvedValue('0.2.0')

    const disabled = mount(App)
    await flushPromises()
    expect(ocrMocks.setNativeClipboardOcrEnabled).toHaveBeenCalledWith(false)
    expect(ocrMocks.recognizeNativeClipImage).not.toHaveBeenCalled()
    await disabled.get('[aria-label="打开设置"]').trigger('click')
    expect((disabled.get('[data-testid="ocr-enabled-toggle"]').element as HTMLInputElement).checked).toBe(false)
    disabled.unmount()
  })

  it('keeps an explicit OCR opt-out when startup native synchronization fails', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      settingsVersion: 5,
      onboardingCompleted: true,
      ocrEnabled: false,
    }))
    historyMocks.loadNativeHistory.mockResolvedValueOnce([
      pendingOcrImage('disabled-startup-image', 'c'.repeat(64)),
    ])
    ocrMocks.setNativeClipboardOcrEnabled.mockResolvedValueOnce(false)

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect(ocrMocks.setNativeClipboardOcrEnabled).toHaveBeenCalledWith(false)
    expect((wrapper.get('[data-testid="ocr-enabled-toggle"]').element as HTMLInputElement).checked)
      .toBe(false)
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').ocrEnabled).toBe(false)
    expect(ocrMocks.listNativePendingOcrImages).not.toHaveBeenCalled()
    expect(ocrMocks.recognizeNativeClipImage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('rolls the OCR setting back when the native gate cannot be synchronized', async () => {
    ocrMocks.setNativeClipboardOcrEnabled
      .mockReset()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const toggle = wrapper.get('[data-testid="ocr-enabled-toggle"]')
    await toggle.setValue(false)
    await flushPromises()

    expect(ocrMocks.setNativeClipboardOcrEnabled.mock.calls).toEqual([[true], [false]])
    expect((toggle.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('设置未能应用')
    wrapper.unmount()
  })

  it('persists a captured image before scheduling OCR and never sends image bytes through OCR IPC', async () => {
    const order: string[] = []
    let capture: ((payload: {
      kind: 'image'
      content: string
      capturedAt: string
      sourceApp?: string
      width: number
      height: number
      formats: ['image']
      imageHash: string
    }) => void) | undefined
    desktopMocks.connectNativeClipboard.mockImplementation(async (callback) => {
      capture = callback
      return () => undefined
    })
    historyMocks.applyNativeHistoryMutation.mockImplementation(async () => {
      order.push('persist')
      return { prunedIds: [] }
    })
    ocrMocks.recognizeNativeClipImage.mockImplementation(async () => {
      order.push('recognize')
      return { status: 'stale' }
    })

    const wrapper = mount(App)
    await flushPromises()
    order.length = 0
    historyMocks.applyNativeHistoryMutation.mockClear()
    capture?.({
      kind: 'image',
      content: 'data:image/png;base64,iVBORw0KGgo=',
      capturedAt: '2026-07-19T10:01:00.000Z',
      sourceApp: 'SnippingTool',
      width: 16,
      height: 16,
      formats: ['image'],
      imageHash: 'c'.repeat(64),
    })
    await flushPromises()

    expect(order.slice(0, 2)).toEqual(['persist', 'recognize'])
    expect(ocrMocks.recognizeNativeClipImage).toHaveBeenCalledWith(
      expect.stringMatching(/^captured-/),
      'c'.repeat(64),
    )
    expect(ocrMocks.recognizeNativeClipImage.mock.calls[0]).toHaveLength(2)
    wrapper.unmount()
  })

  it('requires confirmation for permanent snippet deletion from both the button and Delete key', async () => {
    const snippet = {
      id: 'snippet-delete',
      kind: 'code',
      title: '常用脚本',
      content: 'Write-Output ok',
      sourceApp: 'QuickPaste',
      copiedAt: '2026-07-19T08:00:00.000Z',
      updatedAt: '2026-07-19T08:00:00.000Z',
      pinned: false,
      permanent: true,
      searchTerms: [],
      formats: ['text'],
    }
    historyMocks.loadNativeHistory.mockResolvedValueOnce([snippet])
    historyMocks.applyNativeHistoryBatch.mockImplementation(async (target, action) => {
      expect(target).toEqual({ mode: 'ids', ids: ['snippet-delete'] })
      expect(action).toEqual({ type: 'delete' })
      legacyHistory = []
      return { matchedCount: 1, changedCount: 1, deletedCount: 1, prunedIds: [] }
    })

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="manager-delete-snippet-delete"]').trigger('click')
    expect(historyMocks.applyNativeHistoryBatch).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="manager-permanent-delete-confirmation"]').text())
      .toContain('常用脚本')
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="manager-cancel-delete-permanent"]').element,
    )
    await wrapper.get('[data-testid="manager-cancel-delete-permanent"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-manager-clip-id="snippet-delete"]').exists()).toBe(true)

    const row = wrapper.get('[data-manager-clip-id="snippet-delete"]')
    ;(row.element as HTMLElement).focus()
    await row.trigger('keydown', { key: 'Delete' })
    expect(historyMocks.applyNativeHistoryBatch).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="manager-permanent-delete-confirmation"]').exists()).toBe(true)

    await wrapper.get('[data-testid="manager-confirm-delete-permanent"]').trigger('click')
    await flushPromises()
    expect(historyMocks.applyNativeHistoryBatch).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-manager-clip-id="snippet-delete"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('applies only OCR metadata and uses native match sources for OCR versus index badges', async () => {
    const image = pendingOcrImage()
    historyMocks.loadNativeHistory.mockResolvedValueOnce([image])
    ocrMocks.listNativePendingOcrImages.mockResolvedValueOnce({
      items: [{ id: image.id, imageHash: image.imageHash }],
    })
    ocrMocks.recognizeNativeClipImage.mockImplementationOnce(async () => {
      if (legacyHistory?.[0]) {
        legacyHistory[0] = {
          ...legacyHistory[0],
          ocrStatus: 'completed',
          ocrText: 'secret invoice number',
        }
      }
      return { status: 'applied', ocrStatus: 'completed', ocrText: 'secret invoice number' }
    })

    const wrapper = mount(App)
    await flushPromises()
    expect(historyMocks.applyNativeHistoryMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      upserts: [expect.objectContaining({ imageHash: 'a'.repeat(64) })],
    }))

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="manager-ocr-status-ocr-image"]').text()).toContain('已完成')

    const { imageUrl: _imageUrl, ocrText: _ocrText, ...summary } = {
      ...image,
      ocrStatus: 'completed',
      ocrText: 'secret invoice number',
    }
    historyMocks.queryNativeHistory.mockResolvedValue({
      items: [{ ...summary, searchTerms: [], payloadLoaded: false, matchSource: 'ocr' }],
      totalCount: 1,
    })
    await wrapper.get('[data-testid="manager-search-input"]').setValue('secret')
    await flushPromises()

    expect(wrapper.get('.ocr-match').text()).toContain('OCR 命中')
    expect(wrapper.find('.phonetic-match').exists()).toBe(false)

    historyMocks.queryNativeHistory.mockResolvedValue({
      items: [{ ...summary, searchTerms: [], payloadLoaded: false, matchSource: 'index' }],
      totalCount: 1,
    })
    await wrapper.get('[data-testid="manager-search-input"]').setValue('tupian')
    await flushPromises()
    expect(wrapper.find('.ocr-match').exists()).toBe(false)
    expect(wrapper.get('.phonetic-match').text()).toContain('索引命中')

    historyMocks.queryNativeHistory.mockResolvedValue({
      items: [{ ...summary, searchTerms: [], payloadLoaded: false, matchSource: 'ocr' }],
      totalCount: 1,
    })
    await wrapper.get('[data-testid="library-view"] .back-button').trigger('click')
    await wrapper.get('[data-testid="search-input"]').setValue('secret')
    await flushPromises()
    expect(wrapper.get('.ocr-match').text()).toContain('OCR 命中')
    expect(wrapper.find('.phonetic-match').exists()).toBe(false)
    wrapper.unmount()
  })

  it('discards an OCR result after settings disable and leaves the stored pending record intact', async () => {
    let finishRecognition: ((value: {
      status: 'applied'
      ocrStatus: 'completed'
      ocrText: string
    }) => void) | undefined
    historyMocks.loadNativeHistory.mockResolvedValueOnce([pendingOcrImage()])
    ocrMocks.listNativePendingOcrImages.mockResolvedValueOnce({
      items: [{ id: 'ocr-image', imageHash: 'a'.repeat(64) }],
    })
    ocrMocks.recognizeNativeClipImage.mockImplementationOnce(() => new Promise((resolve) => {
      finishRecognition = resolve
    }))

    const wrapper = mount(App)
    await flushPromises()
    expect(ocrMocks.recognizeNativeClipImage).toHaveBeenCalledOnce()

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="ocr-enabled-toggle"]').setValue(false)
    await flushPromises()
    expect(ocrMocks.setNativeClipboardOcrEnabled).toHaveBeenLastCalledWith(false)
    finishRecognition?.({ status: 'applied', ocrStatus: 'completed', ocrText: 'must not revive' })
    await flushPromises()
    await wrapper.get('[data-testid="library-section-all"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="manager-ocr-status-ocr-image"]').text()).toContain('待处理')
    expect(historyMocks.applyNativeHistoryMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      upserts: [expect.objectContaining({ ocrText: 'must not revive' })],
    }))
    wrapper.unmount()
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
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-pin-clip-before-update"]').trigger('click')
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="check-update"]').trigger('click')
    await flushPromises()

    historyMocks.applyNativeHistoryMutation.mockClear()
    historyMocks.applyNativeHistoryMutation.mockResolvedValue(null)
    await wrapper.get('[data-testid="install-update"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(updaterMocks.downloadUpdate).toHaveBeenCalledOnce()
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalled()
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
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledWith({
      upserts: [],
      deleteIds: [],
      policy: { maxRecords: 500, maxImageBytes: 268_435_456, retentionDays: 30 },
    })
    expect(wrapper.get('[data-testid="empty-history"]').text()).toContain('复制任意内容')
    expect(wrapper.find('[data-testid="no-results"]').exists()).toBe(false)
  })

  it('keeps a successful native history load with Rust empty file lists read-only', async () => {
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'rust-text-record',
      kind: 'text',
      title: '原生文本',
      content: '来自 SQLite 的文本',
      sourceApp: 'Notepad',
      copiedAt: '2026-07-19T03:00:00.000Z',
      pinned: false,
      searchTerms: [],
      formats: ['text'],
      omittedFormats: ['html', 'rtf'],
      files: [],
      payloadLoaded: true,
      permanent: false,
      updatedAt: '2026-07-19T03:00:00.000Z',
    }])

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.find('[data-testid="history-error"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('原生文本')
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('writes only the local startup normalization delta after a successful native load', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      retentionDays: '7',
    }))
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'expired', kind: 'text', title: '过期记录', content: 'expired', sourceApp: 'Notepad',
      copiedAt: '2020-01-01T00:00:00.000Z', pinned: false, searchTerms: [],
    }, {
      id: 'permanent-expired', kind: 'text', title: '永久记录', content: 'permanent', sourceApp: 'Notepad',
      copiedAt: '2020-01-01T00:00:00.000Z', pinned: false, permanent: true, searchTerms: [],
    }, {
      id: 'current', kind: 'text', title: '当前记录', content: 'current', sourceApp: 'Notepad',
      copiedAt: new Date().toISOString(), pinned: false, searchTerms: [],
    }])

    const wrapper = mount(App)
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledWith({
      upserts: [],
      deleteIds: ['expired'],
      policy: expect.objectContaining({ maxRecords: 500, retentionDays: 7 }),
    })
    wrapper.unmount()
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
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledWith({
      upserts: [expect.objectContaining({ content: '冷启动期间复制的内容' })],
      deleteIds: [],
      policy: expect.objectContaining({ maxRecords: 500, retentionDays: 30 }),
    })
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
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
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

  it('acknowledges only the current quick session after Vue flushes and one animation frame', async () => {
    let quickPanelInvoked: ((session: {
      sessionId: number
      sourceApp: string
      elevated: boolean
    }) => void) | undefined
    desktopMocks.connectQuickPanelSession.mockImplementation(async (callback) => {
      quickPanelInvoked = callback
      return () => undefined
    })
    const frames: FrameRequestCallback[] = []
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })

    const wrapper = mount(App)
    await flushPromises()

    quickPanelInvoked?.({ sessionId: 21, sourceApp: 'Notepad', elevated: false })
    quickPanelInvoked?.({ sessionId: 22, sourceApp: 'Terminal', elevated: false })
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(metricsMocks.acknowledgeQuickPanelFirstFrame).not.toHaveBeenCalled()
    expect(frames).toHaveLength(2)

    frames.shift()?.(16)
    await flushPromises()
    expect(metricsMocks.acknowledgeQuickPanelFirstFrame).not.toHaveBeenCalled()

    frames.shift()?.(32)
    await flushPromises()
    expect(metricsMocks.acknowledgeQuickPanelFirstFrame).toHaveBeenCalledOnce()
    expect(metricsMocks.acknowledgeQuickPanelFirstFrame).toHaveBeenCalledWith(22)

    quickPanelInvoked?.({ sessionId: 22, sourceApp: 'Terminal', elevated: false })
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    frames.shift()?.(48)
    await flushPromises()
    expect(metricsMocks.acknowledgeQuickPanelFirstFrame).toHaveBeenCalledOnce()

    wrapper.unmount()
    animationFrame.mockRestore()
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

  it('removes an image-byte-pruned row and clears quick preview and context state', async () => {
    vi.useFakeTimers()
    let finishMutation: ((result: { prunedIds: string[] }) => void) | undefined
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'keeper', kind: 'text', title: '保留记录', content: 'keep', sourceApp: 'Notepad',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [],
    }, {
      id: 'capacity-image', kind: 'image', title: '容量图片', content: '', sourceApp: 'Snipping Tool',
      copiedAt: '2026-07-19T09:00:00.000Z', pinned: false, searchTerms: [],
      imageUrl: 'data:image/png;base64,aW1hZ2U=',
    }])
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    historyMocks.applyNativeHistoryMutation.mockReset()
      .mockImplementationOnce(() => new Promise<{ prunedIds: string[] }>((resolve) => { finishMutation = resolve }))
      .mockResolvedValue({ prunedIds: [] })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-pin-keeper"]').trigger('click')
    await vi.advanceTimersByTimeAsync(180)
    await flushPromises()
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    await wrapper.get('.back-button').trigger('click')

    await wrapper.get('[data-testid="preview-clip-capacity-image"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="preview-panel"]').trigger('contextmenu', { clientX: 20, clientY: 20 })
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(true)

    finishMutation?.({ prunedIds: ['capacity-image'] })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()

    expect(wrapper.find('[data-clip-id="capacity-image"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
    expect(wrapper.get('[data-clip-id="keeper"]').classes()).toContain('is-selected')
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('persists a pin made in the same tick as a capacity-pruned callback', async () => {
    vi.useFakeTimers()
    let finishMutation: ((result: { prunedIds: string[] }) => void) | undefined
    const mutationResult = new Promise<{ prunedIds: string[] }>((resolve) => { finishMutation = resolve })
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'first-change', kind: 'text', title: '首个变更', content: 'first', sourceApp: 'Notepad',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [],
    }, {
      id: 'capacity-pruned', kind: 'image', title: '容量裁剪', content: '', sourceApp: 'Snipping Tool',
      copiedAt: '2026-07-19T09:00:00.000Z', pinned: false, searchTerms: [],
      imageUrl: 'data:image/png;base64,aW1hZ2U=',
    }, {
      id: 'immediate-pin', kind: 'text', title: '紧接固定', content: 'next', sourceApp: 'Notepad',
      copiedAt: '2026-07-19T08:00:00.000Z', pinned: false, searchTerms: [],
    }])
    const wrapper = mount(App)
    await flushPromises()
    historyMocks.applyNativeHistoryMutation.mockReset()
      .mockReturnValueOnce(mutationResult)
      .mockResolvedValue({ prunedIds: [] })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-pin-first-change"]').trigger('click')
    await vi.advanceTimersByTimeAsync(180)
    await flushPromises()
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()

    const pinImmediately = mutationResult.then(() => (
      wrapper.get('[data-testid="manager-pin-immediate-pin"]').trigger('click')
    ))
    finishMutation?.({ prunedIds: ['capacity-pruned'] })
    await pinImmediately
    await flushPromises()
    await vi.advanceTimersByTimeAsync(180)
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledTimes(2)
    expect(historyMocks.applyNativeHistoryMutation.mock.calls[1]?.[0]).toEqual({
      upserts: [expect.objectContaining({ id: 'immediate-pin', pinned: true })],
      deleteIds: [],
      policy: expect.objectContaining({ maxRecords: 500, retentionDays: 30 }),
    })
    expect(wrapper.find('[data-clip-id="capacity-pruned"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="manager-pin-immediate-pin"]').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('repairs manager selection when a visible capacity-pruned row disappears', async () => {
    vi.useFakeTimers()
    let finishMutation: ((result: { prunedIds: string[] }) => void) | undefined
    historyMocks.loadNativeHistory.mockResolvedValueOnce([{
      id: 'manager-keeper', kind: 'text', title: '管理器保留', content: 'keep', sourceApp: 'Notepad',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [],
    }, {
      id: 'manager-pruned', kind: 'image', title: '管理器裁剪', content: '', sourceApp: 'Snipping Tool',
      copiedAt: '2026-07-19T09:00:00.000Z', pinned: false, searchTerms: [],
      imageUrl: 'data:image/png;base64,aW1hZ2U=',
    }])
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    historyMocks.applyNativeHistoryMutation.mockReset()
      .mockImplementationOnce(() => new Promise<{ prunedIds: string[] }>((resolve) => { finishMutation = resolve }))
      .mockResolvedValue({ prunedIds: [] })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-pin-manager-keeper"]').trigger('click')
    await vi.advanceTimersByTimeAsync(180)
    await flushPromises()
    await wrapper.get('[data-manager-clip-id="manager-pruned"]').trigger('focus')

    finishMutation?.({ prunedIds: ['manager-pruned'] })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()

    expect(wrapper.find('[data-manager-clip-id="manager-pruned"]').exists()).toBe(false)
    expect(wrapper.get('[data-manager-clip-id="manager-keeper"]').attributes('aria-current')).toBe('true')
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('accepts an empty result object while flushing the latest history before quit', async () => {
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
    historyMocks.applyNativeHistoryMutation.mockClear()

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-pin-clip-1"]').trigger('click')
    requestQuit?.()
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledWith({
      upserts: [expect.objectContaining({ id: 'clip-1', pinned: true })],
      deleteIds: [],
      policy: expect.objectContaining({ maxRecords: 500, retentionDays: 30 }),
    })
    expect(desktopMocks.exitNativeApp).toHaveBeenCalledOnce()
    expect(desktopMocks.cancelNativeQuit).not.toHaveBeenCalled()
    expect(wrapper.find('[data-manager-clip-id="clip-1"]').exists()).toBe(true)
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
    historyMocks.applyNativeHistoryMutation.mockClear()
    historyMocks.applyNativeHistoryMutation.mockResolvedValue(null)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-pin-clip-1"]').trigger('click')
    requestQuit?.()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledTimes(3)
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
    historyMocks.applyNativeHistoryMutation.mockClear()
    historyMocks.applyNativeHistoryMutation.mockImplementation(() => new Promise<{ prunedIds: string[] } | null>(() => undefined))

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-pin-clip-1"]').trigger('click')
    requestQuit?.()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3_100)
    await flushPromises()

    expect(desktopMocks.exitNativeApp).not.toHaveBeenCalled()
    expect(desktopMocks.cancelNativeQuit).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="alert"]').text()).toContain('历史仍未保存')
  })

  it('queries canonical native summaries instead of loading the full history array', async () => {
    historyMocks.queryNativeHistory.mockReset().mockResolvedValueOnce({
      items: [{
        id: 'summary-1',
        kind: 'text',
        title: '摘要',
        content: 'short summary',
        sourceApp: 'Notepad',
        copiedAt: '2026-07-19T10:00:00.000Z',
        pinned: false,
        searchTerms: [],
        payloadLoaded: false,
      }],
      totalCount: 123,
    })

    const wrapper = mount(App)
    await flushPromises()

    expect(historyMocks.queryNativeHistory).toHaveBeenCalledWith({
      text: '',
      kinds: [],
      sourceApps: [],
      collection: { mode: 'any' },
      limit: 50,
    })
    expect(historyMocks.loadNativeHistory).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('摘要')
    expect(wrapper.get('[data-testid="quick-history-page-status"]').text()).toContain('已加载 1 条，共 123 条匹配')
  })

  it('ignores an older native query after a newer input result has rendered', async () => {
    historyMocks.queryNativeHistory.mockReset().mockResolvedValueOnce({ items: [], totalCount: 0 })
    const wrapper = mount(App)
    await flushPromises()
    historyMocks.queryNativeHistory.mockClear()

    let finishOld: ((page: Record<string, unknown>) => void) | undefined
    let finishNew: ((page: Record<string, unknown>) => void) | undefined
    historyMocks.queryNativeHistory.mockImplementation((nativeQuery) => new Promise((resolve) => {
      if (nativeQuery.text === 'old') finishOld = resolve
      if (nativeQuery.text === 'new') finishNew = resolve
    }))

    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('old')
    await flushPromises()
    await search.setValue('new')
    await flushPromises()

    finishNew?.({
      items: [{ id: 'new', kind: 'text', title: '最新结果', content: 'new', sourceApp: 'Editor', copiedAt: '2026-07-19T10:01:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }],
      totalCount: 1,
    })
    await flushPromises()
    expect(wrapper.text()).toContain('最新结果')

    finishOld?.({
      items: [{ id: 'old', kind: 'text', title: '过期结果', content: 'old', sourceApp: 'Editor', copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }],
      totalCount: 1,
    })
    await flushPromises()
    expect(wrapper.text()).toContain('最新结果')
    expect(wrapper.text()).not.toContain('过期结果')
  })

  it('does not query intermediate Chinese IME values and queries compositionend once', async () => {
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
    const wrapper = mount(App)
    await flushPromises()
    historyMocks.queryNativeHistory.mockClear()

    const search = wrapper.get('[data-testid="search-input"]')
    await search.trigger('compositionstart')
    await search.setValue('中')
    await search.setValue('中文')
    await flushPromises()
    expect(historyMocks.queryNativeHistory).not.toHaveBeenCalled()

    await search.trigger('compositionend')
    await flushPromises()
    expect(historyMocks.queryNativeHistory).toHaveBeenCalledTimes(1)
    expect(historyMocks.queryNativeHistory).toHaveBeenCalledWith(expect.objectContaining({ text: '中文' }))
  })

  it('hydrates a native summary before formatted paste and never pastes summary content directly', async () => {
    historyMocks.queryNativeHistory.mockReset().mockResolvedValueOnce({
      items: [{
        id: 'rich-summary', kind: 'text', title: '富文本摘要', content: 'summary only', sourceApp: 'Word',
        copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], formats: ['text', 'html'], payloadLoaded: false,
      }],
      totalCount: 1,
    })
    let finishPayload: ((result: Record<string, unknown>) => void) | undefined
    historyMocks.loadNativeClipPayload.mockReset().mockImplementation(() => new Promise((resolve) => {
      finishPayload = resolve
    }))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-clip-id="rich-summary"] .clip-primary').trigger('dblclick')
    await flushPromises()

    expect(historyMocks.loadNativeClipPayload).toHaveBeenCalledWith('rich-summary')
    expect(clipboardMocks.pasteFormats).not.toHaveBeenCalled()
    expect(clipboardMocks.pasteText).not.toHaveBeenCalled()

    finishPayload?.({
      status: 'loaded',
      item: {
        id: 'rich-summary', kind: 'text', title: '富文本', content: 'full text', sourceApp: 'Word',
        copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], formats: ['text', 'html'], html: '<b>full</b>',
      },
    })
    await flushPromises()
    expect(clipboardMocks.pasteFormats).toHaveBeenCalledWith('full text', '<b>full</b>', undefined)
  })

  it('hydrates a native link summary before running its manager system action', async () => {
    historyMocks.queryNativeHistory.mockReset().mockResolvedValueOnce({
      items: [{
        id: 'link-summary', kind: 'link', title: '链接摘要', content: 'https://example.com/summary', sourceApp: 'Edge',
        copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], formats: ['text'], payloadLoaded: false,
      }],
      totalCount: 1,
    })
    historyMocks.loadNativeClipPayload.mockReset().mockResolvedValueOnce({
      status: 'loaded',
      item: {
        id: 'link-summary', kind: 'link', title: '完整链接', content: 'https://example.com/full', sourceApp: 'Edge',
        copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], formats: ['text'], payloadLoaded: true,
      },
    })

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-manager-clip-id="link-summary"]').trigger('contextmenu', { clientX: 20, clientY: 20 })
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-open-link"]').trigger('click')
    await flushPromises()

    expect(historyMocks.loadNativeClipPayload).toHaveBeenCalledWith('link-summary')
    expect(systemMocks.openExternalLink).toHaveBeenCalledWith('https://example.com/full')
    expect(systemMocks.openExternalLink).not.toHaveBeenCalledWith('https://example.com/summary')
    wrapper.unmount()
  })

  it('ignores an old keyset page after filters start a new native query', async () => {
    historyMocks.queryNativeHistory.mockReset().mockResolvedValueOnce({
      items: [{ id: 'first', kind: 'text', title: '第一页', content: 'first', sourceApp: 'Editor', copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }],
      nextCursor: 'MTc1MjkxOTIwMDAwMApmaXJzdA==',
      totalCount: 3,
    })
    const wrapper = mount(App)
    await flushPromises()

    let finishPage: ((page: Record<string, unknown>) => void) | undefined
    historyMocks.queryNativeHistory.mockImplementation((nativeQuery) => {
      if (nativeQuery.cursor === 'MTc1MjkxOTIwMDAwMApmaXJzdA==') {
        return new Promise((resolve) => { finishPage = resolve })
      }
      return Promise.resolve({
        items: [{ id: 'images', kind: 'image', title: '图片新查询', content: 'image', sourceApp: 'Snip', copiedAt: '2026-07-19T10:02:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }],
        totalCount: 1,
      })
    })

    await wrapper.get('[data-testid="history-load-more"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="filter-image"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('图片新查询')

    finishPage?.({
      items: [{ id: 'stale-page', kind: 'text', title: '旧分页', content: 'stale', sourceApp: 'Editor', copiedAt: '2026-07-19T09:59:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }],
      totalCount: 3,
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('旧分页')
  })

  it('does not cache or open a stale payload after a new query replaces its summary', async () => {
    const summaryA = { id: 'payload-a', kind: 'text', title: '摘要 A', content: 'summary a', sourceApp: 'Editor', copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }
    const summaryB = { id: 'payload-b', kind: 'text', title: '摘要 B', content: 'summary b', sourceApp: 'Editor', copiedAt: '2026-07-19T10:01:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }
    historyMocks.queryNativeHistory.mockReset()
      .mockResolvedValueOnce({ items: [summaryA], totalCount: 1 })
      .mockResolvedValueOnce({ items: [summaryB], totalCount: 1 })
      .mockResolvedValueOnce({ items: [summaryA], totalCount: 1 })
    let finishPayload: ((result: Record<string, unknown>) => void) | undefined
    historyMocks.loadNativeClipPayload.mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { finishPayload = resolve }))
      .mockResolvedValueOnce({ status: 'missing' })

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="preview-clip-payload-a"]').trigger('click')
    await wrapper.get('[data-clip-id="payload-a"] .clip-primary').trigger('dblclick')
    await flushPromises()
    expect(historyMocks.loadNativeClipPayload).toHaveBeenCalledOnce()
    await wrapper.get('[data-testid="search-input"]').setValue('b')
    await flushPromises()

    finishPayload?.({
      status: 'loaded',
      item: { ...summaryA, title: '完整 A', content: 'full a', payloadLoaded: true },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('摘要 B')
    expect(wrapper.text()).not.toContain('完整 A')
    expect(clipboardMocks.pasteText).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="search-input"]').setValue('')
    await flushPromises()
    await wrapper.get('[data-testid="preview-clip-payload-a"]').trigger('click')
    await flushPromises()
    expect(historyMocks.loadNativeClipPayload).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false)
  })

  it('waits for a dirty mutation to flush before issuing a new native query', async () => {
    const summary = { id: 'dirty-order', kind: 'text', title: '待固定', content: 'dirty', sourceApp: 'Editor', copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [summary], totalCount: 1 })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="clear-history"]').exists()).toBe(false)
    historyMocks.queryNativeHistory.mockClear()

    let finishMutation: ((result: { prunedIds: string[] } | null) => void) | undefined
    historyMocks.applyNativeHistoryMutation.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      finishMutation = resolve
    }))
    await wrapper.get('[data-testid="manager-pin-dirty-order"]').trigger('click')
    await wrapper.get('[data-testid="manager-search-input"]').setValue('dirty')
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    expect(historyMocks.queryNativeHistory).not.toHaveBeenCalled()
    finishMutation?.({ prunedIds: [] })
    await flushPromises()
    expect(historyMocks.queryNativeHistory).toHaveBeenCalledOnce()
  })

  it('keeps current results and skips a native query when the dirty flush fails', async () => {
    const summary = { id: 'dirty-failure', kind: 'text', title: '仍应显示', content: 'dirty', sourceApp: 'Editor', copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [summary], totalCount: 1 })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    historyMocks.queryNativeHistory.mockClear()

    historyMocks.applyNativeHistoryMutation.mockReset().mockResolvedValueOnce(null)
    await wrapper.get('[data-testid="manager-pin-dirty-failure"]').trigger('click')
    await wrapper.get('[data-testid="manager-search-input"]').setValue('dirty')
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    expect(historyMocks.queryNativeHistory).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('仍应显示')
  })

  it('builds canonical manager intersections while preserving the user search text', async () => {
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    historyMocks.queryNativeHistory.mockClear()

    await wrapper.get('[data-testid="manager-kind-code"]').trigger('click')
    await wrapper.get('[data-testid="manager-kind-image"]').trigger('click')
    await wrapper.get('[data-testid="manager-source-filter"]').setValue('Visual Studio Code')
    await wrapper.get('[data-testid="manager-pinned-filter"]').setValue('unpinned')
    const originalSearch = '  ＴＡＵＲＩ\u3000插件  '
    await wrapper.get('[data-testid="manager-search-input"]').setValue(originalSearch)
    await flushPromises()

    expect((wrapper.get('[data-testid="manager-search-input"]').element as HTMLInputElement).value).toBe(originalSearch)
    expect(historyMocks.queryNativeHistory).toHaveBeenLastCalledWith({
      text: 'tauri 插件',
      kinds: ['code', 'image'],
      sourceApps: ['Visual Studio Code'],
      collection: { mode: 'any' },
      pinned: false,
      limit: 50,
    })

    historyMocks.queryNativeHistory.mockClear()
    await wrapper.get('[data-testid="library-section-pinned"]').trigger('click')
    await flushPromises()
    expect(historyMocks.queryNativeHistory).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-manager-clip-id]')).toHaveLength(0)
  })

  it('does not paste a payload that returns after the app unmounts', async () => {
    const summary = { id: 'unmounted-payload', kind: 'text', title: '卸载摘要', content: 'summary', sourceApp: 'Editor', copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValueOnce({ items: [summary], totalCount: 1 })
    let finishPayload: ((result: Record<string, unknown>) => void) | undefined
    historyMocks.loadNativeClipPayload.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      finishPayload = resolve
    }))
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-clip-id="unmounted-payload"] .clip-primary').trigger('dblclick')
    await flushPromises()
    wrapper.unmount()

    finishPayload?.({ status: 'loaded', item: { ...summary, content: 'full', payloadLoaded: true } })
    await flushPromises()
    expect(clipboardMocks.pasteText).not.toHaveBeenCalled()
  })

  it('persists an unmatched native capture without polluting the active query or selection', async () => {
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
    const imageSummary = {
      id: 'filtered-image', kind: 'image', title: '当前图片', content: '', sourceApp: 'Snip',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], formats: ['image'], payloadLoaded: false,
    }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [imageSummary], totalCount: 1 })

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="filter-image"]').trigger('click')
    await flushPromises()
    historyMocks.queryNativeHistory.mockImplementation(() => new Promise(() => undefined))
    historyMocks.applyNativeHistoryMutation.mockClear()

    capture?.({
      kind: 'text',
      content: '不匹配图片筛选的捕获',
      capturedAt: '2026-07-19T10:01:00.000Z',
      sourceApp: 'Notepad',
    })
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledWith(expect.objectContaining({
      upserts: [expect.objectContaining({ content: '不匹配图片筛选的捕获' })],
    }))
    expect(wrapper.text()).not.toContain('不匹配图片筛选的捕获')
    expect(wrapper.get('[data-clip-id="filtered-image"]').classes()).toContain('is-selected')
  })

  it.each([
    [
      'uses a strictly parsed stored native policy before the first query',
      { maxRecords: 750, maxImageBytes: 134_217_728, retentionDays: 90 },
      { maxRecords: 750, maxImageBytes: 134_217_728, retentionDays: 90 },
    ],
    [
      'falls back atomically when the stored native policy has unknown keys',
      { maxRecords: 750, maxImageBytes: 134_217_728, retentionDays: 90, unexpected: true },
      { maxRecords: 500, maxImageBytes: 268_435_456, retentionDays: 30 },
    ],
    [
      'round-trips a non-preset native retention policy without coercing it',
      { maxRecords: 640, maxImageBytes: 201_326_592, retentionDays: 45 },
      { maxRecords: 640, maxImageBytes: 201_326_592, retentionDays: 45 },
    ],
    [
      'round-trips zero-valued native capacity policy fields',
      { maxRecords: 0, maxImageBytes: 0, retentionDays: 0 },
      { maxRecords: 0, maxImageBytes: 0, retentionDays: 0 },
    ],
  ])('%s', async (_label, storedPolicy, expectedPolicy) => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      settingsVersion: 4,
      onboardingCompleted: true,
      historyPolicy: storedPolicy,
    }))
    const order: string[] = []
    historyMocks.applyNativeHistoryMutation.mockReset().mockImplementation(async () => {
      order.push('policy')
      return { prunedIds: [] }
    })
    historyMocks.queryNativeHistory.mockReset().mockImplementation(async () => {
      order.push('query')
      return { items: [], totalCount: 0 }
    })

    const wrapper = mount(App)
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenNthCalledWith(1, {
      upserts: [],
      deleteIds: [],
      policy: expectedPolicy,
    })
    expect(order.indexOf('policy')).toBeLessThan(order.indexOf('query'))
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      historyPolicy: expectedPolicy,
      retentionDays: expectedPolicy.retentionDays === null ? 'forever' : String(expectedPolicy.retentionDays),
    })
    if (expectedPolicy.retentionDays === 45) {
      await wrapper.get('[data-testid="open-library"]').trigger('click')
      await flushPromises()
      await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
      expect((wrapper.get('[data-testid="retention-select"]').element as HTMLSelectElement).value).toBe('45')
      expect(wrapper.get('[data-testid="retention-select"]').text()).toContain('当前自定义 45 天')
    }

    wrapper.unmount()
    historyMocks.applyNativeHistoryMutation.mockClear()
    mount(App)
    await flushPromises()
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenNthCalledWith(1, {
      upserts: [],
      deleteIds: [],
      policy: expectedPolicy,
    })
  })

  it('mounts storage management only inside manager settings and loads health plus exact stats', async () => {
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('[data-testid="storage-manager"]').exists()).toBe(false)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="storage-manager"]').exists()).toBe(false)

    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="storage-manager"]').exists()).toBe(true)
    expect(historyMocks.getNativeHistoryHealth).toHaveBeenCalled()
    expect(historyMocks.getNativeStorageStats).toHaveBeenCalled()
  })

  it('atomically applies capacity policy before publishing settings and refreshed stats', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await flushPromises()

    historyMocks.applyNativeHistoryMutation.mockClear()
    let finishPolicy: ((result: { prunedIds: string[] }) => void) | undefined
    historyMocks.applyNativeHistoryMutation.mockImplementationOnce(() => new Promise((resolve) => {
      finishPolicy = resolve
    }))
    historyMocks.getNativeStorageStats.mockResolvedValue({
      ...defaultStorageStats,
      maxRecords: 750,
      maxImageBytes: 134_217_728,
    })

    await wrapper.get('[data-testid="storage-max-records"]').setValue('750')
    await wrapper.get('[data-testid="storage-max-image-bytes"]').setValue('134217728')
    await wrapper.get('[data-testid="storage-apply-policy"]').trigger('click')
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledWith({
      upserts: [],
      deleteIds: [],
      policy: { maxRecords: 750, maxImageBytes: 134_217_728, retentionDays: 30 },
    })
    expect(wrapper.get<HTMLButtonElement>('[data-testid="storage-apply-policy"]').element.disabled).toBe(true)
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').historyPolicy).toEqual({
      maxRecords: 500,
      maxImageBytes: 268_435_456,
      retentionDays: 30,
    })

    finishPolicy?.({ prunedIds: [] })
    await flushPromises()

    expect(wrapper.get<HTMLInputElement>('[data-testid="storage-max-records"]').element.value).toBe('750')
    expect(wrapper.get<HTMLInputElement>('[data-testid="storage-max-image-bytes"]').element.value).toBe('134217728')
    expect(wrapper.get<HTMLButtonElement>('[data-testid="storage-apply-policy"]').element.disabled).toBe(false)
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').historyPolicy).toEqual({
      maxRecords: 750,
      maxImageBytes: 134_217_728,
      retentionDays: 30,
    })
    expect(wrapper.get('[data-testid="storage-status"]').text()).toContain('容量限制已更新')
  })

  it('keeps the confirmed capacity policy when its atomic write fails', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await flushPromises()

    historyMocks.applyNativeHistoryMutation.mockClear()
    historyMocks.applyNativeHistoryMutation.mockResolvedValueOnce(null)
    await wrapper.get('[data-testid="storage-max-records"]').setValue('750')
    await wrapper.get('[data-testid="storage-max-image-bytes"]').setValue('134217728')
    await wrapper.get('[data-testid="storage-apply-policy"]').trigger('click')
    await flushPromises()

    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').historyPolicy).toEqual({
      maxRecords: 500,
      maxImageBytes: 268_435_456,
      retentionDays: 30,
    })
    expect(wrapper.get('[data-testid="storage-status"]').text()).toContain('未改变')
  })

  it('lets a custom native retention policy change to forever without keeping the hidden custom value', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      settingsVersion: 4,
      onboardingCompleted: true,
      historyPolicy: { maxRecords: 640, maxImageBytes: 201_326_592, retentionDays: 45 },
    }))
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')

    await wrapper.get('[data-testid="retention-select"]').setValue('forever')
    await flushPromises()

    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      retentionDays: 'forever',
      historyPolicy: { maxRecords: 640, maxImageBytes: 201_326_592, retentionDays: null },
    })
  })

  it('drains pending writes before opening a restore and rejects duplicate storage operations', async () => {
    const baseline = {
      id: 'drain-before-restore', kind: 'text', title: '待排空', content: 'pending', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false,
    }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [baseline], totalCount: 1 })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    let finishDrain: ((result: { prunedIds: string[] }) => void) | undefined
    historyMocks.applyNativeHistoryMutation.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      finishDrain = resolve
    }))
    await wrapper.get('[data-testid="manager-pin-drain-before-restore"]').trigger('click')
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="storage-prepare-restore"]').trigger('click')
    await wrapper.get('[data-testid="storage-backup"]').trigger('click')
    await flushPromises()

    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledOnce()
    expect(historyMocks.prepareNativeHistoryRestore).not.toHaveBeenCalled()
    expect(historyMocks.createNativeHistoryBackup).not.toHaveBeenCalled()

    finishDrain?.({ prunedIds: [] })
    await flushPromises()
    expect(historyMocks.prepareNativeHistoryRestore).toHaveBeenCalledOnce()
    expect(historyMocks.createNativeHistoryBackup).not.toHaveBeenCalled()
  })

  it('commits restore atomically, adopts all policy fields, ignores stale pages, and replays frozen captures', async () => {
    const token = 'a'.repeat(64)
    const baseline = {
      id: 'baseline-before-restore', kind: 'text', title: '恢复前基线', content: 'baseline', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false,
    }
    const stale = {
      id: 'stale-page', kind: 'text', title: '过期查询结果', content: 'stale', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:01:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false,
    }
    const restored = {
      id: 'restored-row', kind: 'text', title: '备份恢复结果', content: 'restored', sourceApp: 'Backup',
      copiedAt: '2026-07-19T11:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false,
    }
    let finishStaleQuery: ((page: { items: typeof stale[]; totalCount: number }) => void) | undefined
    let restoreCommitted = false
    historyMocks.queryNativeHistory.mockReset().mockImplementation(async (query) => {
      if (query.text === 'stale') {
        return new Promise((resolve) => { finishStaleQuery = resolve })
      }
      return restoreCommitted
        ? { items: [restored], totalCount: 1 }
        : { items: [baseline], totalCount: 1 }
    })
    historyMocks.prepareNativeHistoryRestore.mockResolvedValueOnce({
      status: 'prepared', token, currentCount: 1, incomingCount: 1, schemaVersion: 9,
    })
    const restoredStats = {
      ...defaultStorageStats,
      recordCount: 1,
      logicalBytes: 42,
      oldestCopiedAt: restored.copiedAt,
      newestCopiedAt: restored.copiedAt,
      maxRecords: 900,
      maxImageBytes: 536_870_912,
      retentionDays: 90,
    }
    let finishCommit: ((result: Record<string, unknown>) => void) | undefined
    historyMocks.commitNativeHistoryRestore.mockImplementationOnce(() => new Promise((resolve) => {
      finishCommit = (result) => {
        restoreCommitted = true
        resolve(result)
      }
    }))
    const restoreResult = {
        status: 'restored', importedCount: 1, schemaVersion: 9,
        policy: { maxRecords: 900, maxImageBytes: 536_870_912, retentionDays: 90 },
        stats: restoredStats,
    }
    historyMocks.getNativeStorageStats.mockImplementation(async () => (
      restoreCommitted ? restoredStats : defaultStorageStats
    ))
    let capture: ((payload: { kind: 'text'; content: string; capturedAt: string; sourceApp?: string }) => void) | undefined
    desktopMocks.connectNativeClipboard.mockImplementation(async (callback) => {
      capture = callback
      return () => undefined
    })

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="manager-search-input"]').setValue('stale')
    await flushPromises()
    expect(finishStaleQuery).toBeTypeOf('function')

    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="storage-prepare-restore"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="storage-restore-confirmation"]').exists()).toBe(true)

    await wrapper.get('[data-testid="storage-commit-restore"]').trigger('click')
    await flushPromises()
    expect(finishCommit).toBeTypeOf('function')

    capture?.({
      kind: 'text', content: '恢复期间捕获一', capturedAt: '2026-07-19T11:01:00.000Z', sourceApp: 'Notepad',
    })
    capture?.({
      kind: 'text', content: '恢复期间捕获二', capturedAt: '2026-07-19T11:02:00.000Z', sourceApp: 'Notepad',
    })
    await flushPromises()
    expect(historyMocks.applyNativeHistoryMutation.mock.calls.some(([mutation]) => (
      mutation.upserts?.some((item: { content?: string }) => item.content === '恢复期间捕获一')
      || mutation.upserts?.some((item: { content?: string }) => item.content === '恢复期间捕获二')
    ))).toBe(false)

    finishCommit?.(restoreResult)
    await flushPromises()
    finishStaleQuery?.({ items: [stale], totalCount: 1 })
    await flushPromises()

    expect(historyMocks.commitNativeHistoryRestore).toHaveBeenCalledWith(token)
    expect(ocrMocks.invalidateNativeClipboardOcr).toHaveBeenCalledOnce()
    expect(ocrMocks.invalidateNativeClipboardOcr.mock.invocationCallOrder[0])
      .toBeLessThan(historyMocks.commitNativeHistoryRestore.mock.invocationCallOrder[0])
    const replayMutations = historyMocks.applyNativeHistoryMutation.mock.calls.filter(([mutation]) => (
      mutation.upserts?.some((item: { content?: string }) => item.content === '恢复期间捕获一')
      || mutation.upserts?.some((item: { content?: string }) => item.content === '恢复期间捕获二')
    ))
    expect(replayMutations).toHaveLength(1)
    expect(replayMutations[0][0]).toEqual(expect.objectContaining({
      upserts: expect.arrayContaining([
        expect.objectContaining({ content: '恢复期间捕获一' }),
        expect.objectContaining({ content: '恢复期间捕获二' }),
      ]),
      policy: { maxRecords: 900, maxImageBytes: 536_870_912, retentionDays: 90 },
    }))
    const stored = JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')
    expect(stored.historyPolicy).toEqual({ maxRecords: 900, maxImageBytes: 536_870_912, retentionDays: 90 })
    expect(wrapper.text()).toContain('900')
    expect(wrapper.text()).not.toContain('过期查询结果')
    expect(historyMocks.getNativeHistoryHealth).toHaveBeenCalled()
    expect(historyMocks.getNativeStorageStats).toHaveBeenCalled()

    const queryCountBeforeLeavingSettings = historyMocks.queryNativeHistory.mock.calls.length
    await wrapper.get('[data-testid="library-section-all"]').trigger('click')
    await flushPromises()
    expect(historyMocks.queryNativeHistory.mock.calls.length)
      .toBeGreaterThanOrEqual(queryCountBeforeLeavingSettings + 1)
  })

  it('does not start restore when the native OCR lifecycle cannot be invalidated', async () => {
    const token = 'c'.repeat(64)
    historyMocks.prepareNativeHistoryRestore.mockResolvedValueOnce({
      status: 'prepared', token, currentCount: 1, incomingCount: 1, schemaVersion: 9,
    })
    ocrMocks.invalidateNativeClipboardOcr.mockResolvedValueOnce(false)

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="storage-prepare-restore"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="storage-commit-restore"]').trigger('click')
    await flushPromises()

    expect(ocrMocks.invalidateNativeClipboardOcr).toHaveBeenCalledOnce()
    expect(historyMocks.commitNativeHistoryRestore).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="storage-restore-confirmation"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('无法安全停止旧 OCR 任务')
  })

  it('fails closed when history changes after prepare and preserves the visible baseline plus old policy', async () => {
    const token = 'b'.repeat(64)
    const baseline = {
      id: 'baseline-on-failure', kind: 'text', title: '失败后仍保留', content: 'baseline', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, searchTerms: [], payloadLoaded: false,
    }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [baseline], totalCount: 1 })
    historyMocks.prepareNativeHistoryRestore.mockResolvedValueOnce({
      status: 'prepared', token, currentCount: 1, incomingCount: 3, schemaVersion: 9,
    })
    historyMocks.commitNativeHistoryRestore.mockResolvedValueOnce(null)
    let capture: ((payload: { kind: 'text'; content: string; capturedAt: string; sourceApp?: string }) => void) | undefined
    desktopMocks.connectNativeClipboard.mockImplementation(async (callback) => {
      capture = callback
      return () => undefined
    })

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="storage-prepare-restore"]').trigger('click')
    await flushPromises()
    capture?.({ kind: 'text', content: '失败期间捕获', capturedAt: '2026-07-19T10:02:00.000Z', sourceApp: 'Notepad' })
    await flushPromises()
    const interveningWrite = historyMocks.applyNativeHistoryMutation.mock.calls.find(([mutation]) => (
      mutation.upserts?.some((item: { content?: string }) => item.content === '失败期间捕获'
      )
    ))
    expect(interveningWrite).toBeDefined()

    await wrapper.get('[data-testid="storage-commit-restore"]').trigger('click')
    await flushPromises()
    expect(historyMocks.applyNativeHistoryMutation).toHaveBeenCalledWith(expect.objectContaining({
      upserts: [expect.objectContaining({ content: '失败期间捕获' })],
      policy: { maxRecords: 500, maxImageBytes: 268_435_456, retentionDays: 30 },
    }))
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').historyPolicy).toEqual({
      maxRecords: 500, maxImageBytes: 268_435_456, retentionDays: 30,
    })
    expect(wrapper.find('[data-testid="storage-restore-confirmation"]').exists()).toBe(false)

    await wrapper.get('[data-testid="library-section-all"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('失败后仍保留')
  })

  it('always releases storage busy state when a deferred capture cannot be reconstructed', async () => {
    let capture: ((payload: unknown) => void) | undefined
    desktopMocks.connectNativeClipboard.mockImplementation(async (callback) => {
      capture = callback
      return () => undefined
    })
    let finishBackup: ((result: { status: 'saved' }) => void) | undefined
    historyMocks.createNativeHistoryBackup.mockImplementationOnce(() => new Promise((resolve) => {
      finishBackup = resolve
    }))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="storage-backup"]').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLButtonElement>('[data-testid="storage-backup"]').element.disabled).toBe(true)

    capture?.(null)
    finishBackup?.({ status: 'saved' })
    await flushPromises()

    expect(wrapper.get<HTMLButtonElement>('[data-testid="storage-backup"]').element.disabled).toBe(false)
    expect(wrapper.get('[data-testid="storage-status"]').text()).toContain('稍后重试')
    historyMocks.getNativeStorageStats.mockClear()
    await wrapper.get('[data-testid="storage-refresh"]').trigger('click')
    await flushPromises()
    expect(historyMocks.getNativeStorageStats).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('keeps collection management in the manager and performs create, rename, filter, and delete', async () => {
    const work = {
      id: 'collection-work',
      name: '工作',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
      sortOrder: 0,
    }
    const renamed = { ...work, name: '项目', updatedAt: '2026-07-19T10:01:00.000Z' }
    const personal = {
      id: 'collection-personal',
      name: '个人',
      createdAt: '2026-07-19T10:02:00.000Z',
      updatedAt: '2026-07-19T10:02:00.000Z',
      sortOrder: 1,
    }
    historyMocks.listNativeHistoryCollections.mockResolvedValueOnce([work])
    historyMocks.createNativeHistoryCollection.mockResolvedValueOnce(personal)
    historyMocks.renameNativeHistoryCollection.mockResolvedValueOnce(renamed)
    historyMocks.deleteNativeHistoryCollection.mockResolvedValueOnce({ affectedCount: 2 })

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.find('[data-testid="manager-collections"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="new-snippet"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="manager-bulk-toolbar"]').exists()).toBe(false)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="manager-collections"]').text()).toContain('工作')

    await wrapper.get('[data-testid="manager-collection-collection-work"]').trigger('click')
    await flushPromises()
    expect(historyMocks.queryNativeHistory).toHaveBeenLastCalledWith(expect.objectContaining({
      collection: { mode: 'collection', id: 'collection-work' },
    }))

    await wrapper.get('[data-testid="manager-create-collection"]').trigger('click')
    await wrapper.get('[data-testid="manager-collection-name"]').setValue('  个人  ')
    await wrapper.get('[data-testid="manager-save-collection"]').trigger('click')
    await flushPromises()
    expect(historyMocks.createNativeHistoryCollection).toHaveBeenCalledWith('个人')
    expect(wrapper.get('[data-testid="manager-collections"]').text()).toContain('个人')

    await wrapper.get('[data-testid="manager-rename-collection-collection-work"]').trigger('click')
    await wrapper.get('[data-testid="manager-collection-name"]').setValue(' 项目 ')
    await wrapper.get('[data-testid="manager-save-collection"]').trigger('click')
    await flushPromises()
    expect(historyMocks.renameNativeHistoryCollection).toHaveBeenCalledWith('collection-work', '项目')
    expect(wrapper.get('[data-testid="manager-collections"]').text()).toContain('项目')

    await wrapper.get('[data-testid="manager-delete-collection-collection-work"]').trigger('click')
    expect(wrapper.get('[data-testid="manager-collection-delete-confirmation"]').text()).toContain('未归类')
    await wrapper.get('[data-testid="manager-confirm-delete-collection"]').trigger('click')
    await flushPromises()
    expect(historyMocks.deleteNativeHistoryCollection).toHaveBeenCalledWith('collection-work')
    expect(wrapper.get('[data-testid="manager-collection-unfiled"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-testid="manager-collections"]').text()).not.toContain('项目')
  })

  it('keeps manager focus separate from a frozen all-matching selection and preserves failure state', async () => {
    const newest = {
      id: 'selection-newest', kind: 'text', title: '最新', content: 'new', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:02:00.000Z', pinned: false, permanent: false,
      searchTerms: [], payloadLoaded: false,
    }
    const older = {
      id: 'selection-older', kind: 'code', title: '较早', content: 'old', sourceApp: 'IDE',
      copiedAt: '2026-07-19T10:01:00.000Z', pinned: true, permanent: false,
      searchTerms: [], payloadLoaded: false,
    }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({
      items: [newest, older],
      totalCount: 10_000,
    })

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    const list = wrapper.get('.manager-list')
    const first = wrapper.get('[data-manager-clip-id="selection-newest"]')
    const second = wrapper.get('[data-manager-clip-id="selection-older"]')
    expect(list.attributes('role')).toBe('listbox')
    expect(list.attributes('aria-multiselectable')).toBe('true')
    expect(first.attributes('role')).toBe('option')
    expect(first.attributes('aria-selected')).toBe('false')

    const composingSpace = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' })
    Object.defineProperty(composingSpace, 'isComposing', { value: true })
    first.element.dispatchEvent(composingSpace)
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('0')

    const search = wrapper.get('[data-testid="manager-search-input"]')
    const nativeInputSelectAll = new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'a', ctrlKey: true,
    })
    search.element.dispatchEvent(nativeInputSelectAll)
    expect(nativeInputSelectAll.defaultPrevented).toBe(false)
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('0')

    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    list.element.append(editable)
    const nativeEditableSelectAll = new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'a', ctrlKey: true,
    })
    editable.dispatchEvent(nativeEditableSelectAll)
    expect(nativeEditableSelectAll.defaultPrevented).toBe(false)
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('0')
    editable.remove()

    await first.trigger('focus')
    await first.trigger('keydown', { key: ' ' })
    expect(first.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('1')

    await second.trigger('focus')
    await second.trigger('keydown', { key: ' ', shiftKey: true })
    expect(first.attributes('aria-selected')).toBe('true')
    expect(second.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('2')

    await first.trigger('focus')
    await first.trigger('keydown', { key: 'a', ctrlKey: true })
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('10000')
    await first.trigger('keydown', { key: ' ' })
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('9999')

    historyMocks.applyNativeHistoryBatch.mockReset().mockResolvedValueOnce(null)
    await wrapper.get('[data-testid="manager-pin"]').trigger('click')
    await flushPromises()
    expect(historyMocks.applyNativeHistoryBatch).toHaveBeenCalledWith({
      mode: 'query',
      query: {
        text: '', kinds: [], sourceApps: [], collection: { mode: 'any' },
      },
      upperBound: { copiedAt: newest.copiedAt, id: newest.id },
      excludedIds: [newest.id],
    }, { type: 'setPinned', pinned: true })
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('9999')
    expect(document.activeElement).toBe(first.element)

    await search.setValue('仍保留')
    await first.trigger('focus')
    await first.trigger('keydown', { key: ' ' })
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('1')
    await first.trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('0')
    expect((search.element as HTMLInputElement).value).toBe('仍保留')
    await first.trigger('keydown', { key: 'Escape' })
    expect((search.element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(true)
    await first.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('closes a successful batch-delete confirmation and focuses the surviving visual position', async () => {
    const first = {
      id: 'batch-delete-first', kind: 'text', title: '第一条', content: 'first', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:02:00.000Z', pinned: false, permanent: false,
      searchTerms: [], payloadLoaded: false,
    }
    const second = {
      id: 'batch-delete-second', kind: 'text', title: '第二条', content: 'second', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:01:00.000Z', pinned: false, permanent: false,
      searchTerms: [], payloadLoaded: false,
    }
    let deleted = false
    historyMocks.queryNativeHistory.mockReset().mockImplementation(async () => ({
      items: deleted ? [second] : [first, second],
      totalCount: deleted ? 1 : 2,
    }))
    historyMocks.applyNativeHistoryBatch.mockReset().mockImplementation(async () => {
      deleted = true
      return { matchedCount: 1, changedCount: 1, deletedCount: 1, prunedIds: [] }
    })

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    const row = wrapper.get('[data-manager-clip-id="batch-delete-first"]')
    await row.trigger('focus')
    await row.trigger('keydown', { key: ' ' })
    await wrapper.get('[data-testid="manager-delete"]').trigger('click')
    expect(wrapper.find('[data-testid="manager-delete-confirmation"]').exists()).toBe(true)

    await wrapper.get('[data-testid="manager-confirm-delete"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="manager-delete-confirmation"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('0')
    expect(wrapper.find('[data-manager-clip-id="batch-delete-first"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-manager-clip-id="batch-delete-second"]').element)
    wrapper.unmount()
  })

  it('clears manager selection when an ordinary selected row is deleted directly', async () => {
    const clip = {
      id: 'single-selected-delete', kind: 'text', title: '待删除', content: 'ordinary', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, permanent: false,
      searchTerms: [], payloadLoaded: false,
    }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [clip], totalCount: 1 })

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()
    const row = wrapper.get('[data-manager-clip-id="single-selected-delete"]')
    await row.trigger('focus')
    await row.trigger('keydown', { key: ' ' })
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('1')

    await wrapper.get('[data-testid="manager-delete-single-selected-delete"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('0')
    expect(wrapper.find('[data-manager-clip-id="single-selected-delete"]').exists()).toBe(false)
    expect(historyMocks.applyNativeHistoryBatch).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('flushes a pending row mutation before one native batch and its canonical requery', async () => {
    const clip = {
      id: 'batch-order', kind: 'text', title: '顺序', content: 'order', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, permanent: false,
      searchTerms: [], payloadLoaded: false,
    }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [clip], totalCount: 1 })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    const order: string[] = []
    let finishFlush: ((value: { prunedIds: string[] }) => void) | undefined
    historyMocks.applyNativeHistoryMutation.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      order.push('flush')
      finishFlush = resolve
    }))
    historyMocks.applyNativeHistoryBatch.mockReset().mockImplementationOnce(async () => {
      order.push('batch')
      return { matchedCount: 1, changedCount: 1, deletedCount: 0, prunedIds: [] }
    })
    historyMocks.queryNativeHistory.mockClear()

    await wrapper.get('[data-testid="manager-pin-batch-order"]').trigger('click')
    await wrapper.get('[data-manager-clip-id="batch-order"]').trigger('focus')
    await wrapper.get('[data-manager-clip-id="batch-order"]').trigger('keydown', { key: ' ' })
    await wrapper.get('[data-testid="manager-unpin"]').trigger('click')
    await flushPromises()
    expect(order).toEqual(['flush'])
    expect(historyMocks.applyNativeHistoryBatch).not.toHaveBeenCalled()
    expect(historyMocks.queryNativeHistory).not.toHaveBeenCalled()

    finishFlush?.({ prunedIds: [] })
    await flushPromises()
    expect(order).toEqual(['flush', 'batch'])
    expect(historyMocks.applyNativeHistoryBatch).toHaveBeenCalledOnce()
    expect(historyMocks.queryNativeHistory).toHaveBeenCalledOnce()
  })

  it('does not let an operation refresh overwrite a newer manager query', async () => {
    const baseline = {
      id: 'operation-baseline', kind: 'text', title: '初始结果', content: 'base', sourceApp: 'Editor',
      copiedAt: '2026-07-19T10:00:00.000Z', pinned: false, permanent: false,
      searchTerms: [], payloadLoaded: false,
    }
    const stale = { ...baseline, id: 'operation-stale', title: '过期操作结果' }
    const latest = { ...baseline, id: 'operation-latest', title: '最新查询结果' }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [baseline], totalCount: 1 })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    let finishBatch: ((value: { matchedCount: number; changedCount: number; deletedCount: number; prunedIds: string[] }) => void) | undefined
    let finishStaleRefresh: ((value: { items: typeof stale[]; totalCount: number }) => void) | undefined
    historyMocks.applyNativeHistoryBatch.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      finishBatch = resolve
    }))
    historyMocks.queryNativeHistory.mockReset().mockImplementation((query) => {
      if (query.text === 'older query') {
        return new Promise((resolve) => { finishStaleRefresh = resolve })
      }
      if (query.text === 'latest query') return Promise.resolve({ items: [latest], totalCount: 1 })
      return Promise.resolve({ items: [baseline], totalCount: 1 })
    })

    const row = wrapper.get('[data-manager-clip-id="operation-baseline"]')
    await row.trigger('focus')
    await row.trigger('keydown', { key: ' ' })
    await wrapper.get('[data-testid="manager-pin"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="manager-search-input"]').setValue('older query')
    finishBatch?.({ matchedCount: 1, changedCount: 1, deletedCount: 0, prunedIds: [] })
    await flushPromises()
    expect(finishStaleRefresh).toBeTypeOf('function')

    await wrapper.get('[data-testid="manager-search-input"]').setValue('latest query')
    finishStaleRefresh?.({ items: [stale], totalCount: 1 })
    await flushPromises()
    expect(wrapper.text()).toContain('最新查询结果')
    expect(wrapper.text()).not.toContain('过期操作结果')
  })

  it('preserves snippet drafts after failure and resets consecutive create sessions', async () => {
    const permanent = {
      id: 'permanent-snippet', kind: 'text', title: '常用地址', content: '上海市', sourceApp: 'QuickPaste',
      copiedAt: '2026-07-19T10:00:00.000Z', updatedAt: '2026-07-19T10:01:00.000Z',
      pinned: true, permanent: true, formats: ['text'], searchTerms: [], payloadLoaded: false,
    }
    historyMocks.queryNativeHistory.mockReset().mockResolvedValue({ items: [permanent], totalCount: 1 })
    historyMocks.loadNativeClipPayload.mockResolvedValue({
      status: 'loaded', item: { ...permanent, searchTerms: ['上海市'], payloadLoaded: true },
    })

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="new-snippet"]').trigger('click')
    await wrapper.get('[data-testid="snippet-title"]').setValue(' 临时片段 ')
    await wrapper.get('[data-testid="snippet-content"]').setValue('保留正文')
    await wrapper.get('[data-testid="snippet-save"]').trigger('click')
    await flushPromises()
    expect(historyMocks.saveNativeHistorySnippet).toHaveBeenCalledWith({
      title: '临时片段', content: '保留正文', kind: 'text',
    })
    expect(wrapper.find('[data-testid="snippet-editor"]').exists()).toBe(true)
    expect((wrapper.get('[data-testid="snippet-content"]').element as HTMLTextAreaElement).value).toBe('保留正文')

    await wrapper.get('[data-testid="snippet-cancel"]').trigger('click')
    await wrapper.get('[data-testid="new-snippet"]').trigger('click')
    expect((wrapper.get('[data-testid="snippet-title"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('[data-testid="snippet-content"]').element as HTMLTextAreaElement).value).toBe('')
    await wrapper.get('[data-testid="snippet-cancel"]').trigger('click')

    await wrapper.get('[data-testid="manager-edit-snippet-permanent-snippet"]').trigger('click')
    await flushPromises()
    expect(historyMocks.loadNativeClipPayload).toHaveBeenCalledWith('permanent-snippet')
    expect((wrapper.get('[data-testid="snippet-title"]').element as HTMLInputElement).value).toBe('常用地址')
    expect((wrapper.get('[data-testid="snippet-content"]').element as HTMLTextAreaElement).value).toBe('上海市')
    historyMocks.saveNativeHistorySnippet.mockResolvedValueOnce({
      ...permanent,
      title: '常用地址（更新）',
      content: '北京市',
      updatedAt: '2026-07-19T10:03:00.000Z',
      searchTerms: ['北京市'],
      payloadLoaded: true,
    })
    await wrapper.get('[data-testid="snippet-title"]').setValue('常用地址（更新）')
    await wrapper.get('[data-testid="snippet-content"]').setValue('北京市')
    await wrapper.get('[data-testid="snippet-save"]').trigger('click')
    await flushPromises()
    expect(historyMocks.saveNativeHistorySnippet).toHaveBeenLastCalledWith({
      id: 'permanent-snippet', title: '常用地址（更新）', content: '北京市', kind: 'text',
    })
    expect(wrapper.find('[data-testid="snippet-editor"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
