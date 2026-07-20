import {
  historyQueryKey,
  historyMatchBadge,
  isValidHistoryCursor,
  normalizeHistoryQuery,
  type HistoryQuery,
} from './historyQuery'

function encodeNativeCursor(value: string): string {
  const bytes = new TextEncoder().encode(value)
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}

const cursor = encodeNativeCursor('1784426400000\nclip-100')
const nextCursor = encodeNativeCursor('1784426399000\nclip-099')

const query: HistoryQuery = {
  text: '\uFEFF  全角 ＡＢＣ\u0085次 \t\n  ',
  kinds: ['link', 'text', 'link'],
  sourceApps: ['\uFEFFWord\u0085', 'Edge', 'Word', '  ', '\uE000', '😀'],
  collection: { mode: 'collection', id: '\uFEFFcollection-1\u0085' },
  pinned: false,
  limit: 50,
  cursor,
}

describe('history query contract', () => {
  it('normalizes text and collection ids while deterministically deduplicating filters', () => {
    expect(normalizeHistoryQuery(query)).toEqual({
      text: '全角 abc 次',
      kinds: ['text', 'link'],
      sourceApps: ['Edge', 'Word', '😀', '\uE000'],
      collection: { mode: 'collection', id: 'collection-1' },
      pinned: false,
      limit: 50,
      cursor,
    })
    expect(query.sourceApps).toEqual(['\uFEFFWord\u0085', 'Edge', 'Word', '  ', '\uE000', '😀'])
  })

  it('keeps any, unfiled, and one collection as three distinct scopes', () => {
    const base = { ...query, text: '', kinds: [], sourceApps: [], cursor: undefined }
    expect(normalizeHistoryQuery({ ...base, collection: { mode: 'any' } }).collection).toEqual({ mode: 'any' })
    expect(normalizeHistoryQuery({ ...base, collection: { mode: 'unfiled' } }).collection).toEqual({ mode: 'unfiled' })
    expect(normalizeHistoryQuery({ ...base, collection: { mode: 'collection', id: 'work:2026' } }).collection)
      .toEqual({ mode: 'collection', id: 'work:2026' })
  })

  it.each([
    { mode: 'collection', id: '' },
    { mode: 'collection', id: '   ' },
    { mode: 'collection', id: 'contains spaces' },
    { mode: 'collection', id: 'x'.repeat(129) },
    { mode: 'unknown' },
  ])('rejects malformed collection scope %#', (collection) => {
    expect(() => normalizeHistoryQuery({ ...query, collection } as HistoryQuery)).toThrow()
  })

  it.each([0, -1, 1.5, 201, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid page limit %s',
    (limit) => expect(() => normalizeHistoryQuery({ ...query, limit })).toThrow(),
  )

  it.each([
    '',
    'opaque-cursor',
    ` ${cursor}`,
    `${cursor} `,
    btoa('1784426400000'),
    btoa('01784426400000\nclip-100'),
    btoa('1784426400000\nclip-100\nextra'),
    btoa('1784426400000\nclip\u0000'),
    encodeNativeCursor('1784426400000\n padded-id'),
    encodeNativeCursor('1784426400000\npadded-id\u0085'),
    encodeNativeCursor('-62167219200001\nclip-100'),
    encodeNativeCursor('253402300800000\nclip-100'),
    cursor.replace(/=+$/, ''),
    'x'.repeat(513),
  ])(
    'rejects malformed native cursor %j',
    (cursor) => expect(() => normalizeHistoryQuery({ ...query, cursor })).toThrow(),
  )

  it('accepts only the canonical native Base64 timestamp/id envelope', () => {
    expect(isValidHistoryCursor(cursor)).toBe(true)
    expect(isValidHistoryCursor(encodeNativeCursor('1784426400000\n中文-id'))).toBe(true)
    expect(isValidHistoryCursor(encodeNativeCursor(`1784426400000\n${'x'.repeat(363)}`))).toBe(true)
    expect(isValidHistoryCursor(encodeNativeCursor('-62167219200000\nmin'))).toBe(true)
    expect(isValidHistoryCursor(encodeNativeCursor('253402300799999\nmax'))).toBe(true)
    expect(normalizeHistoryQuery({ ...query, cursor }).cursor).toBe(cursor)
  })

  it('mirrors Unicode final-sigma folding and UTF-16 source ordering', () => {
    const normalized = normalizeHistoryQuery({ ...query, text: '  ΟΣ\u00A0ος  ' })
    expect(normalized.text).toBe('οσ οσ')
    expect(normalized.sourceApps).toEqual(['Edge', 'Word', '😀', '\uE000'])
  })

  it('makes the cache key ignore only cursor after canonical normalization', () => {
    const normalizedEquivalent: HistoryQuery = {
      ...query,
      text: '全角 abc 次',
      kinds: ['text', 'link'],
      sourceApps: ['Edge', 'Word', '😀', '\uE000'],
      collection: { mode: 'collection', id: 'collection-1' },
      cursor: nextCursor,
    }
    expect(historyQueryKey(query)).toBe(historyQueryKey(normalizedEquivalent))
    expect(historyQueryKey({ ...query, limit: 51 })).not.toBe(historyQueryKey(query))
    expect(historyQueryKey({ ...query, pinned: true })).not.toBe(historyQueryKey(query))
    expect(historyQueryKey({ ...query, collection: { mode: 'unfiled' } })).not.toBe(historyQueryKey(query))
  })

  it('maps native summary match sources to exact quick and manager badges', () => {
    const summary = {
      id: 'image-1', kind: 'image' as const, title: 'Screenshot', content: 'image', sourceApp: 'Snipping Tool',
      copiedAt: '2026-07-20T00:00:00.000Z', pinned: false, searchTerms: [], formats: ['image'] as const,
      payloadLoaded: false as const, ocrStatus: 'completed' as const,
    }

    expect(historyMatchBadge({ ...summary, matchSource: 'ocr' }, true)).toBe('ocr')
    expect(historyMatchBadge({ ...summary, matchSource: 'index' }, true)).toBe('index')
    expect(historyMatchBadge({ ...summary, matchSource: 'direct' }, true)).toBeNull()
    expect(historyMatchBadge({ ...summary, matchSource: 'ocr' }, false)).toBeNull()
    expect(historyMatchBadge({ ...summary, payloadLoaded: true, matchSource: 'ocr' }, true)).toBeNull()
    expect(historyMatchBadge({ ...summary, kind: 'text', matchSource: 'ocr' }, true)).toBeNull()
  })
})
