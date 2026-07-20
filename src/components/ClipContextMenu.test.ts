import { mount } from '@vue/test-utils'
import ClipContextMenu from './ClipContextMenu.vue'
import type { ClipboardItem } from '../domain/clipboard'

const textClip: ClipboardItem = {
  id: 'text',
  kind: 'text',
  title: 'Plain text',
  content: 'plain text',
  sourceApp: 'Notepad',
  copiedAt: '2026-07-19T02:00:00.000Z',
  pinned: false,
  searchTerms: [],
  formats: ['text'],
}

const richClip: ClipboardItem = {
  ...textClip,
  id: 'rich',
  formats: ['text', 'html'],
  html: '<strong>plain text</strong>',
}

const fileClip: ClipboardItem = {
  ...textClip,
  id: 'file',
  kind: 'file',
  formats: ['files'],
  files: [{
    path: 'C:\\Fixtures\\report.txt',
    name: 'report.txt',
    directory: false,
    exists: true,
  }],
}

function mountMenu(clip: ClipboardItem, surface: 'quick' | 'manager' | 'preview' = 'quick') {
  return mount(ClipContextMenu, {
    attachTo: document.body,
    props: {
      clip,
      surface,
      locale: 'zh-CN',
      x: 100,
      y: 80,
      pasteDisabled: false,
    },
  })
}

describe('ClipContextMenu', () => {
  it('keeps the quick menu to paste and preview only', () => {
    const wrapper = mountMenu(textClip)

    expect(wrapper.findAll('[role="menuitem"]').map((item) => item.attributes('data-testid'))).toEqual([
      'context-paste',
      'context-preview',
    ])
    expect(wrapper.find('[data-testid="context-copy"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="context-pin"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="context-delete"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('exposes preserve and plain paste for rich quick clips', async () => {
    const wrapper = mountMenu(richClip)

    expect(wrapper.findAll('[role="menuitem"]').map((item) => item.attributes('data-testid'))).toEqual([
      'context-paste-preserve',
      'context-paste-plain',
      'context-preview',
    ])

    await wrapper.get('[data-testid="context-paste-plain"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]?.[0]).toEqual({ id: 'paste-plain', pasteMode: 'plain' })

    wrapper.unmount()
  })

  it('renders the manager file action matrix and disables missing-file actions', async () => {
    const wrapper = mountMenu(fileClip, 'manager')

    expect(wrapper.findAll('[role="menuitem"]').map((item) => item.attributes('data-testid'))).toEqual([
      'context-paste',
      'context-copy',
      'context-open-file',
      'context-reveal-file',
    ])
    expect(wrapper.find('[data-testid="context-preview"]').exists()).toBe(false)

    await wrapper.setProps({
      clip: {
        ...fileClip,
        files: fileClip.files?.map((file) => ({ ...file, exists: false })),
      },
    })
    expect(wrapper.get('[data-testid="context-open-file"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="context-reveal-file"]').attributes('disabled')).toBeDefined()

    wrapper.unmount()
  })

  it('does not close or activate actions for IME composition keys', async () => {
    const wrapper = mountMenu(textClip)
    const paste = wrapper.get('[data-testid="context-paste"]')

    const enter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      isComposing: true,
    })
    const space = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: ' ',
      isComposing: true,
    })
    paste.element.dispatchEvent(enter)
    paste.element.dispatchEvent(space)

    expect(enter.defaultPrevented).toBe(true)
    expect(space.defaultPrevented).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.emitted('action')).toBeUndefined()

    await paste.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')?.[0]).toEqual([true])

    wrapper.unmount()
  })
})
