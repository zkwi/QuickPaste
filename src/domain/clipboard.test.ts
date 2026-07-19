import {
  applyClipFilter,
  createClipboardItem,
  clearUnpinnedHistory,
  formatRelativeTime,
  limitHistory,
  mergeCapturedClipIntoHistory,
  mergeCapturedClip,
  moveSelection,
  parseClipboardItems,
  pruneExpiredClips,
  removeClip,
  restoreClip,
  togglePinned,
  type ClipboardItem,
} from './clipboard'

const clips: ClipboardItem[] = [
  {
    id: 'a',
    kind: 'text',
    title: '会议纪要',
    content: '今天的会议重点是完成 Windows 版本的交互验证。',
    sourceApp: '飞书',
    copiedAt: '2026-07-18T06:00:00.000Z',
    pinned: false,
    searchTerms: ['huiyi', 'hyjy'],
  },
  {
    id: 'b',
    kind: 'code',
    title: 'Rust command',
    content: 'cargo tauri dev',
    sourceApp: 'Windows Terminal',
    copiedAt: '2026-07-18T05:00:00.000Z',
    pinned: true,
    searchTerms: ['rust'],
  },
  {
    id: 'c',
    kind: 'link',
    title: 'Tauri capabilities',
    content: 'https://v2.tauri.app/security/capabilities/',
    sourceApp: 'Microsoft Edge',
    copiedAt: '2026-07-17T05:00:00.000Z',
    pinned: false,
    searchTerms: ['tauri'],
  },
]

const sourceAppIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3voZ8QAAAABJRU5ErkJggg=='

