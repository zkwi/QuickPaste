import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'

const clipboardMocks = vi.hoisted(() => ({
  copyImage: vi.fn().mockResolvedValue(true),
  copyText: vi.fn().mockResolvedValue(true),
  pasteImage: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteText: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
}))

const windowMocks = vi.hoisted(() => ({
  observeWindowMaximizedState: vi.fn().mockResolvedValue(() => undefined),
  runWindowAction: vi.fn().mockResolvedValue(true),
  setQuickPanelPinned: vi.fn().mockResolvedValue(true),
  setWindowMode: vi.fn().mockResolvedValue(true),
}))

vi.mock('./platform/clipboard', () => clipboardMocks)
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

  it('highlights case-insensitive literal matches in result titles and previews', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('TAURI security')

    const result = wrapper.get('[data-clip-id="clip-3"]')
    expect(result.get('.clip-title').findAll('mark.search-highlight').map((mark) => mark.text())).toEqual(['Tauri'])
    expect(result.get('.clip-preview').findAll('mark.search-highlight').map((mark) => mark.text())).toEqual(['tauri', 'security'])
    expect(result.get('.clip-title').text()).toBe('Tauri capabilities')
    expect(result.get('.clip-preview').text()).toBe('https://v2.tauri.app/security/capabilities/')
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
    expect(result.get('.clip-title').findAll('mark.search-highlight').map((mark) => mark.text())).toEqual(['Tauri'])
    expect(result.get('.clip-preview').findAll('mark.search-highlight').map((mark) => mark.text())).toEqual(['tauri'])
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

    const title = wrapper.get('[data-clip-id="clip-greek"] .clip-title')
    expect(title.get('mark.search-highlight').text()).toBe('ΟΣ')
    expect(title.text()).toBe('ΟΣ')
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

    const preview = wrapper.get('[data-clip-id="clip-long"] .clip-preview')
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

  it('deletes the focused result with Delete and keeps undo available', async () => {
    const primary = wrapper.get('[data-clip-id="clip-2"] .clip-primary')
    await primary.trigger('click')
    dispatchKey(primary.element, 'Delete')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-clip-id="clip-2"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="undo-delete"]').text()).toContain('撤销')
    expect(wrapper.get('.undo-toast').attributes('role')).toBe('status')

    await wrapper.get('[data-testid="undo-delete"]').trigger('click')
    expect(wrapper.find('[data-clip-id="clip-2"]').exists()).toBe(true)
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
    await pin.trigger('click')
    expect(pin.attributes('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      quickPanelPinned: true,
    })
  })

  it('does not advertise a separate plain-text action before rich formats are stored', () => {
    expect(wrapper.get('.keyboard-legend').text()).not.toContain('纯文本')
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

  it('toggles capture with the Ctrl+P shortcut advertised during onboarding', async () => {
    const toggle = wrapper.get('[data-testid="capture-toggle"]')
    expect(toggle.attributes('aria-keyshortcuts')).toBe('Control+P')

    dispatchKey(wrapper.get('[data-testid="search-input"]').element, 'p', { ctrlKey: true })
    await wrapper.vm.$nextTick()

    expect(toggle.attributes('aria-label')).toBe('恢复记录')
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
    expect(menu.findAll('[role="menuitem"]')).toHaveLength(5)
    expect(menu.get('[data-testid="context-paste"]').text()).toContain('粘贴')
    expect(menu.get('[data-testid="context-copy"]').text()).toContain('复制')
    expect(menu.get('[data-testid="context-preview"]').text()).toContain('预览')
    expect(menu.get('[data-testid="context-pin"]').text()).toContain('取消固定')
    expect(menu.get('[data-testid="context-delete"]').text()).toContain('删除')
    expect(document.activeElement).toBe(menu.get('[data-testid="context-paste"]').element)
    expect(row.classes()).toContain('is-selected')
  })

  it('runs a context action and dismisses the menu', async () => {
    dispatchContextMenu(wrapper.get('[data-clip-id="clip-1"]').element)
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="context-copy"]').trigger('click')
    await flushPromises()

    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining('Windows 版本'))
    expect(wrapper.find('[data-testid="clip-context-menu"]').exists()).toBe(false)
  })

  it('deletes the exact context clip while preserving undo and row focus', async () => {
    dispatchContextMenu(wrapper.get('[data-clip-id="clip-2"]').element)
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="context-delete"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-clip-id="clip-2"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('[data-clip-id="clip-3"] .clip-primary').element)
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
    expect(menu.findAll('[role="menuitem"]')).toHaveLength(4)
    expect(row.attributes('aria-current')).toBe('true')
  })

  it('opens the selected clip menu from the keyboard and restores focus on Escape', async () => {
    const primary = wrapper.get('[data-clip-id="clip-1"] .clip-primary')
    ;(primary.element as HTMLElement).focus()
    dispatchKey(primary.element, 'F10', { shiftKey: true })
    await wrapper.vm.$nextTick()

    const menu = wrapper.get('[data-testid="clip-context-menu"]')
    const first = menu.get('[data-testid="context-paste"]')
    const second = menu.get('[data-testid="context-copy"]')
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

  it('returns to the next result after deleting from a preview context menu', async () => {
    await wrapper.get('[data-testid="preview-clip-clip-1"]').trigger('click')
    dispatchContextMenu(wrapper.get('[data-testid="preview-panel"]').element)
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="context-delete"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-clip-id="clip-1"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-clip-id="clip-2"] .clip-primary').element)
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
    expect(top + 180).toBeLessThan(y)
  })

  it('expires a delete undo after a short recovery window', async () => {
    vi.useFakeTimers()
    await wrapper.get('[data-testid="delete-clip-clip-1"]').trigger('click')
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(false)
  })

  it('keeps deletion recovery visible while showing independent action feedback', async () => {
    await wrapper.get('[data-testid="delete-clip-clip-1"]').trigger('click')
    await wrapper.get('[data-testid="preview-clip-clip-2"]').trigger('click')
    await wrapper.get('[data-testid="preview-panel"] .primary-button').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(true)
    expect(wrapper.find('.feedback-toast').exists()).toBe(true)
  })

  it('does not change the keyboard selection merely because the panel opens under the pointer', async () => {
    await wrapper.get('[data-clip-id="clip-2"]').trigger('mouseenter')
    expect(wrapper.get('[data-clip-id="clip-1"]').classes()).toContain('is-selected')
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

  it('synchronizes selection when a row action receives focus', async () => {
    const action = wrapper.get('[data-testid="pin-clip-clip-2"]')
    ;(action.element as HTMLElement).focus()
    await action.trigger('focus')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-clip-id="clip-2"]').classes()).toContain('is-selected')
  })

  it('keeps search focus while exposing its active result to assistive technology', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    ;(search.element as HTMLElement).focus()
    dispatchKey(search.element, 'ArrowDown')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(search.element)
    expect(search.attributes('aria-activedescendant')).toBe('clip-result-clip-2')
  })

  it('starts a clean quick session after returning from the manager', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('tauri')
    await wrapper.get('[data-testid="filter-code"]').trigger('click')
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-search-input"]').setValue('capabilities')

    await wrapper.get('.back-button').trigger('click')
    await wrapper.vm.$nextTick()

    expect((wrapper.get('[data-testid="search-input"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="filter-all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-clip-id="clip-1"]').classes()).toContain('is-selected')

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    expect((wrapper.get('[data-testid="manager-search-input"]').element as HTMLInputElement).value).toBe('')
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
    const deleteButton = wrapper.get('[data-testid="delete-clip-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()
    await deleteButton.trigger('click')
    const undo = wrapper.get('[data-testid="undo-delete"]')
    ;(undo.element as HTMLElement).focus()

    await undo.trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-clip-id="clip-1"] .clip-primary').element)
  })

  it('keeps undo feedback out of modals and uses a safe focus fallback', async () => {
    const deleteButton = wrapper.get('[data-testid="delete-clip-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()
    await deleteButton.trigger('click')
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')

    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(true)

    await wrapper.get('[data-testid="undo-delete"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('.back-button').element)
  })

  it('returns focus to search when a focused undo action expires', async () => {
    vi.useFakeTimers()
    const deleteButton = wrapper.get('[data-testid="delete-clip-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()
    await deleteButton.trigger('click')
    const undo = wrapper.get('[data-testid="undo-delete"]')
    ;(undo.element as HTMLElement).focus()

    await vi.advanceTimersByTimeAsync(6_000)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="undo-delete"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="search-input"]').element)
  })

  it('moves focus to the next result when a focused row action deletes an item', async () => {
    const deleteButton = wrapper.get('[data-testid="delete-clip-clip-1"]')
    ;(deleteButton.element as HTMLElement).focus()

    await deleteButton.trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-clip-id="clip-2"] .clip-primary').element)
  })

  it('returns focus to search after deleting the only visible result', async () => {
    const search = wrapper.get('[data-testid="search-input"]')
    await search.setValue('周会跟进事项')
    const onlyResult = wrapper.get('[data-clip-id="clip-1"] .clip-primary')
    ;(onlyResult.element as HTMLElement).focus()

    dispatchKey(onlyResult.element, 'Delete')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="no-results"]').exists()).toBe(true)
    expect(document.activeElement).toBe(search.element)
  })

  it('moves focus safely when unpinning removes a result from the pinned filter', async () => {
    await wrapper.get('[data-testid="filter-pinned"]').trigger('click')
    const unpin = wrapper.get('[data-testid="pin-clip-clip-2"]')
    ;(unpin.element as HTMLElement).focus()

    await unpin.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-clip-id="clip-2"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-clip-id="clip-6"] .clip-primary').element)
  })
})
