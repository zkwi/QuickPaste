import {
  MAX_HIGHLIGHT_CODE_UNITS,
  createCodeHighlightRuntime,
} from './codeHighlight'

function fakeCore() {
  return {
    registerLanguage: vi.fn(),
    highlight: vi.fn((code: string, options: { language: string; ignoreIllegals: true }) => ({
      value: `${options.language}:${code}`,
    })),
  }
}

function languageModule() {
  return { default: vi.fn() }
}

describe('code highlight platform', () => {
  it('caps work at 200,000 UTF-16 units and rejects unsupported languages before loading', async () => {
    const core = fakeCore()
    const loadCore = vi.fn().mockResolvedValue({ default: core })
    const loadJavaScript = vi.fn().mockResolvedValue(languageModule())
    const runtime = createCodeHighlightRuntime({
      loadCore,
      languageLoaders: { javascript: loadJavaScript },
    })

    await expect(runtime.highlight('x'.repeat(MAX_HIGHLIGHT_CODE_UNITS), 'javascript'))
      .resolves.toBe(`javascript:${'x'.repeat(MAX_HIGHLIGHT_CODE_UNITS)}`)
    await expect(runtime.highlight('x'.repeat(MAX_HIGHLIGHT_CODE_UNITS + 1), 'javascript'))
      .resolves.toBeNull()
    await expect(runtime.highlight('plain', 'markdown' as never)).resolves.toBeNull()
    expect(loadCore).toHaveBeenCalledOnce()
    expect(loadJavaScript).toHaveBeenCalledOnce()
    expect(core.highlight).toHaveBeenCalledOnce()
  })

  it('caches the core and each language registration while keeping languages isolated', async () => {
    const core = fakeCore()
    const loadCore = vi.fn().mockResolvedValue({ default: core })
    const loadJavaScript = vi.fn().mockResolvedValue(languageModule())
    const loadRust = vi.fn().mockResolvedValue(languageModule())
    const runtime = createCodeHighlightRuntime({
      loadCore,
      languageLoaders: { javascript: loadJavaScript, rust: loadRust },
    })

    await expect(runtime.highlight('one', 'javascript')).resolves.toBe('javascript:one')
    await expect(runtime.highlight('two', 'javascript')).resolves.toBe('javascript:two')
    await expect(runtime.highlight('fn main() {}', 'rust')).resolves.toBe('rust:fn main() {}')

    expect(loadCore).toHaveBeenCalledOnce()
    expect(loadJavaScript).toHaveBeenCalledOnce()
    expect(loadRust).toHaveBeenCalledOnce()
    expect(core.registerLanguage.mock.calls.map(([language]) => language)).toEqual(['javascript', 'rust'])
    expect(core.highlight).toHaveBeenNthCalledWith(1, 'one', {
      language: 'javascript', ignoreIllegals: true,
    })
  })

  it('does not execute highlighting after the caller becomes stale', async () => {
    const core = fakeCore()
    let finishLanguage: ((value: { default: unknown }) => void) | undefined
    const runtime = createCodeHighlightRuntime({
      loadCore: vi.fn().mockResolvedValue({ default: core }),
      languageLoaders: {
        typescript: () => new Promise((resolve) => { finishLanguage = resolve }),
      },
    })
    let current = true
    const result = runtime.highlight('const value: number = 1', 'typescript', () => current)
    current = false
    finishLanguage?.(languageModule())

    await expect(result).resolves.toBeNull()
    expect(core.highlight).not.toHaveBeenCalled()
  })

  it('falls back on import, registration, and highlight failures without poisoning retries', async () => {
    const core = fakeCore()
    const loadLanguage = vi.fn()
      .mockRejectedValueOnce(new Error('offline module failure'))
      .mockResolvedValue(languageModule())
    const runtime = createCodeHighlightRuntime({
      loadCore: vi.fn().mockResolvedValue({ default: core }),
      languageLoaders: { python: loadLanguage },
    })

    await expect(runtime.highlight('print(1)', 'python')).resolves.toBeNull()
    await expect(runtime.highlight('print(2)', 'python')).resolves.toBe('python:print(2)')
    expect(loadLanguage).toHaveBeenCalledTimes(2)

    core.highlight.mockImplementationOnce(() => { throw new Error('highlight failure') })
    await expect(runtime.highlight('print(3)', 'python')).resolves.toBeNull()
    core.registerLanguage.mockImplementationOnce(() => { throw new Error('registration failure') })
    const separate = createCodeHighlightRuntime({
      loadCore: vi.fn().mockResolvedValue({ default: core }),
      languageLoaders: { sql: vi.fn().mockResolvedValue(languageModule()) },
    })
    await expect(separate.highlight('SELECT 1', 'sql')).resolves.toBeNull()
  })
})
