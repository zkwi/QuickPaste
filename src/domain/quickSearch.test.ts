import { parseQuickSearch, suggestSourceApps } from './quickSearch'

describe('quick search commands', () => {
  it('treats ASCII and full-width semicolons as permanent-snippet commands only at the start', () => {
    expect(parseQuickSearch('; 开票')).toEqual({ text: '开票', permanent: true })
    expect(parseQuickSearch('；地址')).toEqual({ text: '地址', permanent: true })
    expect(parseQuickSearch('正文；地址')).toEqual({ text: '正文；地址' })
  })

  it('extracts an @source prompt while preserving the remaining text query', () => {
    expect(parseQuickSearch('@wei 会议')).toEqual({ text: '会议', sourceFragment: 'wei' })
    expect(parseQuickSearch('@ 微信')).toEqual({ text: '微信', sourceFragment: '' })
    expect(parseQuickSearch('会议 @微信')).toEqual({ text: '会议 @微信' })
    expect(parseQuickSearch(';回复', '微信')).toEqual({ text: '回复', permanent: true, sourceApp: '微信' })
  })

  it('deduplicates and ranks source suggestions with normalized Chinese and Latin matching', () => {
    expect(suggestSourceApps(['微信', 'WPS Office', '微信', 'Microsoft Word'], '微')).toEqual(['微信'])
    expect(suggestSourceApps(['WPS Office', '微信', 'Microsoft Word'], 'w')).toEqual([
      'WPS Office',
      'Microsoft Word',
    ])
    expect(suggestSourceApps(['A', 'B', 'C'], '', 2)).toEqual(['A', 'B'])
  })
})
