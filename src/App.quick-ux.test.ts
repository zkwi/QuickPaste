import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'

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

const qrMocks = vi.hoisted(() => ({
  detectNativeClipQr: vi.fn().mockResolvedValue([]),
}))

const windowMocks = vi.hoisted(() => ({
  observeWindowMaximizedState: vi.fn().mockResolvedValue(() => undefined),
  runWindowAction: vi.fn().mockResolvedValue(true),
  setQuickPanelPinned: vi.fn().mockResolvedValue(true),
  setWindowMode: vi.fn().mockResolvedValue(true),
}))

vi.mock('./platform/clipboard', () => clipboardMocks)
vi.mock('./platform/qr', () => qrMocks)
vi.mock('./platform/system', () => systemMocks)
vi.mock('./platform/window', () => windowMocks)

function dispatchKey(
  target: Element,
  key: string,
  options: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    ...options,
  })
  target.dispatchEvent(event)
  return event
}

function dispatchContextMenu(
  target: Element,
  options: MouseEventInit = {},
) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 90,
    ...options,
  })
  target.dispatchEvent(event)
  return event
}

describe('quick panel high-frequency interaction', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({ onboardingCompleted: true }))
    vi.clearAllMocks()
    qrMocks.detectNativeClipQr.mockResolvedValue([])
    wrapper = mount(App, { attachTo: document.body })
  })

  afterEach(() => {
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('navigates results from search without stealing text-editing keys', async () => {
    const search = wrapper.get('[data-testid="search-input"]')

    dispatchKey(search.element, 'ArrowDown')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-clip-id="clip-2"]').classes()).toContain('is-selected')

    dispatchKey(search.element, 'PageDown')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-clip-id="clip-7"]').classes()).toContain('is-selected')

    dispatchKey(search.element, 'ArrowUp', { isComposing: true })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-clip-id="clip-7"]').classes()).toContain('is-selected')

    const selectedPrimary = wrapper.get('[data-clip-id="clip-7"] .clip-primary')
    dispatchKey(selectedPrimary.element, 'Home')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-clip-id="clip-1"]').classes()).toContain('is-selected')

    dispatchKey(wrapper.get('[data-clip-id="clip-1"] .clip-primary').element, 'End')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-clip-id="clip-10"]').classes()).toContain('is-selected')

    dispatchKey(search.element, 'Home')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-clip-id="clip-10"]').classes()).toContain('is-selected')
    expect(wrapper.get('.selection-announcement').text()).toContain('10 / 10')
  })

  it('calls permanent snippets with semicolon and selects an exact @source suggestion', async () => {
    wrapper.unmount()
    const copiedAt = '2026-07-21T00:00:00.000Z'
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([
      {
        id: 'snippet-wechat', kind: 'text', title: '开票信息', content: '抬头与税号', sourceApp: '微信',
        copiedAt, updatedAt: copiedAt, pinned: false, permanent: true, searchTerms: [], formats: ['text'],
      },
      {
        id: 'ordinary-wechat', kind: 'text', title: '普通消息', content: '日常内容', sourceApp: '微信',
        copiedAt, pinned: false, permanent: false, searchTerms: [], formats: ['text'],
      },
      {
        id: 'snippet-feishu', kind: 'text', title: '开票流程', content: '审批流程', sourceApp: '飞书',
        copiedAt, updatedAt: copiedAt, pinned: false, permanent: true, searchTerms: [], formats: ['text'],
      },
    ]))
    wrapper = mount(App, { attachTo: document.body })
    const search = wrapper.get('[data-testid="search-input"]')

    await search.setValue(';开票')
    expect(wrapper.findAll('[data-clip-id]').map((row) => row.attributes('data-clip-id')))
      .toEqual(['snippet-wechat', 'snippet-feishu'])
    expect(wrapper.get('[data-testid="snippet-mode-indicator"]').text()).toContain('永久片段')

    await search.setValue('@微')
    expect(wrapper.get('[data-testid="source-suggestions"]').text()).toContain('微信')
    dispatchKey(search.element, 'Enter', { isComposing: true })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="source-filter-chip"]').exists()).toBe(false)

    dispatchKey(search.element, 'Enter')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="source-filter-chip"]').text()).toContain('微信')
    expect(wrapper.findAll('[data-clip-id]').map((row) => row.attributes('data-clip-id')))
      .toEqual(['snippet-wechat', 'ordinary-wechat'])

    dispatchKey(search.element, 'Backspace')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="source-filter-chip"]').exists()).toBe(false)
  })

  it('lets focused controls handle Enter and reserves paste for search or a result', async () => {
    dispatchKey(wrapper.get('[data-testid="filter-image"]').element, 'Enter')
    await flushPromises()
    expect(clipboardMocks.pasteText).not.toHaveBeenCalled()
    expect(clipboardMocks.pasteImage).not.toHaveBeenCalled()

    dispatchKey(wrapper.get('[data-testid="search-input"]').element, 'Enter')
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledOnce()
    expect(clipboardMocks.pasteText).toHaveBeenCalledWith(expect.stringContaining('Windows 版本'))
  })

  it('moves a double-clicked record to the top as the latest item', async () => {
    const originalCopiedAt = JSON.parse(localStorage.getItem('mypaste-demo-items-v1') ?? '[]')
      .find((item: { id: string }) => item.id === 'clip-3')?.copiedAt

    await wrapper.get('[data-clip-id="clip-3"] .clip-primary').trigger('dblclick')
    await flushPromises()

    expect(wrapper.findAll('[data-clip-id]')[0].attributes('data-clip-id')).toBe('clip-3')
    const stored = JSON.parse(localStorage.getItem('mypaste-demo-items-v1') ?? '[]')
    expect(stored[0].id).toBe('clip-3')
    expect(stored[0].copiedAt).not.toBe(originalCopiedAt)
  })

  it('keeps quick surfaces free of copy and delete actions while retaining row pinning', async () => {
    const first = wrapper.get('[data-clip-id="clip-1"]')
    const primary = first.get('.clip-primary')
    const pin = first.get('[data-testid="pin-clip-clip-1"]')

    expect(pin.attributes('aria-pressed')).toBe('false')
    expect(pin.attributes('title')).toContain('固定内容')
    expect(primary.attributes('title')).toBeUndefined()
    expect(primary.attributes('aria-keyshortcuts')).toContain('Alt+1')
    expect(first.get('[data-testid="preview-clip-clip-1"]').attributes('title')).toContain('Space')
    expect(first.find('[data-testid="delete-clip-clip-1"]').exists()).toBe(false)

    await pin.trigger('click')
    expect(pin.attributes('aria-pressed')).toBe('true')

    dispatchKey(primary.element, 'c', { ctrlKey: true })
    dispatchKey(primary.element, 'Delete')
    await flushPromises()
    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(wrapper.find('[data-clip-id="clip-1"]').exists()).toBe(true)

    dispatchContextMenu(first.element)
    await wrapper.vm.$nextTick()
    const menu = wrapper.get('[data-testid="clip-context-menu"]')
    expect(menu.find('[data-testid="context-copy"]').exists()).toBe(false)
    expect(menu.find('[data-testid="context-pin"]').exists()).toBe(false)
    expect(menu.find('[data-testid="context-delete"]').exists()).toBe(false)

    await menu.get('[data-testid="context-preview"]').trigger('click')
    const preview = wrapper.get('[data-testid="preview-panel"]')
    expect(preview.find('[data-testid="preview-copy"]').exists()).toBe(false)
    expect(preview.find('[data-testid="preview-pin"]').exists()).toBe(false)
    expect(preview.find('a[href]').exists()).toBe(false)
  })

  it('routes rich preserve/plain and ordered files through their typed paste adapters', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([
      {
        id: 'rich', kind: 'text', title: 'Rich', content: 'formatted text', sourceApp: 'Word',
        copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [],
        formats: ['text', 'html', 'rtf'], html: '<strong>formatted text</strong>', rtfBase64: 'e1xydGYxXGFuc2k=',
      },
      {
        id: 'files', kind: 'file', title: 'Files', content: 'first.txt\nsecond.txt', sourceApp: 'Explorer',
        copiedAt: '2026-07-19T01:00:00.000Z', pinned: false, searchTerms: [], formats: ['files'],
        files: [
          { path: 'C:\\Fixtures\\first.txt', name: 'first.txt', directory: false, exists: true },
          { path: 'C:\\Fixtures\\second.txt', name: 'second.txt', directory: false, exists: true },
        ],
      },
    ]))
    wrapper = mount(App, { attachTo: document.body })

    dispatchContextMenu(wrapper.get('[data-clip-id="rich"]').element)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-paste-preserve"]').trigger('click')
    await flushPromises()
    expect(clipboardMocks.pasteFormats).toHaveBeenCalledWith(
      'formatted text', '<strong>formatted text</strong>', 'e1xydGYxXGFuc2k=',
    )

    dispatchContextMenu(wrapper.get('[data-clip-id="rich"]').element)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-paste-plain"]').trigger('click')
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledWith('formatted text')
    expect(clipboardMocks.pasteText).not.toHaveBeenCalledWith(expect.stringContaining('<strong>'))

    await wrapper.get('[data-clip-id="files"] .clip-primary').trigger('dblclick')
    await flushPromises()
    expect(clipboardMocks.pasteFiles).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'C:\\Fixtures\\first.txt' }),
      expect.objectContaining({ path: 'C:\\Fixtures\\second.txt' }),
    ])
  })

  it('blocks every quick paste entry point when a recorded file is missing', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'missing-file', kind: 'file', title: 'Missing', content: 'missing.txt', sourceApp: 'Explorer',
      copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [], formats: ['files'],
      files: [{ path: 'C:\\Fixtures\\missing.txt', name: 'missing.txt', directory: false, exists: false }],
    }]))
    wrapper = mount(App, { attachTo: document.body })
    const primary = wrapper.get('[data-clip-id="missing-file"] .clip-primary')

    await primary.trigger('dblclick')
    dispatchKey(primary.element, 'Enter')
    dispatchKey(primary.element, '1', { altKey: true })
    await flushPromises()
    expect(clipboardMocks.pasteFiles).not.toHaveBeenCalled()

    dispatchContextMenu(primary.element)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="context-paste"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="context-preview"]').trigger('click')
    expect(wrapper.get('[data-testid="preview-paste"]').attributes('disabled')).toBeDefined()
  })

  it('shows rich format and omission metadata as inert text only', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'rich-warning', kind: 'text', title: 'Untrusted rich text',
      content: '<img data-probe="live" src="x"> visible text', sourceApp: 'Word',
      copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [],
      formats: ['text', 'html'], omittedFormats: ['rtf'], html: '<img data-probe="html" src="x">',
    }]))
    wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[data-testid="preview-clip-rich-warning"]').trigger('click')
    const preview = wrapper.get('[data-testid="preview-panel"]')
    expect(preview.find('[data-probe]').exists()).toBe(false)
    expect(preview.findAll('.format-badge').map((badge) => badge.text())).toEqual(['TEXT', 'HTML'])
    expect(preview.get('.format-omission-warning').text()).toContain('RTF')
    expect(preview.text()).toContain('<img data-probe="live" src="x"> visible text')
  })

  it('shows local OCR progress in the list and recognized text in an image preview', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'ocr-visible', kind: 'image', title: 'Invoice', content: 'clipboard image', sourceApp: 'Snipping Tool',
      copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [], formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==', imageHash: 'a'.repeat(64),
      omittedFormats: ['object'],
      ocrStatus: 'completed', ocrText: 'Invoice number 2026-001',
    }]))
    wrapper = mount(App, { attachTo: document.body })

    expect(wrapper.get('[data-clip-id="ocr-visible"] .clip-content').text()).toBe('InvoiceOCR 已完成')
    expect(wrapper.get('[data-clip-id="ocr-visible"] .ocr-status').text()).toContain('OCR 已完成')
    await wrapper.get('[data-testid="preview-clip-ocr-visible"]').trigger('click')

    const preview = wrapper.get('[data-testid="preview-panel"]')
    expect(preview.get('.preview-body').classes()).toContain('image-preview-body')
    expect(preview.find('.image-preview-heading').exists()).toBe(false)
    expect(preview.get('.preview-image-title').text()).toBe('Invoice')
    expect(preview.find('.format-badge').exists()).toBe(false)
    expect(preview.find('.format-omission-warning').exists()).toBe(false)
    const ocrDetails = preview.get('[data-testid="preview-ocr-text"]')
    expect(ocrDetails.element.tagName).toBe('DETAILS')
    expect(ocrDetails.attributes('open')).toBeUndefined()
    expect(ocrDetails.text()).toContain('Invoice number 2026-001')

    await ocrDetails.get('[data-testid="copy-ocr-text"]').trigger('click')
    expect(clipboardMocks.copyText).toHaveBeenCalledWith('Invoice number 2026-001')

    await ocrDetails.get('[data-testid="paste-ocr-text"]').trigger('click')
    expect(clipboardMocks.pasteText).toHaveBeenCalledWith('Invoice number 2026-001')
  })

  it('recognizes local QR text in an image preview and opens only safe web links', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'qr-visible', kind: 'image', title: '付款码截图', content: 'clipboard image', sourceApp: '截图工具',
      copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [], formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==', imageHash: 'b'.repeat(64),
    }]))
    qrMocks.detectNativeClipQr.mockResolvedValueOnce([
      'https://quickpaste.example/docs',
      'javascript:alert(1)',
    ])
    wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[data-testid="preview-clip-qr-visible"]').trigger('click')
    await flushPromises()

    const results = wrapper.get('[data-testid="preview-qr-results"]')
    expect(results.text()).toContain('https://quickpaste.example/docs')
    expect(results.text()).toContain('javascript:alert(1)')
    expect(results.find('[data-testid="open-qr-result-0"]').exists()).toBe(true)
    expect(results.find('[data-testid="open-qr-result-1"]').exists()).toBe(false)

    await results.get('[data-testid="copy-qr-result-1"]').trigger('click')
    expect(clipboardMocks.copyText).toHaveBeenCalledWith('javascript:alert(1)')

    await results.get('[data-testid="open-qr-result-0"]').trigger('click')
    expect(systemMocks.openExternalLink).toHaveBeenCalledWith('https://quickpaste.example/docs')
    expect(qrMocks.detectNativeClipQr).toHaveBeenCalledWith('qr-visible')
  })

  it('runs manager-only typed system actions without leaving or mutating the manager', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([
      {
        id: 'link', kind: 'link', title: 'Docs', content: 'https://example.com/docs', sourceApp: 'Edge',
        copiedAt: '2026-07-19T03:00:00.000Z', pinned: false, searchTerms: [], formats: ['text'],
      },
      {
        id: 'file', kind: 'file', title: 'Reports', content: 'first.txt\nmissing.txt\nsecond.txt', sourceApp: 'Explorer',
        copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [], formats: ['files'],
        files: [
          { path: 'C:\\Fixtures\\first.txt', name: 'first.txt', directory: false, exists: true },
          { path: 'C:\\Fixtures\\missing.txt', name: 'missing.txt', directory: false, exists: false },
          { path: 'C:\\Fixtures\\second.txt', name: 'second.txt', directory: false, exists: true },
        ],
      },
      {
        id: 'image', kind: 'image', title: 'Image', content: 'image', sourceApp: 'Snipping Tool',
        copiedAt: '2026-07-19T01:00:00.000Z', pinned: false, searchTerms: [], formats: ['image'],
        imageUrl: 'data:image/png;base64,AA==',
      },
    ]))
    systemMocks.saveClipboardImage.mockResolvedValueOnce('cancelled')
    wrapper = mount(App, { attachTo: document.body })

    expect(wrapper.get('[data-testid="quick-file-availability-file"]').text()).toContain('2 / 3')
    await wrapper.get('[data-testid="preview-clip-file"]').trigger('click')
    expect(wrapper.get('[data-testid="preview-file-list"]').findAll('li').map((entry) => ({
      text: entry.text(),
      exists: entry.attributes('data-file-exists'),
    }))).toEqual([
      { text: expect.stringContaining('first.txt'), exists: 'true' },
      { text: expect.stringContaining('missing.txt'), exists: 'false' },
      { text: expect.stringContaining('second.txt'), exists: 'true' },
    ])
    await wrapper.get('[data-testid="close-preview"]').trigger('click')
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    expect(wrapper.get('[data-testid="manager-file-availability-file"]').text()).toContain('2 / 3')

    dispatchContextMenu(wrapper.get('[data-manager-clip-id="link"]').element)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-open-link"]').trigger('click')
    await flushPromises()
    expect(systemMocks.openExternalLink).toHaveBeenCalledWith('https://example.com/docs')

    dispatchContextMenu(wrapper.get('[data-manager-clip-id="file"]').element)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-open-file"]').trigger('click')
    await flushPromises()
    expect(systemMocks.openFilePath.mock.calls).toEqual([
      ['C:\\Fixtures\\first.txt'],
      ['C:\\Fixtures\\second.txt'],
    ])

    dispatchContextMenu(wrapper.get('[data-manager-clip-id="file"]').element)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-reveal-file"]').trigger('click')
    await flushPromises()
    expect(systemMocks.revealFilePath.mock.calls).toEqual([
      ['C:\\Fixtures\\first.txt'],
      ['C:\\Fixtures\\second.txt'],
    ])

    dispatchContextMenu(wrapper.get('[data-manager-clip-id="image"]').element)
    await wrapper.vm.$nextTick()
    const toastCount = wrapper.findAll('.feedback-toast').length
    await wrapper.get('[data-testid="context-save-image"]').trigger('click')
    await flushPromises()
    expect(systemMocks.saveClipboardImage).toHaveBeenCalledWith('data:image/png;base64,AA==')
    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(true)
    expect(wrapper.findAll('.manager-row')).toHaveLength(3)
    expect(wrapper.findAll('.feedback-toast')).toHaveLength(toastCount)
  })

  it('drops a stale manager system-action result after returning to quick', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'link', kind: 'link', title: 'Docs', content: 'https://example.com/docs', sourceApp: 'Edge',
      copiedAt: '2026-07-19T03:00:00.000Z', pinned: false, searchTerms: [], formats: ['text'],
    }]))
    let finishOpen: ((result: boolean) => void) | undefined
    systemMocks.openExternalLink.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishOpen = resolve
    }))
    wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[data-testid="open-library"]').trigger('click')

    dispatchContextMenu(wrapper.get('[data-manager-clip-id="link"]').element)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-open-link"]').trigger('click')
    await wrapper.get('[data-testid="library-view"] .back-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(false)

    finishOpen?.(false)
    await flushPromises()
    expect(wrapper.find('.feedback-toast').exists()).toBe(false)
  })

  it('drops a pending manager system-action result after unmount', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'link', kind: 'link', title: 'Docs', content: 'https://example.com/docs', sourceApp: 'Edge',
      copiedAt: '2026-07-19T03:00:00.000Z', pinned: false, searchTerms: [], formats: ['text'],
    }]))
    let finishOpen: ((result: boolean) => void) | undefined
    systemMocks.openExternalLink.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishOpen = resolve
    }))
    wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    dispatchContextMenu(wrapper.get('[data-manager-clip-id="link"]').element)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="context-open-link"]').trigger('click')

    wrapper.unmount()
    finishOpen?.(false)
    await flushPromises()

    expect(document.querySelector('.feedback-toast')).toBeNull()
  })

  it('ignores repeated paste triggers while one paste is still in flight', async () => {
    let finishPaste: ((result: { copied: boolean; pasted: boolean; requiresElevation: boolean }) => void) | undefined
    clipboardMocks.pasteText.mockImplementationOnce(() => new Promise((resolve) => {
      finishPaste = resolve
    }))
    const search = wrapper.get('[data-testid="search-input"]')

    dispatchKey(search.element, 'Enter')
    dispatchKey(search.element, 'Enter')
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledTimes(1)

    finishPaste?.({ copied: true, pasted: true, requiresElevation: false })
    await flushPromises()
    dispatchKey(search.element, 'Enter')
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledTimes(2)
  })

  it('highlights case-insensitive literal matches in the single content line', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('TAURI security')

    const result = wrapper.get('[data-clip-id="clip-3"]')
    expect(result.findAll('.clip-title')).toHaveLength(0)
    expect(result.findAll('.clip-preview')).toHaveLength(0)
    expect(result.get('.clip-content').findAll('mark.search-highlight').map((mark) => mark.text())).toEqual(['tauri', 'security'])
    expect(result.get('.clip-content').text()).toBe('https://v2.tauri.app/security/capabilities/')
  })

  it('shows repeated title and body content only once in each compact result', () => {
    const result = wrapper.get('[data-clip-id="clip-1"]')

    expect(result.get('.clip-content').text()).toContain('Windows 版本')
    expect(result.findAll('.clip-title')).toHaveLength(0)
    expect(result.findAll('.clip-preview')).toHaveLength(0)
    expect(result.text().split('Windows 版本')).toHaveLength(2)
  })

  it('keeps a meaningful distinct title and body on the same compact line', () => {
    const row = wrapper.get('[data-clip-id="clip-1"]')
    const result = row.get('.clip-content')

    expect(result.text()).toMatch(/^周会跟进事项 · 今天的会议重点/)
    expect(row.findAll('.clip-content')).toHaveLength(1)
  })

  it('highlights a direct source-app match without changing its label', async () => {
    await wrapper.get('[data-testid="search-input"]').setValue('MICROSOFT')

    const source = wrapper.get('[data-clip-id="clip-3"] .source-name')
    expect(source.get('mark.search-highlight').text()).toBe('Microsoft')
    expect(source.text()).toBe('Microsoft Edge')
  })

  it('shows a captured application icon without disturbing source-name search highlighting', async () => {
    const sourceAppIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3voZ8QAAAABJRU5ErkJggg=='
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'clip-with-app-icon',
      kind: 'text',
      title: '带来源图标的内容',
      content: 'source app icon',
      sourceApp: 'Google Chrome',
      sourceAppIcon,
      copiedAt: '2026-07-18T08:00:00.000Z',
      pinned: false,
      searchTerms: [],
      color: '#337C74',
    }]))
    wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[data-testid="search-input"]').setValue('chrome')

    const result = wrapper.get('[data-clip-id="clip-with-app-icon"]')
    expect(result.get('.source-app-icon img').attributes('src')).toBe(sourceAppIcon)
    expect(result.get('.source-name mark.search-highlight').text()).toBe('Chrome')
  })

  it('highlights compatibility-equivalent text while preserving original glyphs', async () => {
    await wrapper.get('[data-testid="search-input"]').setValue('ＴＡＵＲＩ')

    const result = wrapper.get('[data-clip-id="clip-3"]')
    expect(result.get('.clip-content').findAll('mark.search-highlight').map((mark) => mark.text())).toEqual(['tauri'])
  })

  it('keeps contextual Unicode case folding consistent between filtering and highlighting', async () => {
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'clip-greek',
      kind: 'text',
      title: 'ΟΣ',
      content: 'Unicode contextual case',
      sourceApp: 'QA',
      copiedAt: '2026-07-18T08:00:00.000Z',
      pinned: false,
      searchTerms: [],
      color: '#337C74',
    }]))
    wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[data-testid="search-input"]').setValue('ΟΣ')

    const contentLine = wrapper.get('[data-clip-id="clip-greek"] .clip-content')
    expect(contentLine.get('mark.search-highlight').text()).toBe('ΟΣ')
    expect(contentLine.text()).toBe('ΟΣ')
  })

  it('centers a compact preview around a match near the end of long content', async () => {
    const content = `${'开头内容'.repeat(60)} needle ${'结尾内容'.repeat(60)}`
    wrapper.unmount()
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'clip-long',
      kind: 'text',
      title: '长正文',
      content,
      sourceApp: 'QA',
      copiedAt: '2026-07-18T08:00:00.000Z',
      pinned: false,
      searchTerms: [],
      color: '#337C74',
    }]))
    wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[data-testid="search-input"]').setValue('needle')

    const preview = wrapper.get('[data-clip-id="clip-long"] .clip-content')
    expect(preview.get('mark.search-highlight').text()).toBe('needle')
    expect(preview.text()).toMatch(/^….*needle.*…$/)
    expect(preview.text().length).toBeLessThan(content.length)
  })

  it('makes a pinyin-only search match visible without altering the original text', async () => {
    await wrapper.get('[data-testid="search-input"]').setValue('huiyi')

    const result = wrapper.get('[data-clip-id="clip-1"]')
    expect(result.findAll('mark.search-highlight')).toHaveLength(0)
    expect(result.get('.phonetic-match').text()).toContain('拼音命中')
    expect(result.text()).toContain('周会跟进事项')
  })

  it('keeps the first ten direct-paste hints and shortcuts in sync', async () => {
    const badges = wrapper.findAll('.quick-number')
    expect(badges).toHaveLength(10)
    expect(badges[0].text()).toBe('Alt 1')
    expect(badges[9].text()).toBe('Alt 0')
    expect(wrapper.get('[data-clip-id="clip-10"] .clip-primary').attributes('aria-keyshortcuts')).toContain('Alt+0')

    const search = wrapper.get('[data-testid="search-input"]')
    dispatchKey(search.element, '0', { altKey: true })
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenLastCalledWith(expect.stringContaining('问题已经收到'))

    dispatchKey(search.element, '1', { ctrlKey: true })
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenLastCalledWith(expect.stringContaining('Windows 版本'))

    const completedPastes = clipboardMocks.pasteText.mock.calls.length
    dispatchKey(search.element, '1', { altKey: true, ctrlKey: true })
    dispatchKey(search.element, '1', { altKey: true, shiftKey: true })
    await flushPromises()
    expect(clipboardMocks.pasteText).toHaveBeenCalledTimes(completedPastes)
  })

  it('deletes a focused manager result with Delete and keeps undo available', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const row = wrapper.get('[data-manager-clip-id="clip-2"]')
    ;(row.element as HTMLElement).focus()
    dispatchKey(row.element, 'Delete')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-manager-clip-id="clip-2"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="undo-delete"]').text()).toContain('撤销')
    expect(wrapper.get('.undo-toast').attributes('role')).toBe('status')

    await wrapper.get('[data-testid="undo-delete"]').trigger('click')
    expect(wrapper.find('[data-manager-clip-id="clip-2"]').exists()).toBe(true)
  })

  it('clears a transient search before Escape hides the panel', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('tauri')
    await wrapper.get('[data-testid="filter-code"]').trigger('click')

    dispatchKey(search.element, 'Escape')
    await wrapper.vm.$nextTick()
    expect((search.element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="filter-all"]').attributes('aria-pressed')).toBe('true')
    expect(windowMocks.runWindowAction).not.toHaveBeenCalled()

    dispatchKey(search.element, 'Escape')
    expect(windowMocks.runWindowAction).toHaveBeenCalledWith('close', undefined, expect.any(Function))
  })

  it('restores search focus after clearing and exposes a persistent panel toggle', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('tauri')
    expect(wrapper.findAll('mark.search-highlight').length).toBeGreaterThan(0)
    const clear = wrapper.get('[aria-label="清空搜索"]')
    ;(clear.element as HTMLElement).focus()
    await clear.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(search.element)
    expect(wrapper.findAll('mark.search-highlight')).toHaveLength(0)

    const pin = wrapper.get('[data-testid="pin-quick-panel"]')
    expect(pin.attributes('aria-pressed')).toBe('false')
    expect(pin.attributes('title')).toContain('面板常驻')
    expect(pin.find('svg').classes()).toContain('lucide-panel-top-open')
    await pin.trigger('click')
    expect(pin.attributes('aria-pressed')).toBe('true')
    expect(pin.attributes('title')).toContain('取消面板常驻')
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      quickPanelPinned: true,
    })
  })

  it('moves destination and manager access into the title bar without a redundant footer', () => {
    const chrome = wrapper.get('.panel-chrome')

    expect(wrapper.find('.panel-footer').exists()).toBe(false)
    expect(wrapper.find('.keyboard-legend').exists()).toBe(false)
    expect(chrome.find('[data-testid="paste-target"]').exists()).toBe(true)
    expect(chrome.find('[data-testid="open-library"]').exists()).toBe(true)
    expect(chrome.find('[data-testid="toggle-theme"]').attributes('title')).toBe('切换深色主题')
    expect(chrome.find('[data-testid="open-settings"]').attributes('title')).toBe('打开设置')
    expect(chrome.find('[data-testid="window-minimize"]').attributes('title')).toBe('最小化窗口')
    expect(chrome.find('[data-testid="window-close"]').attributes('title')).toBe('隐藏到系统托盘')
  })

  it('warns when the global shortcut overlaps a familiar Windows paste action', async () => {
    await wrapper.get('[data-testid="open-settings"]').trigger('click')

    expect(wrapper.get('[data-testid="shortcut-conflict"]').text()).toContain('纯文本粘贴')
    expect(wrapper.get('[data-testid="shortcut-recorder"]').attributes('title')).toContain('Ctrl + Shift + V')
  })

  it('keeps only the active filter and selected result actions in the Tab order', () => {
    expect(wrapper.get('[data-testid="filter-all"]').attributes('tabindex')).toBe('0')
    expect(wrapper.get('[data-testid="filter-text"]').attributes('tabindex')).toBe('-1')

    const tabbableResults = wrapper.findAll('.clip-primary').filter((button) => button.attributes('tabindex') === '0')
    expect(tabbableResults).toHaveLength(1)
    expect(tabbableResults[0].element.closest('[data-clip-id]')?.getAttribute('data-clip-id')).toBe('clip-1')
    expect(wrapper.get('[data-testid="preview-clip-clip-1"]').attributes('tabindex')).toBe('0')
    expect(wrapper.get('[data-testid="preview-clip-clip-2"]').attributes('tabindex')).toBe('-1')
  })

  it('moves between content filters with horizontal arrow keys', async () => {
    const all = wrapper.get('[data-testid="filter-all"]')
    ;(all.element as HTMLElement).focus()
    dispatchKey(all.element, 'ArrowRight')
    await wrapper.vm.$nextTick()

    const text = wrapper.get('[data-testid="filter-text"]')
    expect(text.attributes('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(text.element)

    dispatchKey(text.element, 'ArrowLeft')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="filter-all"]').attributes('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(all.element)
  })

  it('keeps capture pause available by keyboard without occupying the main chrome', async () => {
    expect(wrapper.find('[data-testid="capture-toggle"]').exists()).toBe(false)

    dispatchKey(wrapper.get('[data-testid="search-input"]').element, 'p', { ctrlKey: true })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.privacy-banner').text()).toContain('已暂停记录')
  })

  it('pastes directly after the user verifies a preview', async () => {
    await wrapper.get('[data-testid="preview-clip-clip-1"]').trigger('click')
    await wrapper.get('[data-testid="preview-paste"]').trigger('click')
    await flushPromises()

    expect(clipboardMocks.pasteText).toHaveBeenCalledWith(expect.stringContaining('Windows 版本'))
    expect(wrapper.get('.feedback-toast').text()).toContain('Ctrl+V')
  })

  it('copies a clip directly from the manager', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-copy-clip-1"]').trigger('click')
    await flushPromises()

    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining('Windows 版本'))
  })

  it('replaces the WebView menu with concise actions for a quick-panel clip', async () => {
    const row = wrapper.get('[data-clip-id="clip-2"]')
    const event = dispatchContextMenu(row.element)
    await wrapper.vm.$nextTick()

    expect(event.defaultPrevented).toBe(true)
    const menu = wrapper.get('[data-testid="clip-context-menu"]')
    expect(menu.attributes('role')).toBe('menu')
    expect(menu.findAll('[role="menuitem"]')).toHaveLength(2)
    expect(menu.get('[data-testid="context-paste"]').text()).toContain('粘贴')
    expect(menu.get('[data-testid="context-preview"]').text()).toContain('预览')
    expect(document.activeElement).toBe(menu.get('[data-testid="context-paste"]').element)
    expect(row.classes()).toContain('is-selected')
  })

  it('runs a quick paste context action and dismisses the menu', async () => {
    dispatchContextMenu(wrapper.get('[data-clip-id="clip-1"]').element)
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="context-paste"]').trigger('click')
    await flushPromises()

    expect(clipboardMocks.pasteText).toHaveBeenCalledWith(expect.stringContaining('Windows 版本'))
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
  })

  it('does not expose destructive actions from a quick context menu', async () => {
    const row = wrapper.get('[data-clip-id="clip-2"]')
    dispatchContextMenu(row.element)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="context-delete"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="context-pin"]').exists()).toBe(false)
    expect(wrapper.find('[data-clip-id="clip-2"]').exists()).toBe(true)
  })

  it('keeps native editing commands for inputs and suppresses the WebView menu on blank chrome', async () => {
    const searchEvent = dispatchContextMenu(wrapper.get('[data-testid="search-input"]').element)
    expect(searchEvent.defaultPrevented).toBe(false)
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)

    const chromeEvent = dispatchContextMenu(wrapper.get('.panel-chrome').element)
    await wrapper.vm.$nextTick()
    expect(chromeEvent.defaultPrevented).toBe(true)
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
  })

  it('suppresses the WebView menu on non-text input controls', async () => {
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const toggleEvent = dispatchContextMenu(wrapper.get('[data-testid="launch-at-startup-toggle"]').element)
    await wrapper.vm.$nextTick()

    expect(toggleEvent.defaultPrevented).toBe(true)
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
  })

  it('uses a focused manager menu without showing the redundant preview action', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const row = wrapper.get('[data-manager-clip-id="clip-1"]')
    dispatchContextMenu(row.element)
    await wrapper.vm.$nextTick()

    const menu = wrapper.get('[data-testid="clip-context-menu"]')
    expect(menu.find('[data-testid="context-preview"]').exists()).toBe(false)
    expect(menu.findAll('[role="menuitem"]')).toHaveLength(2)
    expect(row.attributes('aria-current')).toBe('true')
  })

  it('opens the selected clip menu from the keyboard and restores focus on Escape', async () => {
    const primary = wrapper.get('[data-clip-id="clip-1"] .clip-primary')
    ;(primary.element as HTMLElement).focus()
    dispatchKey(primary.element, 'F10', { shiftKey: true })
    await wrapper.vm.$nextTick()

    const menu = wrapper.get('[data-testid="clip-context-menu"]')
    const first = menu.get('[data-testid="context-paste"]')
    const second = menu.get('[data-testid="context-preview"]')
    expect(document.activeElement).toBe(first.element)

    dispatchKey(first.element, 'ArrowDown')
    expect(document.activeElement).toBe(second.element)
    dispatchKey(second.element, 'Escape')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(primary.element)
    expect(windowMocks.runWindowAction).not.toHaveBeenCalled()
  })

  it('honors the Space shortcut advertised for context-menu preview', async () => {
    const primary = wrapper.get('[data-clip-id="clip-1"] .clip-primary')
    dispatchContextMenu(primary.element)
    await wrapper.vm.$nextTick()
    const preview = wrapper.get('[data-testid="context-preview"]')
    ;(preview.element as HTMLElement).focus()

    dispatchKey(preview.element, ' ')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="preview-panel"]').attributes('data-preview-clip-id')).toBe('clip-1')
  })

  it('closes the menu with Tab without losing focus to the page root', async () => {
    const primary = wrapper.get('[data-clip-id="clip-1"] .clip-primary')
    ;(primary.element as HTMLElement).focus()
    dispatchKey(primary.element, 'F10', { shiftKey: true })
    await wrapper.vm.$nextTick()

    const tabEvent = dispatchKey(wrapper.get('[data-testid="context-paste"]').element, 'Tab')
    await wrapper.vm.$nextTick()

    expect(tabEvent.defaultPrevented).toBe(true)
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(primary.element)
  })

  it('does not let app-wide shortcuts escape an open context menu', async () => {
    const primary = wrapper.get('[data-clip-id="clip-2"] .clip-primary')
    dispatchContextMenu(primary.element)
    await wrapper.vm.$nextTick()
    const menuPaste = wrapper.get('[data-testid="context-paste"]')

    dispatchKey(menuPaste.element, 'k', { ctrlKey: true })
    dispatchKey(menuPaste.element, '1', { altKey: true })
    dispatchKey(menuPaste.element, 'F10', { shiftKey: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(true)
    expect(document.activeElement).toBe(menuPaste.element)
    expect(clipboardMocks.pasteText).not.toHaveBeenCalled()
  })

  it('keeps preview context menus paste-only and leaves the clip intact', async () => {
    await wrapper.get('[data-testid="preview-clip-clip-1"]').trigger('click')
    dispatchContextMenu(wrapper.get('[data-testid="preview-panel"]').element)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="context-delete"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="context-copy"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="context-paste"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(true)
  })

  it('flips an edge menu away from the pointer instead of placing actions under it', async () => {
    const x = window.innerWidth - 40
    const y = window.innerHeight - 60
    dispatchContextMenu(wrapper.get('[data-clip-id="clip-7"]').element, { clientX: x, clientY: y })
    await wrapper.vm.$nextTick()

    const menu = wrapper.get('[data-testid="clip-context-menu"]')
    const style = menu.attributes('style') ?? ''
    const left = Number.parseFloat(style.match(/left:\s*([\d.]+)px/)?.[1] ?? '')
    const top = Number.parseFloat(style.match(/top:\s*([\d.]+)px/)?.[1] ?? '')
    expect(left + 204).toBeLessThan(x)
    expect(top + 88).toBeLessThan(y)
  })

  it('expires a delete undo after a short recovery window', async () => {
    vi.useFakeTimers()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-delete-clip-1"]').trigger('click')
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(false)
  })

  it('keeps deletion recovery visible while showing independent action feedback', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-delete-clip-1"]').trigger('click')
    await wrapper.get('[data-testid="manager-copy-clip-2"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(true)
    expect(wrapper.find('.feedback-toast').exists()).toBe(true)
  })

  it('does not change the keyboard selection merely because the panel opens under the pointer', async () => {
    await wrapper.get('[data-clip-id="clip-2"]').trigger('mouseenter')
    expect(wrapper.get('[data-clip-id="clip-1"]').classes()).toContain('is-selected')
  })

  it('shows a delayed text hover preview without changing keyboard selection', async () => {
    vi.useFakeTimers()
    const row = wrapper.get('[data-clip-id="clip-4"]')

    await row.trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(199)
    expect(wrapper.find('[data-testid="clip-hover-preview"]').exists()).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await wrapper.vm.$nextTick()
    const preview = wrapper.get('[data-testid="clip-hover-preview"]')
    expect(preview.attributes('data-hover-clip-id')).toBe('clip-4')
    expect(preview.get('[data-testid="clip-hover-preview-text"]').text())
      .toContain('这次更新重点优化了搜索速度、窗口定位和中文输入法下的快捷键体验。')
    expect(wrapper.get('[data-clip-id="clip-1"]').classes()).toContain('is-selected')
    expect(row.classes()).not.toContain('is-selected')

    await row.trigger('mouseleave')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="clip-hover-preview"]').exists()).toBe(false)
  })

  it('bounds long hover preview text before mounting it in the panel', async () => {
    wrapper.unmount()
    vi.useFakeTimers()
    const content = '长'.repeat(5_000)
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([{
      id: 'long-hover-text',
      kind: 'text',
      title: '超长文本',
      content,
      sourceApp: 'Editor',
      copiedAt: '2026-07-21T00:00:00.000Z',
      pinned: false,
      searchTerms: [],
      formats: ['text'],
    }]))
    wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[data-clip-id="long-hover-text"]').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(200)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="clip-hover-preview-text"]').text())
      .toBe(`${'长'.repeat(4_096)}…`)
  })

  it('shows a larger image area after image hover intent settles', async () => {
    vi.useFakeTimers()
    const row = wrapper.get('[data-clip-id="clip-5"]')

    await row.trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(200)
    await wrapper.vm.$nextTick()

    const image = wrapper.get('[data-testid="clip-hover-preview-image"] img')
    expect(image.attributes('src')).toBe('/sample-layout.svg')
  })

  it('refreshes relative timestamps while the panel stays open', async () => {
    wrapper.unmount()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T07:42:30.000Z'))
    wrapper = mount(App, { attachTo: document.body })

    const firstMeta = wrapper.get('[data-clip-id="clip-1"] .clip-meta')
    expect(firstMeta.text()).toContain('刚刚')

    await vi.advanceTimersByTimeAsync(60_000)
    await wrapper.vm.$nextTick()

    expect(firstMeta.text()).toContain('1 分钟前')
  })

  it('resets selection to the first result after changing a filter', async () => {
    await wrapper.get('[data-clip-id="clip-7"] .clip-primary').trigger('click')
    await wrapper.get('[data-testid="filter-code"]').trigger('click')

    expect(wrapper.get('[data-clip-id="clip-2"]').classes()).toContain('is-selected')
  })

  it('moves actual focus with result-row arrow navigation', async () => {
    const first = wrapper.get('[data-clip-id="clip-1"] .clip-primary')
    ;(first.element as HTMLElement).focus()
    dispatchKey(first.element, 'ArrowDown')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-clip-id="clip-2"] .clip-primary').element)
  })

  it('synchronizes manager selection when a row action receives focus', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const action = wrapper.get('[data-testid="manager-pin-clip-2"]')
    ;(action.element as HTMLElement).focus()
    await action.trigger('focus')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-manager-clip-id="clip-2"]').attributes('aria-current')).toBe('true')
  })

  it('keeps search focus while exposing its active result to assistive technology', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    ;(search.element as HTMLElement).focus()
    dispatchKey(search.element, 'ArrowDown')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(search.element)
    expect(search.attributes('aria-activedescendant')).toBe('clip-result-clip-2')
  })

  it('starts a clean quick session while preserving manager filters across view detours', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('tauri')
    await wrapper.get('[data-testid="filter-code"]').trigger('click')
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-search-input"]').setValue('Visual Studio Code')
    await wrapper.get('[data-testid="manager-kind-code"]').trigger('click')
    await wrapper.get('[data-testid="library-section-pinned"]').trigger('click')

    await wrapper.get('.back-button').trigger('click')
    await wrapper.vm.$nextTick()

    expect((wrapper.get('[data-testid="search-input"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="filter-all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-clip-id="clip-1"]').classes()).toContain('is-selected')

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    expect(wrapper.get('[data-testid="library-section-pinned"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-testid="manager-kind-code"]').attributes('aria-pressed')).toBe('true')
    expect((wrapper.get('[data-testid="manager-search-input"]').element as HTMLInputElement).value).toBe('Visual Studio Code')

    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="settings-open-clipboard"]').trigger('click')

    expect(wrapper.get('[data-testid="library-section-pinned"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-testid="manager-kind-code"]').attributes('aria-pressed')).toBe('true')
    expect((wrapper.get('[data-testid="manager-search-input"]').element as HTMLInputElement).value).toBe('Visual Studio Code')
  })

  it('clears quick-session state only after the window is successfully hidden', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('tauri')
    await wrapper.get('[data-testid="filter-code"]').trigger('click')

    await wrapper.get('[data-testid="window-close"]').trigger('click')
    await flushPromises()

    expect((search.element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="filter-all"]').attributes('aria-pressed')).toBe('true')

    windowMocks.runWindowAction.mockResolvedValueOnce(false)
    await search.setValue('keep on failure')
    await wrapper.get('[data-testid="window-close"]').trigger('click')
    await flushPromises()

    expect((search.element as HTMLInputElement).value).toBe('keep on failure')
  })

  it('serializes titlebar actions and disables the controls while one is running', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await flushPromises()

    let finishAction: ((completed: boolean) => void) | undefined
    windowMocks.runWindowAction.mockImplementationOnce(() => new Promise((resolve) => {
      finishAction = resolve
    }))
    const maximize = wrapper.get('[data-testid="window-toggle-maximize"]')

    await maximize.trigger('click')
    await maximize.trigger('click')

    expect(windowMocks.runWindowAction).toHaveBeenCalledTimes(1)
    expect(maximize.attributes('disabled')).toBeDefined()

    finishAction?.(true)
    await flushPromises()
    expect(maximize.attributes('disabled')).toBeUndefined()
  })

  it('ends an unpinned quick session on blur while preserving a pinned session', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('tauri')
    window.dispatchEvent(new Event('blur'))
    await wrapper.vm.$nextTick()
    expect((search.element as HTMLInputElement).value).toBe('')

    await wrapper.get('[data-testid="pin-quick-panel"]').trigger('click')
    await flushPromises()
    await search.setValue('keep pinned')
    window.dispatchEvent(new Event('blur'))
    await wrapper.vm.$nextTick()

    expect((search.element as HTMLInputElement).value).toBe('keep pinned')
  })

  it('clears manager search before Escape returns to the quick panel', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const search = wrapper.get('[data-testid="manager-search-input"]')
    await search.setValue('tauri')
    const modeChangesBeforeEscape = windowMocks.setWindowMode.mock.calls.length

    dispatchKey(search.element, 'Escape')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="library-view"]').exists()).toBe(true)
    expect((search.element as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(search.element)
    expect(windowMocks.setWindowMode).toHaveBeenCalledTimes(modeChangesBeforeEscape)
  })

  it('offers an explicit manager search clear action that keeps input focus', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const search = wrapper.get('[data-testid="manager-search-input"]')
    await search.setValue('tauri')

    await wrapper.get('[data-testid="clear-manager-search"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect((search.element as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(search.element)
  })

  it('keeps manager search arrow keys available to the Chinese IME during composition', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const search = wrapper.get('[data-testid="manager-search-input"]')
    ;(search.element as HTMLElement).focus()
    await search.trigger('compositionstart')

    const composingArrow = dispatchKey(search.element, 'ArrowDown')
    await wrapper.vm.$nextTick()

    expect(composingArrow.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(search.element)

    await search.trigger('compositionend')
    const navigationArrow = dispatchKey(search.element, 'ArrowDown')
    await wrapper.vm.$nextTick()

    expect(navigationArrow.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('.manager-row').element)
  })

  it('restores focus to the recovered result after undoing a deletion', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const deleteButton = wrapper.get('[data-testid="manager-delete-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()
    await deleteButton.trigger('click')
    const undo = wrapper.get('[data-testid="undo-delete"]')
    ;(undo.element as HTMLElement).focus()

    await undo.trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-copy-clip-1"]').element)
  })

  it('keeps undo feedback out of modals and uses a safe focus fallback', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const deleteButton = wrapper.get('[data-testid="manager-delete-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()
    await deleteButton.trigger('click')
    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')

    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(true)

    await wrapper.get('[data-testid="undo-delete"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('.back-button').element)
  })

  it('returns focus to manager search when a focused undo action expires', async () => {
    vi.useFakeTimers()
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const deleteButton = wrapper.get('[data-testid="manager-delete-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()
    await deleteButton.trigger('click')
    const undo = wrapper.get('[data-testid="undo-delete"]')
    ;(undo.element as HTMLElement).focus()

    await vi.advanceTimersByTimeAsync(6_000)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-search-input"]').element)
  })

  it('moves focus to the next manager result when a focused row action deletes an item', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const deleteButton = wrapper.get('[data-testid="manager-delete-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()

    await deleteButton.trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-delete-clip-2"]').element)
  })

  it('returns focus to manager search after deleting the only visible result', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const search = wrapper.get('[data-testid="manager-search-input"]')
    await search.setValue('周会跟进事项')
    const onlyResult = wrapper.get('[data-manager-clip-id="clip-1"]')
    ;(onlyResult.element as HTMLElement).focus()

    dispatchKey(onlyResult.element, 'Delete')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="manager-empty-state"]').exists()).toBe(true)
    expect(document.activeElement).toBe(search.element)
  })

  it('moves focus safely when unpinning removes a manager result from the pinned section', async () => {
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="library-section-pinned"]').trigger('click')
    const unpin = wrapper.get('[data-testid="manager-pin-clip-2"]')
    ;(unpin.element as HTMLElement).focus()

    await unpin.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-manager-clip-id="clip-2"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-pin-clip-6"]').element)
  })
})