describe('clipboard model', () => {
  it('searches content, source app and explicit pinyin terms', () => {
    expect(applyClipFilter(clips, { query: 'huiyi', kind: 'all' }).map((clip) => clip.id)).toEqual(['a'])
    expect(applyClipFilter(clips, { query: 'terminal', kind: 'all' }).map((clip) => clip.id)).toEqual(['b'])
    expect(applyClipFilter(clips, { query: 'capabilities', kind: 'all' }).map((clip) => clip.id)).toEqual(['c'])
  })

  it('builds full and initial pinyin indexes for newly captured Chinese content', () => {
    const captured = createClipboardItem({
      kind: 'text',
      content: '会议纪要',
      capturedAt: '2026-07-19T02:00:00.000Z',
      sourceApp: '微信',
    }, 'captured-pinyin')

    expect(applyClipFilter([captured], { query: 'huiyijiyao', kind: 'all' })).toHaveLength(1)
    expect(applyClipFilter([captured], { query: 'hyjy', kind: 'all' })).toHaveLength(1)
    expect(applyClipFilter([captured], { query: 'weixin', kind: 'all' })).toHaveLength(1)
  })

  it('parses persisted history and migrates legacy records without search terms', () => {
    const legacy = clips.map(({ searchTerms: _searchTerms, ...clip }) => clip)

    expect(parseClipboardItems(legacy)).toEqual(
      clips.map((clip) => ({ ...clip, searchTerms: [] })),
    )
  })

  it('keeps safe PNG source icons while treating malformed decorative icons as absent', () => {
    expect(parseClipboardItems([{ ...clips[0], sourceAppIcon }])?.[0].sourceAppIcon).toBe(sourceAppIcon)

    for (const unsafeIcon of [
      42,
      'https://example.com/icon.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:image/png;base64,not-a-png',
      `data:image/png;base64,iVBORw0KGgo${'A'.repeat(70_000)}`,
    ]) {
      const parsed = parseClipboardItems([{ ...clips[0], sourceAppIcon: unsafeIcon }])
      expect(parsed).not.toBeNull()
      expect(parsed?.[0]).not.toHaveProperty('sourceAppIcon')
    }
  })

  it('rejects malformed history as a whole instead of leaking partial records into the UI', () => {
    expect(parseClipboardItems({ items: clips })).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], kind: 'file' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], searchTerms: ['valid', 42] }])).toBeNull()
    expect(parseClipboardItems([clips[0], { ...clips[1], id: clips[0].id }])).toBeNull()
  })

  it('filters pinned items without changing source order', () => {
    expect(applyClipFilter(clips, { query: '', kind: 'pinned' }).map((clip) => clip.id)).toEqual(['b'])
  })

  it('toggles pinned state immutably', () => {
    const next = togglePinned(clips, 'a')
    expect(next[0].pinned).toBe(true)
    expect(clips[0].pinned).toBe(false)
  })

  it('removes and restores a clip at its original position', () => {
    const removed = removeClip(clips, 'b')
    expect(removed.items.map((clip) => clip.id)).toEqual(['a', 'c'])
    expect(restoreClip(removed.items, removed.undo).map((clip) => clip.id)).toEqual(['a', 'b', 'c'])
  })

  it('clamps keyboard selection to visible results', () => {
    expect(moveSelection(0, -1, 3)).toBe(0)
    expect(moveSelection(0, 1, 3)).toBe(1)
    expect(moveSelection(2, 1, 3)).toBe(2)
    expect(moveSelection(3, 1, 0)).toBe(-1)
  })

  it('formats compact Chinese relative timestamps', () => {
    const now = new Date('2026-07-18T06:02:00.000Z')
    expect(formatRelativeTime('2026-07-18T06:00:00.000Z', now)).toBe('2 分钟前')
    expect(formatRelativeTime('2026-07-17T06:02:00.000Z', now)).toBe('昨天')
  })

  it('formats relative timestamps in English when requested', () => {
    const now = new Date('2026-07-18T06:02:00.000Z')
    expect(formatRelativeTime('2026-07-18T06:00:00.000Z', now, 'en-US')).toBe('2 minutes ago')
    expect(formatRelativeTime('2026-07-17T06:02:00.000Z', now, 'en-US')).toBe('Yesterday')
  })

  it('renders a safe label for pinned records with a damaged timestamp', () => {
    expect(formatRelativeTime('not-a-date', undefined, 'zh-CN')).toBe('未知时间')
    expect(formatRelativeTime('not-a-date', undefined, 'en-US')).toBe('Unknown time')
  })

  it('turns native text and image captures into searchable clipboard items', () => {
    const link = createClipboardItem({
      kind: 'text',
      content: 'https://pasteapp.io/features',
      capturedAt: '2026-07-18T08:00:00.000Z',
      sourceApp: 'Microsoft Word',
      sourceAppIcon,
    }, 'native-1')
    const image = createClipboardItem({
      kind: 'image',
      content: 'data:image/png;base64,AA==',
      capturedAt: '2026-07-18T08:01:00.000Z',
      sourceAppIcon,
      width: 1280,
      height: 720,
    }, 'native-2')

    expect(link).toMatchObject({ kind: 'link', sourceApp: 'Microsoft Word', sourceAppIcon })
    expect(link.title).toContain('pasteapp.io')
    expect(image).toMatchObject({ kind: 'image', dimensions: '1280 × 720', sourceAppIcon })
    expect(image.imageUrl).toBe('data:image/png;base64,AA==')
  })

  it('moves a repeated capture to the front without creating duplicates', () => {
    const repeated = { ...clips[2], id: 'new-link', copiedAt: '2026-07-18T08:00:00.000Z' }
    const merged = mergeCapturedClip(clips, repeated)

    expect(merged[0].id).toBe('new-link')
    expect(merged.filter((clip) => clip.content === repeated.content)).toHaveLength(1)
  })

  it('retains a known icon for a repeated capture only when the source application still matches', () => {
    const previous = { ...clips[0], sourceAppIcon }

    expect(mergeCapturedClip([previous], { ...previous, id: 'same-source', sourceAppIcon: undefined })[0].sourceAppIcon)
      .toBe(sourceAppIcon)
    expect(mergeCapturedClip([previous], {
      ...previous,
      id: 'different-source',
      sourceApp: 'Notepad',
      sourceAppIcon: undefined,
    })[0]).not.toHaveProperty('sourceAppIcon')
  })

  it('cleans expired history while retaining pinned items', () => {
    const now = new Date('2026-08-20T00:00:00.000Z')
    const pruned = pruneExpiredClips(clips, '30', now)

    expect(pruned.map((clip) => clip.id)).toEqual(['b'])
    expect(pruneExpiredClips(clips, 'forever', now)).toEqual(clips)
  })

  it('drops unpinned entries with invalid timestamps while retaining pinned entries', () => {
    const invalidUnpinned = { ...clips[0], id: 'invalid-unpinned', copiedAt: 'not-a-date' }
    const invalidPinned = { ...clips[1], id: 'invalid-pinned', copiedAt: 'not-a-date' }

    expect(pruneExpiredClips([invalidUnpinned, invalidPinned], 'forever'))
      .toEqual([invalidPinned])
  })

  it('prunes expired entries whenever a new capture enters the live history', () => {
    const incoming = { ...clips[0], id: 'new', copiedAt: '2026-08-20T00:00:00.000Z' }
    const next = mergeCapturedClipIntoHistory(
      clips,
      incoming,
      '30',
      500,
      new Date('2026-08-20T00:00:00.000Z'),
    )

    expect(next.map((clip) => clip.id)).toEqual(['new', 'b'])
  })

  it('caps ordinary history without ever discarding pinned clips', () => {
    const expanded = [
      clips[0],
      { ...clips[0], id: 'd' },
      clips[1],
      { ...clips[0], id: 'e' },
    ]

    expect(limitHistory(expanded, 2).map((clip) => clip.id)).toEqual(['a', 'd', 'b'])
  })

  it('clears ordinary history while preserving every pinned clip', () => {
    const cleared = clearUnpinnedHistory(clips)

    expect(cleared.items.map((clip) => clip.id)).toEqual(['b'])
    expect(cleared.removedCount).toBe(2)
  })
})
