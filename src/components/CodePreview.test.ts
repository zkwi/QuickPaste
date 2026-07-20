import { readFileSync } from 'node:fs'
import { flushPromises, mount } from '@vue/test-utils'
import CodePreview from './CodePreview.vue'

const mocks = vi.hoisted(() => ({
  highlightCode: vi.fn(),
}))

vi.mock('../platform/codeHighlight', () => ({
  highlightCode: mocks.highlightCode,
}))

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

describe('CodePreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.highlightCode.mockImplementation(async (code: string) => (
      `<span class="hljs-keyword">${escapeHtml(code)}</span>`
    ))
  })

  it('contains no direct highlighter import and renders escaped plain text immediately', () => {
    const source = readFileSync('src/components/CodePreview.vue', 'utf8')
    expect(source).not.toContain('highlight.js')
    const wrapper = mount(CodePreview, {
      props: { code: '<tag>', language: 'javascript' },
    })
    expect(wrapper.get('code').text()).toBe('<tag>')
    expect(wrapper.find('tag').exists()).toBe(false)
  })

  it('renders only the current platform result for a known language', async () => {
    const wrapper = mount(CodePreview, {
      props: { code: 'const answer = 42', language: 'javascript' },
    })
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="code-preview"]').attributes('data-highlighted')).toBe('true')
    })
    expect(mocks.highlightCode).toHaveBeenCalledWith(
      'const answer = 42',
      'javascript',
      expect.any(Function),
    )
    expect(wrapper.get('code').text()).toBe('const answer = 42')
  })

  it('discards slow stale output after code and language switch', async () => {
    let finishOld: ((value: string) => void) | undefined
    mocks.highlightCode
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce('<span>new code</span>')
    const wrapper = mount(CodePreview, {
      props: { code: 'old code', language: 'javascript' },
    })
    await wrapper.setProps({ code: 'new code', language: 'typescript' })
    await vi.waitFor(() => expect(wrapper.get('code').text()).toBe('new code'))
    finishOld?.('<span>old code</span>')
    await flushPromises()
    expect(wrapper.get('code').text()).toBe('new code')
  })

  it('keeps unknown and platform failures as exact escaped plain text', async () => {
    const unsafe = '<img src=x onerror=alert(1)>&entity;'
    const unknown = mount(CodePreview, { props: { code: unsafe } })
    await flushPromises()
    expect(mocks.highlightCode).not.toHaveBeenCalled()
    expect(unknown.get('code').text()).toBe(unsafe)
    expect(unknown.find('img').exists()).toBe(false)

    mocks.highlightCode.mockResolvedValueOnce(null)
    const failed = mount(CodePreview, {
      props: { code: unsafe, language: 'xml' },
    })
    await flushPromises()
    expect(failed.get('[data-testid="code-preview"]').attributes('data-highlighted')).toBe('false')
    expect(failed.get('code').text()).toBe(unsafe)
    expect(failed.find('img').exists()).toBe(false)
  })

  it('does not create executable nodes from known-language malicious input', async () => {
    const malicious = '<script>alert(1)</script><img src=x onerror=alert(2)>&amp;'
    const wrapper = mount(CodePreview, {
      props: { code: malicious, language: 'xml' },
    })
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="code-preview"]').attributes('data-highlighted')).toBe('true')
    })
    expect(wrapper.get('code').text()).toBe(malicious)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[onerror]').exists()).toBe(false)
  })

  it('invalidates a pending render when unmounted', async () => {
    let finish: ((value: string) => void) | undefined
    let isCurrent: (() => boolean) | undefined
    mocks.highlightCode.mockImplementationOnce((_code, _language, current) => {
      isCurrent = current
      return new Promise((resolve) => { finish = resolve })
    })
    const wrapper = mount(CodePreview, {
      props: { code: 'slow', language: 'rust' },
    })
    await flushPromises()
    expect(isCurrent?.()).toBe(true)
    wrapper.unmount()
    expect(isCurrent?.()).toBe(false)
    finish?.('<span>late</span>')
    await flushPromises()
  })

  it('defines bounded light, dark, and forced-color preview styling', () => {
    const styles = readFileSync('src/style.css', 'utf8')
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--code-keyword:/)
    expect(styles).toMatch(/:root\[data-theme="dark"\]\s*\{[\s\S]*?--code-keyword:/)
    expect(styles).toMatch(/\.code-preview\s*\{[\s\S]*?overflow:\s*auto/)
    expect(styles).toMatch(/@media \(forced-colors:\s*active\)[\s\S]*?\.code-preview\s*\{[\s\S]*?forced-color-adjust:\s*auto/)
  })
})
