import { mount } from '@vue/test-utils'
import App from './App.vue'

describe('QuickPaste quick panel', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({ onboardingCompleted: true }))
  })

  it('guides first-time users through the essential workflow and remembers completion', async () => {
    localStorage.clear()
    const wrapper = mount(App)

    expect(wrapper.get('[data-testid="onboarding-dialog"]').text()).toContain('随叫随到的剪贴板')
    await wrapper.get('[data-testid="onboarding-next"]').trigger('click')
    expect(wrapper.get('[data-testid="onboarding-dialog"]').text()).toContain('搜索、预览、直接粘贴')
    await wrapper.get('[data-testid="onboarding-next"]').trigger('click')
    expect(wrapper.get('[data-testid="onboarding-dialog"]').text()).toContain('隐私由你掌控')
    await wrapper.get('[data-testid="onboarding-finish"]').trigger('click')

    expect(wrapper.find('[data-testid="onboarding-dialog"]').exists()).toBe(false)
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({ onboardingCompleted: true })
  })

  it('announces onboarding progress and localizes the visual example', async () => {
    localStorage.clear()
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({ locale: 'en-US' }))
    const wrapper = mount(App)

    const progress = wrapper.get('.step-dots')
    expect(wrapper.get('.onboarding-brand').text()).toContain('QuickPaste')
    expect(document.title).toBe('QuickPaste · Quick panel')
    expect(progress.attributes('role')).toBe('progressbar')
    expect(progress.attributes('aria-valuenow')).toBe('1')

    await wrapper.get('[data-testid="onboarding-next"]').trigger('click')
    expect(progress.attributes('aria-valuenow')).toBe('2')
    expect(wrapper.get('.mini-search').text()).toContain('meeting')
    expect(wrapper.get('.mini-search').text()).not.toContain('huiyi')
  })

  it('moves keyboard focus into onboarding and keeps Tab inside the dialog', async () => {
    localStorage.clear()
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.vm.$nextTick()

    const next = wrapper.get('[data-testid="onboarding-next"]')
    const skip = wrapper.get('.skip-button')
    expect(document.activeElement).toBe(next.element)

    next.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab' }))
    expect(document.activeElement).toBe(skip.element)

    skip.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab', shiftKey: true }))
    expect(document.activeElement).toBe(next.element)
    wrapper.unmount()
  })

  it('focuses the compact onboarding container so zoom does not jump past its header', async () => {
    localStorage.clear()
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    const wrapper = mount(App, { attachTo: document.body })
    try {
      await wrapper.vm.$nextTick()
      const dialog = wrapper.get('[data-testid="onboarding-dialog"]')
      expect(document.activeElement).toBe(dialog.element)
      dialog.element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Tab',
        shiftKey: true,
      }))
      expect(document.activeElement).toBe(wrapper.get('[data-testid="onboarding-next"]').element)
    } finally {
      wrapper.unmount()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('keeps the onboarding header visible when effective height makes the dialog overflow', async () => {
    localStorage.clear()
    const originalHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 440 })
    const wrapper = mount(App, { attachTo: document.body })
    try {
      await wrapper.vm.$nextTick()
      const dialog = wrapper.get('[data-testid="onboarding-dialog"]')
      Object.defineProperty(dialog.element, 'clientHeight', { configurable: true, value: 360 })
      Object.defineProperty(dialog.element, 'scrollHeight', { configurable: true, value: 412 })
      const scrollTo = vi.spyOn(dialog.element, 'scrollTo')

      await wrapper.get('[data-testid="onboarding-next"]').trigger('click')
      await wrapper.vm.$nextTick()

      expect(document.activeElement).toBe(dialog.element)
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 })
    } finally {
      wrapper.unmount()
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
    }
  })

  it('filters clipboard rows with Chinese pinyin search terms', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="search-input"]').setValue('huiyi')

    expect(wrapper.text()).toContain('周会跟进事项')
    expect(wrapper.text()).not.toContain('cargo tauri dev')
  })

  it('falls back to safe demo history when browser storage is malformed', () => {
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([
      { id: 'broken', kind: 'text', title: '损坏记录' },
    ]))

    const wrapper = mount(App)

    expect(wrapper.text()).toContain('周会跟进事项')
    expect(wrapper.text()).not.toContain('损坏记录')
  })

  it('keeps the interface usable when browser storage rejects writes', () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })

    try {
      expect(() => mount(App)).not.toThrow()
      expect(setItem).toHaveBeenCalled()
    } finally {
      setItem.mockRestore()
    }
  })

  it('uses the Windows Ctrl+K hint and focuses search with that shortcut', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    const search = wrapper.get('[data-testid="search-input"]')
    ;(wrapper.get('[data-testid="capture-toggle"]').element as HTMLElement).focus()

    expect(wrapper.get('.search-hint').text()).toContain('Ctrl')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(search.element)
    wrapper.unmount()
  })

  it('pins a clipboard row and exposes the updated accessible state', async () => {
    const wrapper = mount(App)
    const pinButton = wrapper.get('[data-testid="pin-clip-clip-1"]')

    expect(pinButton.attributes('aria-pressed')).toBe('false')
    await pinButton.trigger('click')
    expect(pinButton.attributes('aria-pressed')).toBe('true')
  })

  it('shows a visible privacy banner when capture is paused', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="capture-toggle"]').trigger('click')

    expect(wrapper.get('[role="status"]').text()).toContain('已暂停记录')
  })

  it('restores the paused capture state after the interface restarts', async () => {
    const wrapper = mount(App)
    await wrapper.get('[data-testid="capture-toggle"]').trigger('click')

    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      capturePaused: true,
    })
    wrapper.unmount()

    const restarted = mount(App)
    expect(restarted.get('[role="status"]').text()).toContain('已暂停记录')
  })

  it('sanitizes damaged persisted booleans and excluded app names', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      launchAtStartup: 'true',
      hideDuringSharing: 'false',
      elevatedPasteEnabled: 0,
      capturePaused: 'false',
      excludedApps: ['  KeePassXC  ', 'keepassxc', '', 42],
    }))
    const wrapper = mount(App)

    expect(wrapper.get('.capture-state').text()).toContain('正在记录')
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    expect((wrapper.get('[data-testid="launch-at-startup-toggle"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.get('[data-testid="capture-protection-toggle"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.get('[data-testid="elevated-paste-toggle"]').element as HTMLInputElement).checked).toBe(true)

    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    expect(wrapper.findAll('.sensitive-app-row')).toHaveLength(1)
    expect(wrapper.get('.sensitive-app-row').text()).toContain('KeePassXC')
  })

  it('migrates the legacy capture-protection default off so screenshots stay visible', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      onboardingCompleted: true,
      hideDuringSharing: true,
      retentionDays: '90',
    }))

    const wrapper = mount(App)
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect((wrapper.get('[data-testid="capture-protection-toggle"]').element as HTMLInputElement).checked).toBe(false)
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      settingsVersion: 3,
      hideDuringSharing: false,
      retentionDays: '90',
    })
  })

  it('preserves an explicit capture-protection choice across newer settings schemas', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({
      settingsVersion: 3,
      onboardingCompleted: true,
      hideDuringSharing: true,
    }))

    const wrapper = mount(App)
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect((wrapper.get('[data-testid="capture-protection-toggle"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('switches content filters and keeps image results discoverable', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="filter-image"]').trigger('click')

    expect(wrapper.text()).toContain('界面布局参考')
    expect(wrapper.text()).not.toContain('cargo tauri dev')
  })

  it('opens an inline preview and returns to the same clipboard row', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="preview-clip-clip-1"]').trigger('click')
    expect(wrapper.get('[data-testid="preview-panel"]').text()).toContain('周会跟进事项')

    await wrapper.get('[data-testid="close-preview"]').trigger('click')
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false)
    expect(wrapper.get('[data-clip-id="clip-1"]').classes()).toContain('is-selected')
  })

  it('offers undo after deleting a clipboard row', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="delete-clip-clip-1"]').trigger('click')
    expect(wrapper.text()).not.toContain('周会跟进事项')
    expect(wrapper.get('[data-testid="undo-delete"]').text()).toContain('撤销')

    await wrapper.get('[data-testid="undo-delete"]').trigger('click')
    expect(wrapper.text()).toContain('周会跟进事项')
  })

  it('opens the lightweight manager without losing clipboard history', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="open-library"]').trigger('click')

    expect(wrapper.get('[data-testid="library-view"]').text()).toContain('管理剪贴板')
    expect(wrapper.text()).toContain('周会跟进事项')
    expect(wrapper.get('.manager-source .manager-app-icon').classes()).toContain('manager-app-icon')
  })

  it('searches large history directly from the manager', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-search-input"]').setValue('tauri')

    expect(wrapper.get('.manager-list').text()).toContain('Tauri 开发命令')
    expect(wrapper.get('.manager-list').text()).not.toContain('周会跟进事项')
    expect(wrapper.get('.manager-list').findAll('mark.search-highlight').map((mark) => mark.text())).toContain('Tauri')
  })

  it('explains an empty manager search instead of suggesting users pin content', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="manager-search-input"]').setValue('definitely-missing')

    const empty = wrapper.get('[data-testid="manager-empty-state"]')
    expect(empty.text()).toContain('没有找到相关内容')
    expect(empty.text()).not.toContain('固定重要条目')
    expect(empty.get('[data-testid="clear-empty-manager-search"]').text()).toContain('清空搜索')
  })

  it('shows a neutral destination until the global shortcut identifies the real app', () => {
    const wrapper = mount(App)

    expect(wrapper.get('[data-testid="paste-target"]').text()).toContain('当前应用')
    expect(wrapper.get('[data-testid="paste-target"]').text()).not.toContain('Microsoft Word')
  })

  it('lets users manage applications that must never be recorded', async () => {
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('button[data-testid="open-sensitive-apps"]').trigger('click')
    expect(wrapper.get('[data-testid="sensitive-apps-dialog"]').text()).toContain('1Password')

    await wrapper.get('[data-testid="sensitive-app-input"]').setValue('KeePassXC')
    await wrapper.get('[data-testid="add-sensitive-app"]').trigger('click')
    expect(wrapper.get('[data-testid="sensitive-apps-dialog"]').text()).toContain('KeePassXC')
  })

  it('isolates sensitive-app settings and disables invalid additions', async () => {
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')

    const library = wrapper.get('[data-testid="library-view"]')
    const dialog = wrapper.get('[data-testid="sensitive-apps-dialog"]')
    const input = wrapper.get('[data-testid="sensitive-app-input"]')
    const add = wrapper.get('[data-testid="add-sensitive-app"]')
    expect(library.attributes()).toHaveProperty('inert')
    expect(dialog.attributes('aria-describedby')).toBe('sensitive-apps-description')
    expect(add.attributes()).toHaveProperty('disabled')

    await input.setValue('1Password')
    expect(add.attributes()).toHaveProperty('disabled')
    await input.setValue('KeePassXC')
    expect(add.attributes()).not.toHaveProperty('disabled')
  })

  it('moves focus into sensitive app settings and restores it when closed', async () => {
    const wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    const trigger = wrapper.get('[data-testid="open-sensitive-apps"]')
    ;(trigger.element as HTMLElement).focus()
    await trigger.trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-testid="sensitive-app-input"]').element)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="sensitive-apps-dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('discards an unfinished sensitive-app draft when the dialog closes', async () => {
    const wrapper = mount(App)
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    await wrapper.get('[data-testid="sensitive-app-input"]').setValue('unfinished.exe')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')

    expect((wrapper.get('[data-testid="sensitive-app-input"]').element as HTMLInputElement).value).toBe('')
  })

  it('keeps focus in the sensitive-app dialog after adding or removing an entry', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    const input = wrapper.get('[data-testid="sensitive-app-input"]')
    await input.setValue('KeePass.exe')

    await wrapper.get('[data-testid="add-sensitive-app"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(input.element)

    const firstRemove = wrapper.get('[aria-label="不再排除 1Password"]')
    ;(firstRemove.element as HTMLElement).focus()
    await firstRemove.trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[aria-label="不再排除 Bitwarden"]').element)
    wrapper.unmount()
  })

  it('gives an open modal priority over shortcut recording and manager commands', async () => {
    const wrapper = mount(App)
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="shortcut-recorder"]').trigger('click')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="sensitive-apps-dialog"]').exists()).toBe(false)

    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'l' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="sensitive-apps-dialog"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="library-section-settings"]').attributes('aria-current')).toBe('page')
  })

  it('switches the product chrome to English without restarting', async () => {
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="locale-select"]').setValue('en-US')

    expect(wrapper.get('[data-testid="library-view"]').text()).toContain('Settings')
    expect(wrapper.get('[data-testid="library-view"]').text()).toContain('Launch at startup')

    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    expect(wrapper.get('[data-testid="sensitive-apps-dialog"]').text()).toContain('Attempts to ignore clipboard changes')
    await wrapper.get('[aria-label="Close sensitive app settings"]').trigger('click')

    await wrapper.get('.back-button').trigger('click')
    expect(wrapper.get('[data-testid="search-input"]').attributes('placeholder')).toContain('Search clipboard')
    expect(wrapper.get('[data-testid="paste-target"]').text()).toContain('Paste to')
  })

  it('records and persists a custom global shortcut from the settings page', async () => {
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="shortcut-recorder"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', {
      altKey: true,
      code: 'KeyK',
      ctrlKey: true,
      key: 'k',
    }))
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="shortcut-recorder"]').text()).toContain('Ctrl + Alt + K')
    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}')).toMatchObject({
      globalShortcut: 'Ctrl+Alt+K',
    })
  })

  it('exposes administrator-window compatibility as an explicit setting', async () => {
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    expect(wrapper.get('[data-testid="elevated-paste-toggle"]').attributes('type')).toBe('checkbox')
    expect(wrapper.get('[data-testid="library-view"]').text()).toContain('管理员窗口')
  })

  it('gives settings controls explicit accessible names', async () => {
    const wrapper = mount(App)
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    expect(wrapper.get('[data-testid="settings-theme-button"]').attributes('aria-label')).toBe('界面主题：浅色')
    expect(wrapper.get('[data-testid="shortcut-recorder"]').attributes('aria-label')).toContain('Ctrl + Shift + V')

    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    expect(wrapper.get('[data-testid="sensitive-app-input"]').attributes('aria-label')).toBe('应用名称')
  })

  it('announces result-count changes in quick search and the manager', async () => {
    const wrapper = mount(App)
    await wrapper.get('[data-testid="search-input"]').setValue('definitely-no-match')
    expect(wrapper.get('[data-testid="quick-results-status"]').text()).toContain('没有可选择')

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    expect(wrapper.get('[data-testid="manager-results-status"]').attributes('aria-live')).toBe('polite')
    expect(wrapper.get('[data-testid="manager-results-status"]').text()).toContain('10')
  })

  it('starts manager searches from the first result and resets the scrolled surface', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    expect(document.title).toBe('闪电剪贴板 · 管理剪贴板')

    const laterRow = wrapper.get('[data-manager-clip-id="clip-3"]')
    ;(laterRow.element as HTMLElement).focus()
    const libraryContent = wrapper.get('.library-content').element as HTMLElement
    const managerList = wrapper.get('.manager-list').element as HTMLElement
    libraryContent.scrollTop = 120
    managerList.scrollTop = 80

    await wrapper.get('[data-testid="manager-search-input"]').setValue('Tauri')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-manager-clip-id="clip-2"]').attributes('tabindex')).toBe('0')
    expect(libraryContent.scrollTop).toBe(0)
    expect(managerList.scrollTop).toBe(0)
    wrapper.unmount()
  })

  it('describes unlimited retention and source-app exclusions without overpromising', async () => {
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    expect(wrapper.get('[data-testid="library-view"]').text()).toContain('不过期（仍保留最近 500 条未固定记录）')
    await wrapper.get('[data-testid="open-sensitive-apps"]').trigger('click')
    expect(wrapper.get('[data-testid="sensitive-apps-dialog"]').text()).toContain('尽量忽略指定前台应用')
    expect(wrapper.get('[data-testid="sensitive-apps-dialog"]').text()).toContain('可能存在短暂误判')
  })

  it('exposes the active manager section to assistive technology', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    expect(wrapper.get('[data-testid="library-section-all"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-testid="library-section-settings"]').attributes('aria-current')).toBeUndefined()

    await wrapper.get('[data-testid="library-section-settings"]').trigger('click')
    expect(wrapper.get('[data-testid="library-section-settings"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-testid="library-section-all"]').attributes('aria-current')).toBeUndefined()
  })

  it('returns manager content to the top when changing categories', async () => {
    const wrapper = mount(App)
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const content = wrapper.get('.library-content').element as HTMLElement
    content.scrollTop = 240

    await wrapper.get('[data-testid="library-section-pinned"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(content.scrollTop).toBe(0)
  })

  it('cancels shortcut recording when the user leaves settings', async () => {
    const wrapper = mount(App)
    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="shortcut-recorder"]').trigger('click')

    await wrapper.get('[data-testid="library-section-all"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', {
      altKey: true,
      code: 'KeyK',
      ctrlKey: true,
      key: 'k',
    }))
    await wrapper.vm.$nextTick()

    expect(JSON.parse(localStorage.getItem('mypaste-ui-settings-v1') ?? '{}').globalShortcut).toBe('Ctrl+Shift+V')
  })

  it('moves Ctrl+L from settings to history and focuses manager search', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[aria-label="打开设置"]').trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'l' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="library-section-all"]').attributes('aria-current')).toBe('page')
    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-search-input"]').element)
    wrapper.unmount()
  })

  it('keeps the same manager action focused when deleting or unpinning rows', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const deleteFirst = wrapper.get('[data-testid="manager-delete-clip-1"]')
    ;(deleteFirst.element as HTMLElement).focus()

    await deleteFirst.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-delete-clip-2"]').element)

    await wrapper.get('[data-testid="library-section-pinned"]').trigger('click')
    const unpinFirst = wrapper.get('[data-testid="manager-pin-clip-2"]')
    ;(unpinFirst.element as HTMLElement).focus()
    await unpinFirst.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-manager-clip-id="clip-2"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-pin-clip-6"]').element)
    wrapper.unmount()
  })

  it('offers scalable row navigation and descriptive actions in the manager', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const firstRow = wrapper.get('[data-manager-clip-id="clip-1"]')
    ;(firstRow.element as HTMLElement).focus()

    firstRow.element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowDown',
    }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-manager-clip-id="clip-2"]').element)
    expect(wrapper.findAll('.manager-row[tabindex="0"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="manager-copy-clip-2"]').attributes('aria-label')).toContain('Tauri 开发命令')
    expect(wrapper.get('[data-testid="manager-pin-clip-2"]').attributes('aria-pressed')).toBe('true')

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Delete',
    }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-manager-clip-id="clip-2"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-manager-clip-id="clip-3"]').element)
    wrapper.unmount()
  })

  it('confirms destructive retention changes before removing history', async () => {
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({ onboardingCompleted: true, retentionDays: 'forever' }))
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([
      {
        id: 'old-unpinned', kind: 'text', title: '旧的普通记录', content: 'remove after confirmation', sourceApp: 'QA',
        copiedAt: '2020-01-01T00:00:00.000Z', pinned: false, searchTerms: [], color: '#337C74',
      },
      {
        id: 'old-pinned', kind: 'text', title: '旧的固定记录', content: 'must remain', sourceApp: 'QA',
        copiedAt: '2020-01-01T00:00:00.000Z', pinned: true, searchTerms: [], color: '#337C74',
      },
      {
        id: 'recent', kind: 'text', title: '最近记录', content: 'keep', sourceApp: 'QA',
        copiedAt: new Date().toISOString(), pinned: false, searchTerms: [], color: '#337C74',
      },
    ]))
    const wrapper = mount(App)

    await wrapper.get('[aria-label="打开设置"]').trigger('click')
    await wrapper.get('[data-testid="retention-select"]').setValue('7')
    expect(wrapper.get('[data-testid="retention-change-dialog"]').text()).toContain('1')

    await wrapper.get('[data-testid="cancel-retention-change"]').trigger('click')
    expect((wrapper.get('[data-testid="retention-select"]').element as HTMLSelectElement).value).toBe('forever')

    await wrapper.get('[data-testid="retention-select"]').setValue('7')
    await wrapper.get('[data-testid="confirm-retention-change"]').trigger('click')
    await wrapper.get('[data-testid="library-section-all"]').trigger('click')
    expect(wrapper.text()).not.toContain('旧的普通记录')
    expect(wrapper.text()).toContain('旧的固定记录')
    expect(wrapper.text()).toContain('最近记录')
  })

  it('clears unpinned history only after an explicit confirmation', async () => {
    const wrapper = mount(App)

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="clear-history"]').trigger('click')
    expect(wrapper.get('[data-testid="clear-history-dialog"]').text()).toContain('固定内容会保留')

    await wrapper.get('[data-testid="confirm-clear-history"]').trigger('click')
    expect(wrapper.text()).not.toContain('周会跟进事项')
    expect(wrapper.text()).toContain('Tauri 开发命令')
    expect(wrapper.find('[data-testid="clear-history-dialog"]').exists()).toBe(false)
  })

  it('focuses the safe action in clear-history confirmation and restores its trigger', async () => {
    const wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('[data-testid="open-library"]').trigger('click')
    const trigger = wrapper.get('[data-testid="clear-history"]')
    ;(trigger.element as HTMLElement).focus()
    await trigger.trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-testid="cancel-clear-history"]').element)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="clear-history-dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('moves focus to manager search after confirming history clear', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('[data-testid="open-library"]').trigger('click')
    await wrapper.get('[data-testid="clear-history"]').trigger('click')

    await wrapper.get('[data-testid="confirm-clear-history"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-testid="manager-search-input"]').element)
    wrapper.unmount()
  })
})
