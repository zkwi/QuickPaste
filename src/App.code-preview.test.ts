import { flushPromises, mount } from '@vue/test-utils'
import App from './App.vue'

const clipboardMocks = vi.hoisted(() => ({
  copyImage: vi.fn().mockResolvedValue(true),
  copyText: vi.fn().mockResolvedValue(true),
  pasteFiles: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteFormats: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteImage: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
  pasteText: vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false }),
}))

const highlightMocks = vi.hoisted(() => ({
  coreImported: vi.fn(),
  languageImported: vi.fn(),
  registerLanguage: vi.fn(),
  highlight: vi.fn((code: string) => ({
    value: `<span class="hljs-keyword">${code}</span>`,
  })),
}))

vi.mock('./platform/clipboard', () => clipboardMocks)
vi.mock('highlight.js/lib/core', () => {
  highlightMocks.coreImported()
  return {
    default: {
      registerLanguage: highlightMocks.registerLanguage,
      highlight: highlightMocks.highlight,
    },
  }
})
vi.mock('highlight.js/lib/languages/typescript', () => {
  highlightMocks.languageImported('typescript')
  return { default: vi.fn() }
})

function dispatchEscape(target: Element) {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Escape',
  }))
}

describe('App code preview integration', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('mypaste-ui-settings-v1', JSON.stringify({ onboardingCompleted: true }))
    localStorage.setItem('mypaste-demo-items-v1', JSON.stringify([
      {
        id: 'code-ts', kind: 'code', title: 'panel.ts', content: 'const answer: number = 42',
        sourceApp: 'Visual Studio Code', copiedAt: '2026-07-20T01:00:00.000Z', pinned: false,
        searchTerms: [],
      },
      {
        id: 'plain-text', kind: 'text', title: 'Notes', content: 'Keep this plain',
        sourceApp: 'Notepad', copiedAt: '2026-07-20T00:59:00.000Z', pinned: false,
        searchTerms: [],
      },
      {
        id: 'plain-image', kind: 'image', title: 'Layout', content: 'Image description',
        sourceApp: 'Snipping Tool', copiedAt: '2026-07-20T00:58:00.000Z', pinned: false,
        searchTerms: [], imageUrl: 'data:image/png;base64,AA==',
      },
    ]))
    vi.clearAllMocks()
  })

  it('loads CodePreview only for an opened code preview and preserves preview paste and Escape', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    try {
      await flushPromises()
      expect(wrapper.find('[data-testid="code-preview"]').exists()).toBe(false)
      expect(highlightMocks.coreImported).not.toHaveBeenCalled()
      expect(highlightMocks.languageImported).not.toHaveBeenCalled()

      await wrapper.get('[data-testid="preview-clip-plain-text"]').trigger('click')
      expect(wrapper.find('[data-testid="code-preview"]').exists()).toBe(false)
      expect(highlightMocks.coreImported).not.toHaveBeenCalled()
      await wrapper.get('[data-testid="close-preview"]').trigger('click')

      await wrapper.get('[data-testid="preview-clip-plain-image"]').trigger('click')
      expect(wrapper.find('[data-testid="code-preview"]').exists()).toBe(false)
      expect(highlightMocks.coreImported).not.toHaveBeenCalled()
      await wrapper.get('[data-testid="close-preview"]').trigger('click')

      await wrapper.get('[data-testid="preview-clip-code-ts"]').trigger('click')
      await vi.waitFor(() => {
        expect(wrapper.get('[data-testid="code-preview"]').attributes('data-highlighted')).toBe('true')
      })
      expect(highlightMocks.coreImported).toHaveBeenCalledOnce()
      expect(highlightMocks.languageImported).toHaveBeenCalledWith('typescript')
      expect(wrapper.get('[data-testid="code-preview"]').text()).toBe('const answer: number = 42')

      await wrapper.get('[data-testid="preview-paste"]').trigger('click')
      await flushPromises()
      expect(clipboardMocks.pasteText).toHaveBeenCalledWith('const answer: number = 42')

      dispatchEscape(wrapper.get('[data-testid="preview-panel"]').element)
      await flushPromises()
      expect(wrapper.find('[data-testid="code-preview"]').exists()).toBe(false)
      expect(wrapper.get('[data-clip-id="code-ts"]').classes()).toContain('is-selected')
    } finally {
      wrapper.unmount()
    }
  })
})
