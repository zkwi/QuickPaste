import {
  applyClipFilter,
  createClipboardItem,
  clearUnpinnedHistory,
  formatRelativeTime,
  isValidClipboardItemId,
  limitHistory,
  MAX_OCR_TEXT_BYTES,
  mergeCapturedClipIntoHistory,
  mergeCapturedClip,
  moveSelection,
  parseClipboardItems,
  promoteUsedClip,
  pruneExpiredClips,
  removeClip,
  restoreClip,
  togglePinned,
  type ClipboardItem,
  type ClipboardItemSummary,
  type LoadedClipboardItem,
  type ClipboardFile,
} from './clipboard'

const clips: LoadedClipboardItem[] = [
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
const imageHash = 'a'.repeat(64)
const files: ClipboardFile[] = [
  {
    path: 'C:\\Fixtures\\first.txt',
    name: 'first.txt',
    extension: '.txt',
    size: 12,
    modifiedAt: '2026-07-19T02:00:00.000Z',
    directory: false,
    exists: true,
  },
  {
    path: 'C:\\Fixtures\\folder',
    name: 'folder',
    directory: true,
    exists: false,
  },
]

describe('clipboard model', () => {
  it('keeps loaded payloads and native summaries as a discriminated type contract', () => {
    expectTypeOf<Extract<ClipboardItem, { payloadLoaded: false }>>()
      .toEqualTypeOf<ClipboardItemSummary>()
    expectTypeOf<LoadedClipboardItem['payloadLoaded']>().toEqualTypeOf<true | undefined>()
    expectTypeOf<ClipboardItemSummary['sourceAppIcon']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ClipboardItemSummary['imageUrl']>().toEqualTypeOf<undefined>()
    expectTypeOf<ReturnType<typeof parseClipboardItems>>()
      .toEqualTypeOf<LoadedClipboardItem[] | null>()
  })

  it('bounds canonical item ids so every record can produce a native cursor', () => {
    expect(isValidClipboardItemId('x'.repeat(363))).toBe(true)
    expect(isValidClipboardItemId('x'.repeat(364))).toBe(false)
    expect(isValidClipboardItemId('正常-id')).toBe(true)
  })

  it('searches content, source app and explicit pinyin terms', () => {
    expect(applyClipFilter(clips, { query: 'huiyi', kind: 'all' }).map((clip) => clip.id)).toEqual(['a'])
    expect(applyClipFilter(clips, { query: 'terminal', kind: 'all' }).map((clip) => clip.id)).toEqual(['b'])
    expect(applyClipFilter(clips, { query: 'capabilities', kind: 'all' }).map((clip) => clip.id)).toEqual(['c'])
    expect(applyClipFilter(clips, { query: '\uFEFFhuiyi\u0085今天', kind: 'all' }).map((clip) => clip.id)).toEqual(['a'])
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
    expect(parseClipboardItems([{ ...clips[0], payloadLoaded: false }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], id: ' padded-id' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], id: 'padded-id\uFEFF' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], unexpected: 'silently dropped before' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], kind: 'file', formats: ['files'], files: [{ ...files[0], unexpected: true }] }])).toBeNull()
  })

  it('parses valid rich text fields when their formats are declared', () => {
    const parsed = parseClipboardItems([{
      ...clips[0],
      formats: ['text', 'html', 'rtf'],
      html: '<p>富文本</p>',
      rtfBase64: 'e1xydGYxXGFuc2k=',
      collectionId: 'work',
      permanent: false,
      updatedAt: '2026-07-19T03:00:00.000Z',
    }])

    expect(parsed?.[0]).toMatchObject({
      kind: 'text',
      formats: ['text', 'html', 'rtf'],
      html: '<p>富文本</p>',
      rtfBase64: 'e1xydGYxXGFuc2k=',
      collectionId: 'work',
      permanent: false,
      updatedAt: '2026-07-19T03:00:00.000Z',
    })
  })

  it('strictly parses local OCR identity and every closed image status', () => {
    for (const ocrStatus of ['pending', 'completed', 'unavailable', 'failed', 'oversized'] as const) {
      const parsed = parseClipboardItems([{
        ...clips[0],
        kind: 'image',
        formats: ['image'],
        imageUrl: 'data:image/png;base64,AA==',
        imageHash,
        ocrStatus,
        ...(ocrStatus === 'completed' ? { ocrText: '扫描文字' } : {}),
      }])
      expect(parsed?.[0]).toMatchObject({ imageHash, ocrStatus })
    }

    const image = {
      ...clips[0], kind: 'image', formats: ['image'], imageUrl: 'data:image/png;base64,AA==',
    }
    expect(parseClipboardItems([{ ...image, imageHash: 'A'.repeat(64) }])).toBeNull()
    expect(parseClipboardItems([{ ...image, imageHash: 'a'.repeat(63) }])).toBeNull()
    expect(parseClipboardItems([{ ...image, imageHash: `${'a'.repeat(63)}g` }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], imageHash }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], ocrStatus: 'completed', ocrText: 'invalid' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, ocrStatus: 'pending' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, ocrStatus: 'unavailable' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, ocrStatus: 'failed' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, ocrStatus: 'oversized' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, ocrStatus: 'completed', ocrText: 'legacy' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, imageHash, ocrStatus: 'pending', ocrText: 'too early' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, imageHash, ocrStatus: 'completed' }])).toBeNull()
    expect(parseClipboardItems([{ ...image, imageHash, ocrText: 'missing status' }])).toBeNull()
    for (const ocrStatus of ['unavailable', 'failed', 'oversized'] as const) {
      expect(parseClipboardItems([{ ...image, imageHash, ocrStatus, ocrText: 'stale result' }])).toBeNull()
    }
    expect(parseClipboardItems([{
      ...image, imageHash, ocrStatus: 'completed', ocrText: '',
    }])?.[0]).toMatchObject({ ocrStatus: 'completed', ocrText: '' })
    expect(parseClipboardItems([{
      ...image, imageHash, ocrStatus: 'completed', ocrText: '第一行\r\n第二行',
    }])?.[0]).toMatchObject({ ocrText: '第一行\r\n第二行' })
    for (const ocrText of ['含有\0空字节', '裸换行\n', '裸回车\r']) {
      expect(parseClipboardItems([{
        ...image, imageHash, ocrStatus: 'completed', ocrText,
      }])).toBeNull()
    }
    expect(parseClipboardItems([{
      ...image, imageHash, ocrStatus: 'completed', ocrText: 'a'.repeat(MAX_OCR_TEXT_BYTES),
    }])).not.toBeNull()
    expect(parseClipboardItems([{
      ...image, imageHash, ocrStatus: 'completed', ocrText: 'a'.repeat(MAX_OCR_TEXT_BYTES + 1),
    }])).toBeNull()
  })

  it('parses only canonical non-overlapping omitted format metadata', () => {
    const valid = {
      ...clips[0],
      formats: ['text'],
      omittedFormats: ['html', 'rtf'],
    }

    expect(parseClipboardItems([valid])?.[0]).toMatchObject({
      formats: ['text'],
      omittedFormats: ['html', 'rtf'],
    })
    expect(parseClipboardItems([{ ...valid, omittedFormats: [] }])).toBeNull()
    expect(parseClipboardItems([{ ...valid, omittedFormats: ['html', 'html'] }])).toBeNull()
    expect(parseClipboardItems([{ ...valid, omittedFormats: ['unknown'] }])).toBeNull()
    expect(parseClipboardItems([{ ...valid, omittedFormats: ['rtf', 'html'] }])).toBeNull()
    expect(parseClipboardItems([{ ...valid, formats: ['text', 'html'] }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], omittedFormats: ['text'] }])).toBeNull()
  })

  it('parses a valid non-empty file list without changing file order', () => {
    expect(parseClipboardItems([{
      ...clips[0], kind: 'file', formats: ['files'], files,
    }])?.[0].files).toEqual(files)
  })

  it('normalizes Rust empty file lists away from text and image history records', () => {
    const parsed = parseClipboardItems([{
      ...clips[0],
      formats: ['text'],
      files: [],
      payloadLoaded: true,
      permanent: false,
      updatedAt: '2026-07-19T03:00:00.000Z',
    }, {
      ...clips[1],
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==',
      files: [],
      payloadLoaded: true,
      permanent: false,
      updatedAt: '2026-07-19T03:01:00.000Z',
    }])

    expect(parsed).toEqual([{
      ...clips[0],
      formats: ['text'],
      permanent: false,
      updatedAt: '2026-07-19T03:00:00.000Z',
    }, {
      ...clips[1],
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==',
      permanent: false,
      updatedAt: '2026-07-19T03:01:00.000Z',
    }])
    expect(parsed?.every((item) => !Object.hasOwn(item, 'files'))).toBe(true)
  })

  it('accepts only plain text/code records as permanent snippets', () => {
    const snippet = {
      ...clips[0],
      kind: 'code' as const,
      formats: ['text'] as const,
      permanent: true,
      collectionId: 'snippets',
      updatedAt: '2026-07-19T03:00:00.000Z',
    }

    expect(parseClipboardItems([snippet])?.[0]).toMatchObject(snippet)
    expect(parseClipboardItems([{ ...snippet, kind: 'link' }])).toBeNull()
    expect(parseClipboardItems([{ ...snippet, kind: 'image', formats: ['image'], imageUrl: 'data:image/png;base64,AA==' }])).toBeNull()
    expect(parseClipboardItems([{ ...snippet, kind: 'file', formats: ['files'], files }])).toBeNull()
    expect(parseClipboardItems([{ ...snippet, formats: ['text', 'html'], html: '<b>stale</b>' }])).toBeNull()
    expect(parseClipboardItems([{ ...snippet, omittedFormats: ['html'] }])).toBeNull()
    expect(parseClipboardItems([{ ...snippet, ocrText: 'stale OCR' }])).toBeNull()
    expect(parseClipboardItems([{ ...snippet, color: '#fff' }])).toBeNull()
    expect(parseClipboardItems([{ ...snippet, formats: undefined }])).toBeNull()
  })

  it('rejects malformed rich fields instead of accepting partial persisted records', () => {
    expect(parseClipboardItems([{ ...clips[0], formats: ['text', 'unknown'] }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], files: [{ ...files[0], directory: 'no' }] }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], ocrStatus: 'waiting' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], permanent: 'yes' }])).toBeNull()
  })

  it('rejects persisted combinations whose fields and formats disagree', () => {
    const image = { ...clips[0], kind: 'image', formats: ['image'], imageUrl: 'data:image/png;base64,AA==' }
    const file = { ...clips[0], kind: 'file', formats: ['files'], files }

    expect(parseClipboardItems([{ ...file, files: [] }])).toBeNull()
    expect(parseClipboardItems([{ ...file, html: '<b>invalid</b>' }])).toBeNull()
    expect(parseClipboardItems([{ ...file, formats: ['files', 'image'] }])).toBeNull()
    expect(parseClipboardItems([{ ...image, files }])).toBeNull()
    expect(parseClipboardItems([{ ...image, formats: ['text', 'image'] }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], formats: ['text'], html: '<b>missing format</b>' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], formats: ['text'], rtfBase64: 'e1xydGYxXGFuc2k=' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], formats: ['html'], html: '<b>missing text</b>' }])).toBeNull()
    expect(parseClipboardItems([{ ...clips[0], formats: ['text', 'files'], files }])).toBeNull()
  })

  it('filters pinned items without changing source order', () => {
    expect(applyClipFilter(clips, { query: '', kind: 'pinned' }).map((clip) => clip.id)).toEqual(['b'])
  })

  it('filters permanent snippets and exact selected sources without changing source order', () => {
    const permanent = { ...clips[0], id: 'permanent', permanent: true, sourceApp: '微信' }
    const ordinary = { ...clips[1], id: 'ordinary', permanent: false, sourceApp: '微信' }
    const otherSource = { ...clips[2], id: 'other-source', permanent: true, sourceApp: '飞书' }

    expect(applyClipFilter([permanent, ordinary, otherSource], {
      query: '', kind: 'all', permanent: true, sourceApps: ['微信'],
    }).map((clip) => clip.id)).toEqual(['permanent'])
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
      imageHash,
    }, 'native-2')

    expect(link).toMatchObject({ kind: 'link', sourceApp: 'Microsoft Word', sourceAppIcon })
    expect(link.title).toContain('pasteapp.io')
    expect(image).toMatchObject({
      kind: 'image', dimensions: '1280 × 720', sourceAppIcon, imageHash, ocrStatus: 'pending',
    })
    expect(image.imageUrl).toBe('data:image/png;base64,AA==')
    expect(() => createClipboardItem({
      kind: 'image',
      content: 'data:image/png;base64,AA==',
      capturedAt: '2026-07-18T08:01:00.000Z',
    }, 'missing-hash')).toThrow('图片捕获缺少有效哈希')
  })

  it('moves a repeated capture to the front without creating duplicates', () => {
    const repeated = { ...clips[2], id: 'new-link', copiedAt: '2026-07-18T08:00:00.000Z' }
    const merged = mergeCapturedClip(clips, repeated)

    expect(merged[0].id).toBe('new-link')
    expect(merged.filter((clip) => clip.content === repeated.content)).toHaveLength(1)
  })

  it('promotes a used clip to the front with its latest use time', () => {
    const usedAt = new Date('2026-07-21T12:00:00.000Z')
    const promoted = promoteUsedClip(clips, 'c', usedAt)

    expect(promoted.map((clip) => clip.id)).toEqual(['c', 'a', 'b'])
    expect(promoted[0].copiedAt).toBe(usedAt.toISOString())
    expect(clips[2].copiedAt).not.toBe(usedAt.toISOString())
  })

  it('keeps permanent snippet identity and management metadata when captured again', () => {
    const snippet: LoadedClipboardItem = {
      ...clips[0],
      id: 'permanent-snippet',
      title: '稳定标题',
      content: '相同正文',
      copiedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      pinned: true,
      permanent: true,
      collectionId: 'collection-1',
      formats: ['text'],
    }
    const incoming: LoadedClipboardItem = {
      ...snippet,
      id: 'captured-new-id',
      title: '捕获标题',
      copiedAt: '2026-07-19T00:00:00.000Z',
      updatedAt: undefined,
      pinned: false,
      permanent: false,
      collectionId: undefined,
    }

    expect(mergeCapturedClip([clips[1], snippet], incoming)).toEqual([snippet, clips[1]])
  })

  it('deduplicates images by local hash and reuses terminal OCR without losing management metadata', () => {
    const previous: LoadedClipboardItem = {
      ...clips[0],
      id: 'previous-image',
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,OLD=',
      imageHash,
      ocrStatus: 'completed',
      ocrText: '已识别',
      pinned: true,
      collectionId: 'collection-1',
    }
    const incoming: LoadedClipboardItem = {
      ...previous,
      id: 'incoming-image',
      imageUrl: 'data:image/png;base64,NEW=',
      copiedAt: '2026-07-19T01:00:00.000Z',
      ocrStatus: 'pending',
      ocrText: undefined,
      pinned: false,
      collectionId: undefined,
    }

    expect(mergeCapturedClip([previous], incoming)).toEqual([expect.objectContaining({
      id: 'incoming-image',
      imageUrl: 'data:image/png;base64,NEW=',
      imageHash,
      ocrStatus: 'completed',
      ocrText: '已识别',
      pinned: true,
      collectionId: 'collection-1',
    })])
  })

  it('leaves a same-hash capture pending when a completed native summary omits OCR text', () => {
    const previous: ClipboardItemSummary = {
      id: 'summary-image',
      kind: 'image',
      title: 'summary-image',
      content: 'clipboard image',
      sourceApp: 'SnippingTool',
      copiedAt: '2026-07-19T00:00:00.000Z',
      formats: ['image'],
      imageHash,
      ocrStatus: 'completed',
      pinned: true,
      collectionId: 'collection-1',
      searchTerms: [],
      payloadLoaded: false,
      matchSource: 'none',
    }
    const incoming: LoadedClipboardItem = {
      ...clips[0],
      id: 'incoming-after-summary',
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,NEW=',
      imageHash,
      ocrStatus: 'pending',
      pinned: false,
    }

    const merged = mergeCapturedClip([previous], incoming)[0]
    expect(merged).toMatchObject({
      id: 'incoming-after-summary',
      ocrStatus: 'pending',
      pinned: true,
      collectionId: 'collection-1',
    })
    expect(merged).not.toHaveProperty('ocrText')
  })

  it('reuses completed OCR when a loaded same-hash record contains an empty result', () => {
    const previous: LoadedClipboardItem = {
      ...clips[0],
      id: 'loaded-empty-ocr',
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,OLD=',
      imageHash,
      ocrStatus: 'completed',
      ocrText: '',
    }
    const incoming: LoadedClipboardItem = {
      ...previous,
      id: 'incoming-empty-ocr',
      imageUrl: 'data:image/png;base64,NEW=',
      ocrStatus: 'pending',
      ocrText: undefined,
    }

    expect(mergeCapturedClip([previous], incoming)[0]).toMatchObject({
      id: 'incoming-empty-ocr',
      ocrStatus: 'completed',
      ocrText: '',
    })
  })

  it('does not deduplicate different rich-format payloads with the same plain text', () => {
    const richA: LoadedClipboardItem = { ...clips[0], id: 'rich-a', formats: ['text', 'html'], html: '<b>会议</b>' }
    const richB: LoadedClipboardItem = { ...clips[0], id: 'rich-b', formats: ['text', 'html'], html: '<i>会议</i>' }

    expect(mergeCapturedClip([richA], richB)).toHaveLength(2)
  })

  it.each([
    ['text', { ...clips[0], formats: ['text'] as const }, ['html'] as const],
    ['rich text', { ...clips[0], formats: ['text', 'html'] as const, html: '<b>会议</b>' }, ['rtf'] as const],
    ['image', {
      ...clips[0], kind: 'image' as const, formats: ['image'] as const, imageUrl: 'data:image/png;base64,AA==',
    }, ['text'] as const],
    ['files', {
      ...clips[0], kind: 'file' as const, formats: ['files'] as const, files,
    }, ['text'] as const],
  ])('does not deduplicate %s captures when omitted formats differ', (_case, original, omittedFormats) => {
    const incoming: LoadedClipboardItem = {
      ...original,
      id: `incoming-${original.kind}`,
      formats: [...original.formats],
      omittedFormats: [...omittedFormats],
    }

    expect(mergeCapturedClip([{ ...original, formats: [...original.formats] }], incoming)).toHaveLength(2)
  })

  it('normalizes captured file and rich-text formats so created records remain parseable', () => {
    const capturedFile = createClipboardItem({
      kind: 'file',
      content: '',
      capturedAt: '2026-07-19T04:00:00.000Z',
      files,
      formats: ['text'],
    }, 'captured-file')
    const richA = createClipboardItem({
      kind: 'text',
      content: '同一纯文本',
      capturedAt: '2026-07-19T04:00:00.000Z',
      formats: ['text'],
      html: '<b>同一纯文本</b>',
      rtfBase64: 'e1xydGYxXGFuc2k=',
    }, 'captured-rich-a')
    const richB = createClipboardItem({
      kind: 'text',
      content: '同一纯文本',
      capturedAt: '2026-07-19T04:00:01.000Z',
      html: '<i>同一纯文本</i>',
    }, 'captured-rich-b')

    expect(capturedFile.formats).toEqual(['files'])
    expect(richA.formats).toEqual(['text', 'html', 'rtf'])
    expect(richB.formats).toEqual(['text', 'html'])
    expect(parseClipboardItems([capturedFile, richA, richB])).not.toBeNull()
    expect(mergeCapturedClip([richA], richB)).toHaveLength(2)
    expect(() => createClipboardItem({
      kind: 'file', content: '', capturedAt: '2026-07-19T04:00:02.000Z', files: [],
    }, 'empty-file')).toThrow('文件剪贴板记录不能为空')
  })

  it('normalizes captured omitted formats and rejects overlap or unknown values', () => {
    const readonlyOmissions = ['object', 'rtf', 'html', 'rtf'] as const
    const captured = createClipboardItem({
      kind: 'text',
      content: '降级后的纯文本',
      capturedAt: '2026-07-19T04:00:03.000Z',
      omittedFormats: readonlyOmissions,
    }, 'captured-omitted')
    const withoutOmissions = createClipboardItem({
      kind: 'image',
      content: 'data:image/png;base64,AA==',
      capturedAt: '2026-07-19T04:00:04.000Z',
      imageHash,
      omittedFormats: [],
    }, 'captured-no-omissions')

    expect(captured.omittedFormats).toEqual(['html', 'rtf', 'object'])
    expect(readonlyOmissions).toEqual(['object', 'rtf', 'html', 'rtf'])
    expect(withoutOmissions).not.toHaveProperty('omittedFormats')
    expect(parseClipboardItems([captured, withoutOmissions])).not.toBeNull()
    expect(() => createClipboardItem({
      kind: 'text', content: 'rich', capturedAt: '2026-07-19T04:00:05.000Z', html: '<b>rich</b>', omittedFormats: ['html'],
    }, 'captured-overlap')).toThrow(expect.objectContaining({
      name: 'ClipboardFormatValidationError',
      code: 'omitted-format-overlap',
    }))
    expect(() => createClipboardItem({
      kind: 'text', content: 'plain', capturedAt: '2026-07-19T04:00:06.000Z', omittedFormats: ['unknown'],
    } as never, 'captured-unknown')).toThrow(expect.objectContaining({
      name: 'ClipboardFormatValidationError',
      code: 'unknown-clipboard-format',
    }))
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

  it('retains expired permanent history', () => {
    const now = new Date('2026-08-20T00:00:00.000Z')
    const permanent = { ...clips[0], id: 'permanent-expired', permanent: true }

    expect(pruneExpiredClips([permanent], '30', now)).toEqual([permanent])
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

  it('does not evict permanent history when applying a capacity limit', () => {
    const permanent = { ...clips[0], id: 'permanent', permanent: true }

    expect(limitHistory([clips[0], permanent, { ...clips[0], id: 'ordinary' }], 1)
      .map((clip) => clip.id)).toEqual(['a', 'permanent'])
  })

  it('clears ordinary history while preserving every pinned clip', () => {
    const cleared = clearUnpinnedHistory(clips)

    expect(cleared.items.map((clip) => clip.id)).toEqual(['b'])
    expect(cleared.removedCount).toBe(2)
  })

  it('clears ordinary history while preserving permanent clips', () => {
    const permanent = { ...clips[0], id: 'permanent', permanent: true }

    expect(clearUnpinnedHistory([clips[0], permanent])).toEqual({
      items: [permanent],
      removedCount: 1,
    })
  })
})
