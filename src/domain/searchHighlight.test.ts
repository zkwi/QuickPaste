import { createSearchHighlighter } from './searchHighlight'

describe('search highlighter', () => {
  it('matches case-insensitively while preserving the original text', () => {
    const highlighter = createSearchHighlighter('ＴＡＵＲＩ security')

    expect(highlighter.segments('Tauri security model')).toEqual([
      { text: 'Tauri', matched: true },
      { text: ' ', matched: false },
      { text: 'security', matched: true },
      { text: ' model', matched: false },
    ])
  })

  it('maps compatibility expansions back to a complete source grapheme', () => {
    const highlighter = createSearchHighlighter('ffi')

    expect(highlighter.segments('oﬃce')).toEqual([
      { text: 'o', matched: false },
      { text: 'ﬃ', matched: true },
      { text: 'ce', matched: false },
    ])
  })

  it('merges overlapping terms into one visible highlight', () => {
    const highlighter = createSearchHighlighter('tauri aur')

    expect(highlighter.segments('Tauri')).toEqual([
      { text: 'Tauri', matched: true },
    ])
  })

  it('uses the same contextual case folding as clipboard filtering', () => {
    const highlighter = createSearchHighlighter('ΟΣ')

    expect(highlighter.segments('ΟΣ')).toEqual([
      { text: 'ΟΣ', matched: true },
    ])
  })

  it('centers a compact preview around a distant match', () => {
    const highlighter = createSearchHighlighter('needle')
    const content = `${'开头内容'.repeat(60)} needle ${'结尾内容'.repeat(60)}`
    const preview = highlighter.preview(content)

    expect(preview).toMatch(/^….*needle.*…$/)
    expect(preview.length).toBeLessThan(content.length)
    expect(highlighter.segments(preview).some((segment) => segment.matched)).toBe(true)
  })

  it('leaves text unchanged when the query has no visible literal match', () => {
    const highlighter = createSearchHighlighter('huiyi')

    expect(highlighter.segments('会议纪要')).toEqual([
      { text: '会议纪要', matched: false },
    ])
    expect(highlighter.preview('会议纪要')).toBe('会议纪要')
  })

  it('treats an empty query as a no-op', () => {
    const highlighter = createSearchHighlighter('   ')

    expect(highlighter.hasTerms).toBe(false)
    expect(highlighter.segments('原始内容')).toEqual([
      { text: '原始内容', matched: false },
    ])
    expect(highlighter.preview('原始内容')).toBe('原始内容')
  })
})
