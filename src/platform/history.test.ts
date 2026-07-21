import type { ClipboardItem, ClipboardItemSummary, LoadedClipboardItem } from '../domain/clipboard'
import {
  applyNativeHistoryMutation,
  applyNativeHistoryBatch,
  compactNativeHistoryDatabase,
  commitNativeHistoryRestore,
  createNativeHistoryCollection,
  createIncrementalHistoryPersistence,
  createSerializedHistoryOperationLane,
  createNativeHistoryBackup,
  deleteNativeHistoryCollection,
  discardNativeHistoryRestore,
  getNativeHistoryHealth,
  getNativeStorageStats,
  loadNativeClipThumbnail,
  loadNativeClipPayload,
  loadNativeHistory,
  listNativeHistoryCollections,
  openNativeHistoryDataDirectory,
  prepareNativeHistoryRestore,
  queryNativeHistory,
  renameNativeHistoryCollection,
  saveNativeHistorySnippet,
  type CapacityPolicy,
  type HistoryMutationResult,
  type HistoryInvoke,
  type StorageStats,
} from './history'
import type { HistoryQuery } from '../domain/historyQuery'
import type { BatchAction, BatchTarget, SnippetDraft } from '../domain/collections'

const policy: CapacityPolicy = {
  maxRecords: 500,
  maxImageBytes: 256 * 1024 * 1024,
  retentionDays: 30,
}

const history: LoadedClipboardItem[] = [{
  id: 'clip-1',
  kind: 'text',
  title: '本地历史',
  content: '持久化内容',
  sourceApp: 'Notepad',
  copiedAt: '2026-07-18T09:00:00.000Z',
  pinned: false,
  searchTerms: [],
}, {
  id: 'clip-2',
  kind: 'text',
  title: '不变记录',
  content: 'untouched',
  sourceApp: 'Notepad',
  copiedAt: '2026-07-18T08:00:00.000Z',
  pinned: false,
  searchTerms: [],
}]

const completeItem: LoadedClipboardItem = {
  id: 'complete',
  kind: 'text',
  title: '完整记录',
  content: 'plain text',
  sourceApp: 'Notepad',
  sourceAppIcon: 'data:image/png;base64,AA==',
  copiedAt: '2026-07-18T10:00:00.000Z',
  pinned: false,
  searchTerms: ['alpha', 'beta'],
  imageUrl: 'data:image/png;base64,BB==',
  dimensions: '10 × 20',
  color: '#123456',
  formats: ['text', 'html', 'rtf'],
  omittedFormats: ['image'],
  html: '<p>plain text</p>',
  rtfBase64: 'e1xydGYxIH0=',
  files: [{
    path: 'C:\\tmp\\first.txt',
    name: 'first.txt',
    extension: 'txt',
    size: 10,
    modifiedAt: '2026-07-18T09:00:00.000Z',
    directory: false,
    exists: true,
  }, {
    path: 'C:\\tmp\\folder',
    name: 'folder',
    directory: true,
    exists: true,
  }],
  ocrText: 'recognized text',
  ocrStatus: 'completed',
  collectionId: 'collection-1',
  permanent: false,
  updatedAt: '2026-07-18T10:01:00.000Z',
}

const nativeQuery: HistoryQuery = {
  text: '  文档 ＡＢＣ  ',
  kinds: ['link', 'text', 'link'],
  sourceApps: [' Word ', 'Edge', 'Word'],
  collection: { mode: 'unfiled' },
  pinned: false,
  permanent: true,
  limit: 50,
}

const nextCursor = btoa('1784426400000\nclip-1')
const restoreToken = 'a'.repeat(64)
const imageHash = 'b'.repeat(64)

const storageStats: StorageStats = {
  databaseBytes: 4_096,
  walBytes: 1_024,
  shmBytes: 512,
  totalPhysicalBytes: 5_632,
  recordCount: 8,
  pinnedCount: 2,
  permanentCount: 1,
  imageBytes: 256,
  richFormatBytes: 128,
  fileRecordCount: 1,
  logicalBytes: 2_048,
  oldestCopiedAt: '2026-07-01T00:00:00.000Z',
  newestCopiedAt: '2026-07-18T09:00:00.000Z',
  maxRecords: 500,
  maxImageBytes: 256 * 1024 * 1024,
  retentionDays: 30,
}

function nativeFullItem(item: LoadedClipboardItem) {
  return {
    ...item,
    updatedAt: item.updatedAt ?? item.copiedAt,
    permanent: item.permanent ?? false,
    formats: item.formats ?? ['text'],
    files: item.files ?? [],
    payloadLoaded: true as const,
  }
}

const nativeSummary = {
  ...history[0],
  updatedAt: history[0].copiedAt,
  permanent: false,
  formats: ['text'],
  files: [],
  payloadLoaded: false,
  matchSource: 'none' as const,
}

const requiredNativeItemKeys = [
  'id', 'kind', 'title', 'content', 'sourceApp', 'copiedAt', 'updatedAt', 'pinned',
  'permanent', 'searchTerms', 'formats', 'payloadLoaded', 'files',
] as const

const itemChanges: Array<[string, (item: LoadedClipboardItem) => LoadedClipboardItem]> = [
  ['id', (item) => ({ ...item, id: 'changed-id' })],
  ['kind', (item) => ({ ...item, kind: 'code' })],
  ['title', (item) => ({ ...item, title: 'changed title' })],
  ['content', (item) => ({ ...item, content: 'changed content' })],
  ['sourceApp', (item) => ({ ...item, sourceApp: 'Word' })],
  ['sourceAppIcon', (item) => ({ ...item, sourceAppIcon: 'data:image/png;base64,CC==' })],
  ['copiedAt', (item) => ({ ...item, copiedAt: '2026-07-18T11:00:00.000Z' })],
  ['pinned', (item) => ({ ...item, pinned: true })],
  ['searchTerms order', (item) => ({ ...item, searchTerms: [...item.searchTerms].reverse() })],
  ['imageUrl', (item) => ({ ...item, imageUrl: 'data:image/png;base64,DD==' })],
  ['dimensions', (item) => ({ ...item, dimensions: '20 × 30' })],
  ['color', (item) => ({ ...item, color: '#654321' })],
  ['formats order', (item) => ({ ...item, formats: [...item.formats!].reverse() })],
  ['omittedFormats', (item) => ({ ...item, omittedFormats: ['files'] })],
  ['html', (item) => ({ ...item, html: '<p>changed</p>' })],
  ['rtfBase64', (item) => ({ ...item, rtfBase64: 'changed-rtf' })],
  ['files order', (item) => ({ ...item, files: [...item.files!].reverse() })],
  ['file path', (item) => ({ ...item, files: [{ ...item.files![0], path: 'C:\\tmp\\changed.txt' }, item.files![1]] })],
  ['file name', (item) => ({ ...item, files: [{ ...item.files![0], name: 'changed.txt' }, item.files![1]] })],
  ['file extension', (item) => ({ ...item, files: [{ ...item.files![0], extension: 'md' }, item.files![1]] })],
  ['file size', (item) => ({ ...item, files: [{ ...item.files![0], size: 11 }, item.files![1]] })],
  ['file modifiedAt', (item) => ({ ...item, files: [{ ...item.files![0], modifiedAt: '2026-07-18T09:01:00.000Z' }, item.files![1]] })],
  ['file directory', (item) => ({ ...item, files: [{ ...item.files![0], directory: true }, item.files![1]] })],
  ['file exists', (item) => ({ ...item, files: [{ ...item.files![0], exists: false }, item.files![1]] })],
  ['ocrText', (item) => ({ ...item, ocrText: 'changed OCR' })],
  ['ocrStatus', (item) => ({ ...item, ocrStatus: 'failed' })],
  ['collectionId', (item) => ({ ...item, collectionId: 'collection-2' })],
  ['permanent', (item) => ({ ...item, permanent: true })],
  ['updatedAt', (item) => ({ ...item, updatedAt: '2026-07-18T10:02:00.000Z' })],
]

describe('native clipboard history storage', () => {
  it('opens the managed history data directory without exposing its path to the frontend', async () => {
    const invoke = vi.fn<HistoryInvoke>().mockResolvedValue(true)

    await expect(openNativeHistoryDataDirectory(invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_history_data_directory', {})
  })

  it('parses pathless backup and prepare cancel/success results without leaking file paths', async () => {
    const invoke = vi.fn<HistoryInvoke>()
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'saved' })
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({
        status: 'prepared',
        token: restoreToken,
        currentCount: 8,
        incomingCount: 5,
        schemaVersion: 12,
      })

    await expect(createNativeHistoryBackup(invoke)).resolves.toEqual({ status: 'cancelled' })
    await expect(createNativeHistoryBackup(invoke)).resolves.toEqual({ status: 'saved' })
    await expect(prepareNativeHistoryRestore(invoke)).resolves.toEqual({ status: 'cancelled' })
    await expect(prepareNativeHistoryRestore(invoke)).resolves.toEqual({
      status: 'prepared',
      token: restoreToken,
      currentCount: 8,
      incomingCount: 5,
      schemaVersion: 12,
    })
    expect(invoke.mock.calls).toEqual([
      ['create_history_backup', {}],
      ['create_history_backup', {}],
      ['prepare_history_restore', {}],
      ['prepare_history_restore', {}],
    ])
  })

  it('parses restore commit/discard results and sends only the opaque token', async () => {
    const restoredPolicy = { ...policy, retentionDays: 90 }
    const restoredStats = { ...storageStats, ...restoredPolicy, recordCount: 5 }
    const invoke = vi.fn<HistoryInvoke>()
      .mockResolvedValueOnce({
        status: 'restored',
        importedCount: 5,
        schemaVersion: 12,
        policy: restoredPolicy,
        stats: restoredStats,
      })
      .mockResolvedValueOnce({ status: 'discarded' })

    await expect(commitNativeHistoryRestore(restoreToken, invoke)).resolves.toEqual({
      status: 'restored',
      importedCount: 5,
      schemaVersion: 12,
      policy: restoredPolicy,
      stats: restoredStats,
    })
    await expect(discardNativeHistoryRestore(restoreToken, invoke)).resolves.toEqual({ status: 'discarded' })
    expect(invoke.mock.calls).toEqual([
      ['commit_history_restore', { token: restoreToken }],
      ['discard_history_restore', { token: restoreToken }],
    ])
  })

  it('strictly parses every closed history health state', async () => {
    const invoke = vi.fn<HistoryInvoke>()
      .mockResolvedValueOnce({ status: 'healthy' })
      .mockResolvedValueOnce({
        status: 'recovered',
        reason: 'notADatabase',
        quarantinePath: 'C:\\QuickPaste\\recovery\\history.sqlite3',
      })
      .mockResolvedValueOnce({ status: 'readOnlyError', reason: 'permissionDenied' })
      .mockResolvedValueOnce({
        status: 'readOnlyError',
        reason: 'freshDatabaseFailed',
        recoveryReason: 'corrupt',
        quarantinePath: 'C:\\QuickPaste\\recovery\\history-quarantined.sqlite3',
      })

    await expect(getNativeHistoryHealth(invoke)).resolves.toEqual({ status: 'healthy' })
    await expect(getNativeHistoryHealth(invoke)).resolves.toEqual({
      status: 'recovered',
      reason: 'notADatabase',
      quarantinePath: 'C:\\QuickPaste\\recovery\\history.sqlite3',
    })
    await expect(getNativeHistoryHealth(invoke)).resolves.toEqual({
      status: 'readOnlyError',
      reason: 'permissionDenied',
    })
    await expect(getNativeHistoryHealth(invoke)).resolves.toEqual({
      status: 'readOnlyError',
      reason: 'freshDatabaseFailed',
      recoveryReason: 'corrupt',
      quarantinePath: 'C:\\QuickPaste\\recovery\\history-quarantined.sqlite3',
    })
  })

  it('strictly parses expanded stats and refreshed compact stats', async () => {
    const compacted = { ...storageStats, databaseBytes: 3_000, totalPhysicalBytes: 4_536 }
    const invoke = vi.fn<HistoryInvoke>()
      .mockResolvedValueOnce(storageStats)
      .mockResolvedValueOnce(compacted)

    await expect(getNativeStorageStats(invoke)).resolves.toEqual(storageStats)
    await expect(compactNativeHistoryDatabase(invoke)).resolves.toEqual(compacted)
    expect(invoke.mock.calls).toEqual([
      ['get_storage_stats', {}],
      ['compact_history_database', {}],
    ])
  })

  it.each([
    ['backup unknown field', createNativeHistoryBackup, { status: 'saved', path: 'must-not-leak' }],
    ['backup unknown status', createNativeHistoryBackup, { status: 'failed' }],
    ['prepare missing token', prepareNativeHistoryRestore, {
      status: 'prepared', currentCount: 8, incomingCount: 5, schemaVersion: 12,
    }],
    ['prepare fractional count', prepareNativeHistoryRestore, {
      status: 'prepared', token: restoreToken, currentCount: 8.5, incomingCount: 5, schemaVersion: 12,
    }],
    ['prepare old schema', prepareNativeHistoryRestore, {
      status: 'prepared', token: restoreToken, currentCount: 8, incomingCount: 5, schemaVersion: 6,
    }],
    ['prepare future schema', prepareNativeHistoryRestore, {
      status: 'prepared', token: restoreToken, currentCount: 8, incomingCount: 5, schemaVersion: 13,
    }],
    ['health arbitrary detail', getNativeHistoryHealth, { status: 'readOnlyError', reason: 'io', detail: 'secret' }],
    ['health open reason', getNativeHistoryHealth, { status: 'readOnlyError', reason: 'database exploded' }],
    ['health fresh database missing recovery context', getNativeHistoryHealth, {
      status: 'readOnlyError', reason: 'freshDatabaseFailed',
    }],
    ['health fresh database open recovery reason', getNativeHistoryHealth, {
      status: 'readOnlyError', reason: 'freshDatabaseFailed', recoveryReason: 'unknown', quarantinePath: 'C:\\recovery\\history.db',
    }],
    ['health unrelated read-only path leak', getNativeHistoryHealth, {
      status: 'readOnlyError', reason: 'quarantineFailed', quarantinePath: 'C:\\must-not-leak.db',
    }],
    ['stats mismatched physical total', getNativeStorageStats, { ...storageStats, totalPhysicalBytes: 1 }],
    ['stats unknown field', getNativeStorageStats, { ...storageStats, unexpected: true }],
    ['compact negative bytes', compactNativeHistoryDatabase, { ...storageStats, walBytes: -1 }],
  ] as const)('rejects a malformed native storage result: %s', async (_case, operation, result) => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(result)
    await expect(operation(invoke)).resolves.toBeNull()
  })

  it('rejects malformed restore results, invalid tokens, command failures, and unavailable runtime', async () => {
    const malformedCommit: HistoryInvoke = vi.fn().mockResolvedValue({
      status: 'restored',
      importedCount: 5,
      schemaVersion: 12,
      policy,
      stats: { ...storageStats, retentionDays: 90 },
    })
    const malformedDiscard: HistoryInvoke = vi.fn().mockResolvedValue({ status: 'discarded', unexpected: true })
    const futureSchemaCommit: HistoryInvoke = vi.fn().mockResolvedValue({
      status: 'restored',
      importedCount: storageStats.recordCount,
      schemaVersion: 13,
      policy,
      stats: storageStats,
    })
    const failingInvoke: HistoryInvoke = vi.fn().mockRejectedValue(new Error('private native detail'))
    const invalidTokenInvoke: HistoryInvoke = vi.fn()

    await expect(commitNativeHistoryRestore(restoreToken, malformedCommit)).resolves.toBeNull()
    await expect(commitNativeHistoryRestore(restoreToken, futureSchemaCommit)).resolves.toBeNull()
    await expect(discardNativeHistoryRestore(restoreToken, malformedDiscard)).resolves.toBeNull()
    await expect(createNativeHistoryBackup(failingInvoke)).resolves.toBeNull()
    await expect(commitNativeHistoryRestore(' padded-token', invalidTokenInvoke)).resolves.toBeNull()
    await expect(discardNativeHistoryRestore('bad\ntoken', invalidTokenInvoke)).resolves.toBeNull()
    await expect(commitNativeHistoryRestore('a'.repeat(63), invalidTokenInvoke)).resolves.toBeNull()
    await expect(discardNativeHistoryRestore('A'.repeat(64), invalidTokenInvoke)).resolves.toBeNull()
    await expect(getNativeStorageStats()).resolves.toBeNull()
    expect(invalidTokenInvoke).not.toHaveBeenCalled()
  })

  it('queries a normalized native history page and clones summary data', async () => {
    const rawPage = {
      items: [{ ...nativeSummary, searchTerms: [...nativeSummary.searchTerms] }],
      nextCursor,
      totalCount: 8,
    }
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(rawPage)

    const page = await queryNativeHistory(nativeQuery, invoke)

    expect(invoke).toHaveBeenCalledWith('query_clipboard_history', {
      query: {
        text: '文档 abc',
        kinds: ['text', 'link'],
        sourceApps: ['Edge', 'Word'],
        collection: { mode: 'unfiled' },
        pinned: false,
        permanent: true,
        limit: 50,
      },
    })
    expect(page).toEqual(rawPage)
    rawPage.items[0].searchTerms.push('mutated-after-parse')
    expect(page?.items[0].searchTerms).toEqual([])
  })

  it('preserves a validated cached application icon in native summaries', async () => {
    const sourceAppIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3voZ8QAAAABJRU5ErkJggg=='
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue({
      items: [{ ...nativeSummary, sourceAppIcon }],
      totalCount: 1,
    })

    await expect(queryNativeHistory(nativeQuery, invoke)).resolves.toMatchObject({
      items: [{ sourceAppIcon }],
    })
  })

  it('loads only a bounded PNG thumbnail for an image row', async () => {
    const thumbnail = 'data:image/png;base64,AA=='
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(thumbnail)

    await expect(loadNativeClipThumbnail('image-summary', invoke)).resolves.toBe(thumbnail)
    expect(invoke).toHaveBeenCalledWith('get_clip_thumbnail', { id: 'image-summary' })
  })

  it('rejects invalid thumbnail ids and malformed native thumbnail responses', async () => {
    const invoke: HistoryInvoke = vi.fn()
      .mockResolvedValueOnce('data:image/jpeg;base64,AA==')
      .mockResolvedValueOnce('data:image/png;base64,not base64')

    await expect(loadNativeClipThumbnail(' bad id', invoke)).resolves.toBeNull()
    await expect(loadNativeClipThumbnail('image-summary', invoke)).resolves.toBeNull()
    await expect(loadNativeClipThumbnail('image-summary', invoke)).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('accepts strict OCR identity/status in summaries and full payloads', async () => {
    const summary = {
      ...nativeSummary,
      id: 'image-summary',
      kind: 'image',
      formats: ['image'],
      imageHash,
      ocrStatus: 'completed',
    }
    const full = nativeFullItem({
      ...history[0],
      id: 'image-full',
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==',
      imageHash,
      ocrStatus: 'completed',
      ocrText: 'recognized',
    })
    const invoke: HistoryInvoke = vi.fn()
      .mockResolvedValueOnce({ items: [summary], totalCount: 1 })
      .mockResolvedValueOnce(full)

    await expect(queryNativeHistory(nativeQuery, invoke)).resolves.toMatchObject({
      items: [{ id: 'image-summary', imageHash, ocrStatus: 'completed' }],
    })
    await expect(loadNativeClipPayload('image-full', invoke)).resolves.toMatchObject({
      status: 'loaded',
      item: { imageHash, ocrStatus: 'completed', ocrText: 'recognized' },
    })
  })

  it('rejects malformed OCR hashes at both native history boundaries', async () => {
    const summary = {
      ...nativeSummary,
      id: 'image-summary',
      kind: 'image',
      formats: ['image'],
      imageHash: 'B'.repeat(64),
      ocrStatus: 'pending',
    }
    const full = nativeFullItem({
      ...history[0],
      id: 'image-full',
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==',
      imageHash: 'short',
      ocrStatus: 'pending',
    })
    const invoke: HistoryInvoke = vi.fn()
      .mockResolvedValueOnce({ items: [summary], totalCount: 1 })
      .mockResolvedValueOnce(full)

    await expect(queryNativeHistory(nativeQuery, invoke)).resolves.toBeNull()
    await expect(loadNativeClipPayload('image-full', invoke)).resolves.toEqual({ status: 'failed' })
  })

  it.each([
    ['missing payload marker', { items: [{ ...nativeSummary, payloadLoaded: undefined }], totalCount: 1 }],
    ['missing search projection marker', { items: [{ ...nativeSummary, searchTerms: undefined }], totalCount: 1 }],
    ['missing match source', { items: [{ ...nativeSummary, matchSource: undefined }], totalCount: 1 }],
    ['unknown match source', { items: [{ ...nativeSummary, matchSource: 'guess' }], totalCount: 1 }],
    ['OCR source on non-image summary', { items: [{ ...nativeSummary, matchSource: 'ocr' }], totalCount: 1 }],
    ['full payload in summary', { items: [{ ...nativeSummary, payloadLoaded: true }], totalCount: 1 }],
    ['image blob in summary', { items: [{ ...nativeSummary, imageUrl: 'data:image/png;base64,AA==' }], totalCount: 1 }],
    ['rich payload in summary', { items: [{ ...nativeSummary, html: '<b>secret</b>' }], totalCount: 1 }],
    ['OCR payload in summary', { items: [{ ...nativeSummary, ocrText: 'secret OCR' }], totalCount: 1 }],
    ['search projection in summary', { items: [{ ...nativeSummary, searchTerms: ['secret-index'] }], totalCount: 1 }],
    ['unknown summary field', { items: [{ ...nativeSummary, unexpected: 'secret' }], totalCount: 1 }],
    ['null optional summary field', { items: [{ ...nativeSummary, color: null }], totalCount: 1 }],
    ['undefined required summary field', { items: [{ ...nativeSummary, updatedAt: undefined }], totalCount: 1 }],
    ['undefined optional summary field', { items: [{ ...nativeSummary, color: undefined }], totalCount: 1 }],
    ['unbounded plain payload in summary', { items: [{ ...nativeSummary, content: 'x'.repeat(513) }], totalCount: 1 }],
    ['invalid total', { items: [nativeSummary], totalCount: -1 }],
    ['fractional total', { items: [nativeSummary], totalCount: 1.5 }],
    ['total below page size', { items: [nativeSummary], totalCount: 0 }],
    ['empty cursor', { items: [nativeSummary], nextCursor: '', totalCount: 1 }],
    ['padded cursor', { items: [nativeSummary], nextCursor: ' next', totalCount: 1 }],
    ['opaque cursor', { items: [nativeSummary], nextCursor: 'next-page', totalCount: 1 }],
    ['duplicate ids', { items: [nativeSummary, { ...nativeSummary }], totalCount: 2 }],
  ])('rejects a malformed native history page: %s', async (_case, response) => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(response)
    await expect(queryNativeHistory(nativeQuery, invoke)).resolves.toBeNull()
  })

  it.each(requiredNativeItemKeys)(
    'rejects a native summary missing required key %s',
    async (key) => {
      const missing = { ...nativeSummary } as Record<string, unknown>
      delete missing[key]
      const invoke: HistoryInvoke = vi.fn().mockResolvedValue({ items: [missing], totalCount: 1 })
      await expect(queryNativeHistory(nativeQuery, invoke)).resolves.toBeNull()
    },
  )

  it('fast-fails an invalid query before invoking native code', async () => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue({ items: [], totalCount: 0 })
    await expect(queryNativeHistory({ ...nativeQuery, limit: 0 }, invoke)).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns null without native runtime and converts a rejected query invoke to null', async () => {
    const rejectedInvoke: HistoryInvoke = vi.fn().mockRejectedValue(new Error('database unavailable'))
    await expect(queryNativeHistory(nativeQuery)).resolves.toBeNull()
    await expect(queryNativeHistory(nativeQuery, rejectedInvoke)).resolves.toBeNull()
    expect(rejectedInvoke).toHaveBeenCalledOnce()
  })

  it('distinguishes loaded, missing, and failed payload hydration results', async () => {
    const loadedItem: LoadedClipboardItem = {
      ...history[0], formats: ['text'], updatedAt: history[0].copiedAt, permanent: false,
    }
    const loadedRaw = nativeFullItem(loadedItem)
    const invoke: HistoryInvoke = vi.fn()
      .mockResolvedValueOnce(loadedRaw)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...loadedRaw, payloadLoaded: false })
      .mockResolvedValueOnce({ ...loadedRaw, payloadLoaded: undefined })
      .mockResolvedValueOnce({ ...loadedRaw, unexpected: true })
      .mockRejectedValueOnce(new Error('database unavailable'))

    const loaded = await loadNativeClipPayload('clip-1', invoke)
    expect(loaded).toEqual({ status: 'loaded', item: loadedItem })
    loadedRaw.searchTerms.push('mutated-after-hydration')
    expect(loaded.status === 'loaded' ? loaded.item.searchTerms : []).toEqual([])
    await expect(loadNativeClipPayload('clip-1', invoke)).resolves.toEqual({ status: 'missing' })
    await expect(loadNativeClipPayload('clip-1', invoke)).resolves.toEqual({ status: 'failed' })
    await expect(loadNativeClipPayload('clip-1', invoke)).resolves.toEqual({ status: 'failed' })
    await expect(loadNativeClipPayload('clip-1', invoke)).resolves.toEqual({ status: 'failed' })
    await expect(loadNativeClipPayload('clip-1', invoke)).resolves.toEqual({ status: 'failed' })
    expect(invoke).toHaveBeenNthCalledWith(1, 'get_clip_payload', { id: 'clip-1' })
  })

  it('fails payload hydration when no native runtime is available', async () => {
    await expect(loadNativeClipPayload('clip-1')).resolves.toEqual({ status: 'failed' })
  })

  it.each([
    ['null optional field', { color: null }],
    ['undefined required field', { updatedAt: undefined }],
    ['undefined optional field', { color: undefined }],
  ])('rejects %s in a native full payload', async (_case, invalidField) => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue({ ...nativeFullItem(history[0]), ...invalidField })
    await expect(loadNativeClipPayload('clip-1', invoke)).resolves.toEqual({ status: 'failed' })
  })

  it.each(['', ' padded', 'padded ', 'padded\uFEFF', '\u0085padded', 'bad\nvalue', 'x'.repeat(364)])(
    'fast-fails an invalid payload id %j',
    async (id) => {
      const invoke: HistoryInvoke = vi.fn()
      await expect(loadNativeClipPayload(id, invoke)).resolves.toEqual({ status: 'failed' })
      expect(invoke).not.toHaveBeenCalled()
    },
  )

  it('loads history through the Tauri command boundary', async () => {
    const nativeHistory = history.map(nativeFullItem)
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(nativeHistory)

    await expect(loadNativeHistory(invoke)).resolves.toEqual(nativeHistory.map(({ payloadLoaded: _marker, files: _files, ...item }) => item))
    expect(invoke).toHaveBeenCalledWith('load_clipboard_history', {})
  })

  it('accepts the native omittedFormats serde shape without dropping it', async () => {
    const nativeRecord = nativeFullItem({
      ...history[0],
      formats: ['text'],
      omittedFormats: ['html', 'rtf'],
    })
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue([nativeRecord])

    const { payloadLoaded: _marker, files: _files, ...expected } = nativeRecord
    await expect(loadNativeHistory(invoke)).resolves.toEqual([expected])
  })

  it('distinguishes an empty native history from a load failure', async () => {
    const emptyInvoke: HistoryInvoke = vi.fn().mockResolvedValue([])
    const failingInvoke: HistoryInvoke = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const malformedInvoke: HistoryInvoke = vi.fn().mockResolvedValue({ unexpected: true })

    await expect(loadNativeHistory(emptyInvoke)).resolves.toEqual([])
    await expect(loadNativeHistory(failingInvoke)).resolves.toBeNull()
    await expect(loadNativeHistory(malformedInvoke)).resolves.toBeNull()
  })

  it('strictly rejects malformed or legacy-shaped native full records', async () => {
    const malformedInvoke: HistoryInvoke = vi.fn().mockResolvedValue([
      { ...history[0], searchTerms: ['valid', 42] },
    ])
    const [{ searchTerms: _searchTerms, ...legacyRecord }] = history
    const legacyInvoke: HistoryInvoke = vi.fn().mockResolvedValue([legacyRecord])

    await expect(loadNativeHistory(malformedInvoke)).resolves.toBeNull()
    await expect(loadNativeHistory(legacyInvoke)).resolves.toBeNull()
  })

  it('applies one mutation through the required Tauri command boundary', async () => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue({ prunedIds: ['clip-2'] })
    const mutation = { upserts: [history[0]], deleteIds: [], policy }

    await expect(applyNativeHistoryMutation(mutation, invoke)).resolves.toEqual({ prunedIds: ['clip-2'] })
    expect(invoke).toHaveBeenCalledWith('apply_history_mutation', mutation)
  })

  it.each([
    ['undefined', undefined],
    ['missing prunedIds', {}],
    ['duplicate ids', { prunedIds: ['clip-1', 'clip-1'] }],
    ['empty id', { prunedIds: [''] }],
    ['whitespace id', { prunedIds: ['   '] }],
    ['non-string id', { prunedIds: [42] }],
    ['non-array prunedIds', { prunedIds: 'clip-1' }],
    ['unknown result field', { prunedIds: [], unexpected: true }],
    ['control character id', { prunedIds: ['clip\n1'] }],
    ['oversized id', { prunedIds: ['x'.repeat(10_000)] }],
  ])('rejects a malformed mutation result: %s', async (_case, result) => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(result)
    const mutation = { upserts: [history[0]], deleteIds: [], policy }

    await expect(applyNativeHistoryMutation(mutation, invoke)).resolves.toBeNull()
  })

  it('returns null when a mutation fails or no Tauri adapter is available', async () => {
    const failingInvoke: HistoryInvoke = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const mutation = { upserts: [history[0]], deleteIds: [], policy }

    await expect(applyNativeHistoryMutation(mutation, failingInvoke)).resolves.toBeNull()
    await expect(applyNativeHistoryMutation(mutation)).resolves.toBeNull()
  })

  it('uses strict collection command boundaries without exposing database details', async () => {
    const collection = {
      id: 'collection-1',
      name: '工作',
      createdAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:00:00.000Z',
      sortOrder: 0,
    }
    const renamed = {
      ...collection,
      name: '常用',
      updatedAt: '2026-07-18T10:01:00.000Z',
    }
    const invoke = vi.fn<HistoryInvoke>()
      .mockResolvedValueOnce([collection])
      .mockResolvedValueOnce(collection)
      .mockResolvedValueOnce(renamed)
      .mockResolvedValueOnce({ affectedCount: 3 })

    await expect(listNativeHistoryCollections(invoke)).resolves.toEqual([collection])
    await expect(createNativeHistoryCollection('  工作  ', invoke)).resolves.toEqual(collection)
    await expect(renameNativeHistoryCollection('collection-1', ' 常用 ', invoke)).resolves.toEqual(renamed)
    await expect(deleteNativeHistoryCollection('collection-1', invoke)).resolves.toEqual({ affectedCount: 3 })
    expect(invoke.mock.calls).toEqual([
      ['list_history_collections', {}],
      ['create_history_collection', { name: '工作' }],
      ['rename_history_collection', { id: 'collection-1', name: '常用' }],
      ['delete_history_collection', { id: 'collection-1' }],
    ])
  })

  it('saves a normalized plain permanent snippet and applies a normalized batch exactly once', async () => {
    const draft: SnippetDraft = {
      title: '  发布命令  ',
      content: ' npm run build\n',
      collectionId: 'collection-1',
      kind: 'code',
    }
    const saved = nativeFullItem({
      id: 'snippet-1',
      title: '发布命令',
      content: draft.content,
      collectionId: 'collection-1',
      kind: 'code',
      sourceApp: 'QuickPaste',
      copiedAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:01:00.000Z',
      permanent: true,
      pinned: false,
      formats: ['text'],
      searchTerms: [],
    })
    const target: BatchTarget = { mode: 'ids', ids: ['clip-2', 'clip-1', 'clip-2'] }
    const action: BatchAction = { type: 'setPinned', pinned: true }
    const batchResult = { matchedCount: 2, changedCount: 1, deletedCount: 0, prunedIds: [] }
    const invoke = vi.fn<HistoryInvoke>()
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(batchResult)

    await expect(saveNativeHistorySnippet(draft, invoke)).resolves.toMatchObject({
      id: 'snippet-1', title: '发布命令', permanent: true, kind: 'code', formats: ['text'],
    })
    await expect(applyNativeHistoryBatch(target, action, invoke)).resolves.toEqual(batchResult)
    expect(invoke.mock.calls).toEqual([
      ['save_history_snippet', {
        draft: { ...draft, title: '发布命令' },
      }],
      ['apply_history_batch', {
        target: { mode: 'ids', ids: ['clip-2', 'clip-1'] },
        action,
      }],
    ])
  })

  it.each([
    ['collection list duplicate', () => listNativeHistoryCollections, [{
      id: 'collection-1', name: '工作', createdAt: '2026-07-18T10:00:00.000Z', updatedAt: '2026-07-18T10:00:00.000Z', sortOrder: 0,
    }, {
      id: 'collection-1', name: '其他', createdAt: '2026-07-18T10:00:00.000Z', updatedAt: '2026-07-18T10:00:00.000Z', sortOrder: 1,
    }]],
    ['collection delete extra field', () => deleteNativeHistoryCollection, { affectedCount: 1, path: 'private' }],
    ['collection delete unsafe count', () => deleteNativeHistoryCollection, { affectedCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['batch inconsistent counts', () => applyNativeHistoryBatch, { matchedCount: 1, changedCount: 2, deletedCount: 0, prunedIds: [] }],
  ] as const)('rejects malformed v0.5 native results: %s', async (_case, getOperation, result) => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(result)
    const operation = getOperation()
    if (operation === listNativeHistoryCollections) {
      await expect(operation(invoke)).resolves.toBeNull()
    } else if (operation === deleteNativeHistoryCollection) {
      await expect(operation('collection-1', invoke)).resolves.toBeNull()
    } else {
      await expect(applyNativeHistoryBatch(
        { mode: 'ids', ids: ['clip-1'] },
        { type: 'delete' },
        invoke,
      )).resolves.toBeNull()
    }
  })

  it('fast-fails invalid v0.5 command inputs before invoking native code', async () => {
    const invoke: HistoryInvoke = vi.fn()
    await expect(createNativeHistoryCollection('   ', invoke)).resolves.toBeNull()
    await expect(renameNativeHistoryCollection('bad\nid', 'valid', invoke)).resolves.toBeNull()
    await expect(deleteNativeHistoryCollection('', invoke)).resolves.toBeNull()
    await expect(saveNativeHistorySnippet({ title: 'empty', content: '   ', kind: 'text' }, invoke)).resolves.toBeNull()
    await expect(applyNativeHistoryBatch(
      { mode: 'ids', ids: ['bad\nid'] },
      { type: 'delete' },
      invoke,
    )).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('orders pending flush, one native mutation, canonical refresh, baseline reset, and UI commit', async () => {
    const events: string[] = []
    const pending = [{ ...history[0], pinned: true }, history[1]]
    const refreshed = [{ ...history[0], pinned: true }, { ...history[1], collectionId: 'collection-1' }]
    const persistence = createIncrementalHistoryPersistence(async () => {
      events.push('flush')
      return { prunedIds: [] }
    })
    persistence.reset(history, policy)
    persistence.schedule(history, pending, policy)
    const lane = createSerializedHistoryOperationLane(persistence)

    const result = await lane.run({
      mutate: async () => {
        events.push('mutate')
        return { affectedCount: 1 }
      },
      refresh: async () => {
        events.push('refresh')
        return { items: refreshed, policy }
      },
      commit: () => {
        events.push('commit')
      },
    })

    expect(result).toEqual({ status: 'committed', value: { affectedCount: 1 } })
    expect(events).toEqual(['flush', 'mutate', 'refresh', 'commit'])
    expect(persistence.isFrozen()).toBe(false)
    expect(persistence.isDirty()).toBe(false)
  })

  it('serializes concurrent manager writes instead of attempting overlapping leases', async () => {
    let resolveFirst: ((value: { id: string }) => void) | undefined
    const firstGate = new Promise<{ id: string }>((resolve) => { resolveFirst = resolve })
    const started: string[] = []
    const persistence = createIncrementalHistoryPersistence(async () => ({ prunedIds: [] }))
    persistence.reset(history, policy)
    const lane = createSerializedHistoryOperationLane(persistence)
    const snapshot = { items: history, policy }

    const first = lane.run({
      mutate: async () => {
        started.push('first')
        return firstGate
      },
      refresh: async () => snapshot,
      commit: () => undefined,
    })
    const second = lane.run({
      mutate: async () => {
        started.push('second')
        return { id: 'second' }
      },
      refresh: async () => snapshot,
      commit: () => undefined,
    })

    await vi.waitFor(() => expect(started).toEqual(['first']))
    expect(lane.isBusy()).toBe(true)
    resolveFirst?.({ id: 'first' })
    await expect(first).resolves.toEqual({ status: 'committed', value: { id: 'first' } })
    await expect(second).resolves.toEqual({ status: 'committed', value: { id: 'second' } })
    expect(started).toEqual(['first', 'second'])
    expect(lane.isBusy()).toBe(false)
  })

  it('keeps the current state on mutation failure and never performs a speculative refresh', async () => {
    const persistence = createIncrementalHistoryPersistence(async () => ({ prunedIds: [] }))
    persistence.reset(history, policy)
    const lane = createSerializedHistoryOperationLane(persistence)
    const refresh = vi.fn()
    const commit = vi.fn()

    await expect(lane.run({
      mutate: async () => null,
      refresh,
      commit,
    })).resolves.toEqual({ status: 'failed' })
    await expect(lane.run({
      mutate: async () => { throw new Error('private native failure') },
      refresh,
      commit,
    })).resolves.toEqual({ status: 'failed' })
    expect(refresh).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(persistence.isFrozen()).toBe(false)
  })

  it('discards a stale refresh response without resetting the confirmed baseline', async () => {
    let resolveRefresh: ((snapshot: { items: ClipboardItem[]; policy: CapacityPolicy }) => void) | undefined
    const refreshGate = new Promise<{ items: ClipboardItem[]; policy: CapacityPolicy }>((resolve) => {
      resolveRefresh = resolve
    })
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset(history, policy)
    const lane = createSerializedHistoryOperationLane(persistence)
    const commit = vi.fn()
    const staleItems = [{ ...history[0], pinned: true }, history[1]]

    const running = lane.run({
      mutate: async () => ({ changed: true }),
      refresh: async () => refreshGate,
      commit,
    })
    await vi.waitFor(() => expect(lane.isBusy()).toBe(true))
    lane.invalidate()
    resolveRefresh?.({ items: staleItems, policy })

    await expect(running).resolves.toEqual({
      status: 'committedRefreshFailed',
      value: { changed: true },
    })
    expect(commit).not.toHaveBeenCalled()
    persistence.schedule(history, history, policy)
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).not.toHaveBeenCalled()
    expect(persistence.isFrozen()).toBe(false)
  })

  it('reset establishes a confirmed baseline without sending a mutation', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)

    persistence.reset(history, policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).not.toHaveBeenCalled()
    expect(persistence.isDirty()).toBe(false)
  })

  it('acknowledges an external OCR patch before Vue schedules it without re-upserting the image', async () => {
    const image: LoadedClipboardItem = {
      ...history[0],
      id: 'ocr-image',
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==',
      imageHash,
      ocrStatus: 'pending',
    }
    const completed: LoadedClipboardItem = { ...image, ocrStatus: 'completed', ocrText: 'local text' }
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset([image], policy)

    expect(persistence.acknowledgeExternalOcrPatch('ocr-image', imageHash, {
      ocrStatus: 'completed',
      ocrText: 'local text',
    })).toBe(true)
    persistence.schedule([image], [completed], policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('preserves concurrent management changes while acknowledging OCR and rejects stale hashes', async () => {
    const image: LoadedClipboardItem = {
      ...history[0],
      id: 'ocr-image',
      kind: 'image',
      formats: ['image'],
      imageUrl: 'data:image/png;base64,AA==',
      imageHash,
      ocrStatus: 'pending',
    }
    const managed = { ...image, pinned: true, collectionId: 'collection-1' }
    const completed = { ...managed, ocrStatus: 'completed' as const, ocrText: 'local text' }
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset([image], policy)
    persistence.schedule([image], [managed], policy)

    expect(persistence.acknowledgeExternalOcrPatch('ocr-image', 'c'.repeat(64), {
      ocrStatus: 'failed',
    })).toBe(false)
    expect(persistence.acknowledgeExternalOcrPatch('ocr-image', imageHash, {
      ocrStatus: 'completed',
      ocrText: 'local text',
    })).toBe(true)
    persistence.schedule([managed], [completed], policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0][0].upserts[0]).toMatchObject({
      id: 'ocr-image',
      pinned: true,
      collectionId: 'collection-1',
      imageHash,
      ocrStatus: 'completed',
      ocrText: 'local text',
    })
  })

  it('sends only the pinned record as an upsert', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledWith({ upserts: [pinned[0]], deleteIds: [], policy })
  })

  it('keeps summary app icons in memory but excludes them from native mutations', async () => {
    const sourceAppIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3voZ8QAAAABJRU5ErkJggg=='
    const summary: ClipboardItemSummary = {
      id: nativeSummary.id,
      kind: nativeSummary.kind,
      title: nativeSummary.title,
      content: nativeSummary.content,
      sourceApp: nativeSummary.sourceApp,
      sourceAppIcon,
      copiedAt: nativeSummary.copiedAt,
      updatedAt: nativeSummary.updatedAt,
      pinned: nativeSummary.pinned,
      permanent: nativeSummary.permanent,
      formats: ['text'],
      files: [],
      searchTerms: [],
      payloadLoaded: false,
      matchSource: 'none',
    }
    const pinned: ClipboardItemSummary = { ...summary, pinned: true }
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset([summary], policy)
    persistence.schedule([summary], [pinned], policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply.mock.calls[0][0].upserts[0]).not.toHaveProperty('sourceAppIcon')
    expect(summary.sourceAppIcon).toBe(sourceAppIcon)
  })

  it('sends only a removed id as a delete', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset(history, policy)
    persistence.schedule(history, [history[0]], policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledWith({ upserts: [], deleteIds: ['clip-2'], policy })
  })

  it('does not send a mutation for an unchanged state', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset(history, policy)
    persistence.schedule(history, history.map((clip) => ({ ...clip })), { ...policy })

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('treats different object property insertion order as the same item', async () => {
    const original: LoadedClipboardItem = {
      id: 'ordered',
      kind: 'text',
      title: '顺序无关',
      content: 'same content',
      sourceApp: 'Notepad',
      copiedAt: '2026-07-18T09:00:00.000Z',
      pinned: false,
      searchTerms: ['same'],
      formats: ['text', 'html'],
      html: '<p>same content</p>',
    }
    const reordered: LoadedClipboardItem = {
      html: '<p>same content</p>',
      formats: ['text', 'html'],
      searchTerms: ['same'],
      pinned: false,
      copiedAt: '2026-07-18T09:00:00.000Z',
      sourceApp: 'Notepad',
      content: 'same content',
      title: '顺序无关',
      kind: 'text',
      id: 'ordered',
    }
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset([original], policy)
    persistence.schedule([original], [reordered], policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it.each(itemChanges)('detects a changed ClipboardItem %s field', async (_field, change) => {
    const changed = change(completeItem)
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset([completeItem], policy)
    persistence.schedule([completeItem], [changed], policy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledWith({
      upserts: [changed],
      deleteIds: changed.id === completeItem.id ? [] : [completeItem.id],
      policy,
    })
  })

  it('sends an empty delta when only the capacity policy changed', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const changedPolicy = { ...policy, retentionDays: null }
    persistence.reset(history, policy)
    persistence.schedule(history, history, changedPolicy)

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledWith({ upserts: [], deleteIds: [], policy: changedPolicy })
  })

  it('serializes an in-flight flush and converges on the latest target', async () => {
    let finishFirst: ((result: HistoryMutationResult | null) => void) | undefined
    const apply = vi.fn()
      .mockImplementationOnce(() => new Promise<HistoryMutationResult | null>((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    const renamed = [{ ...pinned[0], title: '最新标题' }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)
    const flushing = persistence.flush()
    persistence.schedule(pinned, renamed, policy)
    finishFirst?.({ prunedIds: [] })

    await expect(flushing).resolves.toBe(true)
    expect(apply.mock.calls).toEqual([
      [{ upserts: [pinned[0]], deleteIds: [], policy }],
      [{ upserts: [renamed[0]], deleteIds: [], policy }],
    ])
  })

  it('converges confirmed and target state after capacity pruning without reinserting rows', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: ['clip-2'] })
    const onCapacityPruned = vi.fn()
    const persistence = createIncrementalHistoryPersistence(apply, { onCapacityPruned })
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)

    await expect(persistence.flush()).resolves.toBe(true)
    await expect(persistence.flush()).resolves.toBe(true)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(onCapacityPruned).toHaveBeenCalledOnce()
    expect(onCapacityPruned).toHaveBeenCalledWith(['clip-2'])
    expect(persistence.isDirty()).toBe(false)
  })

  it('persists a new change scheduled synchronously from the capacity-pruned callback', async () => {
    const third = { ...history[1], id: 'clip-3', title: '随后固定' }
    const initial = [...history, third]
    const firstTarget = [{ ...history[0], pinned: true }, history[1], third]
    const latestTarget = [firstTarget[0], { ...third, pinned: true }]
    const apply = vi.fn()
      .mockResolvedValueOnce({ prunedIds: ['clip-2'] })
      .mockResolvedValueOnce({ prunedIds: [] })
    let persistence: ReturnType<typeof createIncrementalHistoryPersistence>
    const onCapacityPruned = vi.fn(() => {
      persistence.schedule(firstTarget, latestTarget, policy)
    })
    persistence = createIncrementalHistoryPersistence(apply, { onCapacityPruned })
    persistence.reset(initial, policy)
    persistence.schedule(initial, firstTarget, policy)

    await expect(persistence.flush()).resolves.toBe(true)

    expect(onCapacityPruned).toHaveBeenCalledWith(['clip-2'])
    expect(apply.mock.calls).toEqual([
      [{ upserts: [firstTarget[0]], deleteIds: [], policy }],
      [{ upserts: [latestTarget[1]], deleteIds: [], policy }],
    ])
    expect(persistence.isDirty()).toBe(false)
  })

  it('keeps and re-upserts a pruned in-flight row that changed in the latest target', async () => {
    let finishFirst: ((result: HistoryMutationResult | null) => void) | undefined
    const apply = vi.fn()
      .mockImplementationOnce(() => new Promise<HistoryMutationResult | null>((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce({ prunedIds: [] })
    const onCapacityPruned = vi.fn()
    const persistence = createIncrementalHistoryPersistence(apply, { onCapacityPruned })
    const firstTarget = [{ ...history[0], pinned: true }, history[1]]
    const latestTarget = [firstTarget[0], { ...history[1], pinned: true, title: '并发固定' }]
    persistence.reset(history, policy)
    persistence.schedule(history, firstTarget, policy)
    const flushing = persistence.flush()
    persistence.schedule(firstTarget, latestTarget, policy)
    finishFirst?.({ prunedIds: ['clip-2'] })

    await expect(flushing).resolves.toBe(true)

    expect(apply.mock.calls).toEqual([
      [{ upserts: [firstTarget[0]], deleteIds: [], policy }],
      [{ upserts: [latestTarget[1]], deleteIds: [], policy }],
    ])
    expect(onCapacityPruned).not.toHaveBeenCalled()
    expect(persistence.isDirty()).toBe(false)
  })

  it('keeps dirty after a failure and retries the latest delta from the confirmed baseline', async () => {
    const apply = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ prunedIds: [] })
    const onSaveFailed = vi.fn()
    const persistence = createIncrementalHistoryPersistence(apply, { onSaveFailed })
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    const renamed = [{ ...pinned[0], title: '最新标题' }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)

    await expect(persistence.flush()).resolves.toBe(false)
    persistence.schedule(pinned, renamed, policy)
    await expect(persistence.flush()).resolves.toBe(true)

    expect(onSaveFailed).toHaveBeenCalledOnce()
    expect(apply.mock.calls).toEqual([
      [{ upserts: [pinned[0]], deleteIds: [], policy }],
      [{ upserts: [renamed[0]], deleteIds: [], policy }],
    ])
    expect(persistence.isDirty()).toBe(false)
  })

  it('converts an apply rejection into a failed flush while keeping the queue dirty', async () => {
    const apply = vi.fn().mockRejectedValue(new Error('IPC rejected'))
    const onSaveFailed = vi.fn()
    const persistence = createIncrementalHistoryPersistence(apply, { onSaveFailed })
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)

    await expect(persistence.flush()).resolves.toBe(false)
    expect(persistence.isDirty()).toBe(true)
    expect(onSaveFailed).toHaveBeenCalledOnce()
  })

  it('does not let an in-flight success replace a newer reset baseline', async () => {
    let finishApply: ((result: HistoryMutationResult | null) => void) | undefined
    const apply = vi.fn().mockImplementation(() => new Promise<HistoryMutationResult | null>((resolve) => { finishApply = resolve }))
    const persistence = createIncrementalHistoryPersistence(apply)
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)
    const flushing = persistence.flush()

    persistence.reset([history[1]], policy)
    finishApply?.({ prunedIds: [] })

    await expect(flushing).resolves.toBe(true)
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(persistence.isDirty()).toBe(false)
  })

  it('ignores an in-flight failure after reset without restoring dirty or reporting failure', async () => {
    let failApply: ((reason?: unknown) => void) | undefined
    const apply = vi.fn().mockImplementation(() => new Promise<HistoryMutationResult | null>((_resolve, reject) => { failApply = reject }))
    const onSaveFailed = vi.fn()
    const persistence = createIncrementalHistoryPersistence(apply, { onSaveFailed })
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)
    const flushing = persistence.flush()

    persistence.reset([history[1]], policy)
    failApply?.(new Error('stale IPC failure'))

    await expect(flushing).resolves.toBe(true)
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(persistence.isDirty()).toBe(false)
    expect(onSaveFailed).not.toHaveBeenCalled()
  })

  it('snapshots scheduled records before callers mutate them in place', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const next = [{ ...history[0], pinned: true }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, next, policy)
    next[0].title = '调用方后续修改'

    await persistence.flush()
    expect(apply).toHaveBeenCalledWith({
      upserts: [{ ...history[0], pinned: true }],
      deleteIds: [],
      policy,
    })
  })

  it('snapshots omitted format arrays before callers mutate them in place', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const omittedFormats: NonNullable<ClipboardItem['omittedFormats']> = ['html', 'rtf']
    const next: ClipboardItem[] = [{ ...history[0], pinned: true, omittedFormats }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, next, policy)
    omittedFormats.push('files')

    await persistence.flush()
    expect(apply).toHaveBeenCalledWith({
      upserts: [{ ...history[0], pinned: true, omittedFormats: ['html', 'rtf'] }],
      deleteIds: [],
      policy,
    })
  })

  it('freezes synchronously before draining and defers schedules until the exclusive lease releases', async () => {
    let finishDrain: ((result: HistoryMutationResult | null) => void) | undefined
    const apply = vi.fn()
      .mockImplementationOnce(() => new Promise<HistoryMutationResult | null>((resolve) => { finishDrain = resolve }))
      .mockResolvedValueOnce({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    const renamed = [{ ...pinned[0], title: '冻结期间的新标题' }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)

    const acquiring = persistence.acquireExclusiveLease()
    expect(persistence.isFrozen()).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    persistence.schedule(pinned, renamed, policy)
    expect(apply).toHaveBeenCalledTimes(1)
    finishDrain?.({ prunedIds: [] })

    const lease = await acquiring
    expect(persistence.isFrozen()).toBe(true)
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)

    lease.release()
    expect(persistence.isFrozen()).toBe(false)
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply.mock.calls).toEqual([
      [{ upserts: [pinned[0]], deleteIds: [], policy }],
      [{ upserts: [renamed[0]], deleteIds: [], policy }],
    ])
  })

  it('atomically releases a failed drain without changing the confirmed baseline', async () => {
    const apply = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const pinned = [{ ...history[0], pinned: true }, history[1]]
    const renamed = [{ ...pinned[0], title: '失败期间保留的标题' }, history[1]]
    persistence.reset(history, policy)
    persistence.schedule(history, pinned, policy)

    const acquiring = persistence.acquireExclusiveLease()
    expect(persistence.isFrozen()).toBe(true)
    persistence.schedule(pinned, renamed, policy)

    await expect(acquiring).rejects.toThrow('历史写入队列尚未排空')
    expect(persistence.isFrozen()).toBe(false)
    expect(persistence.isDirty()).toBe(true)
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply.mock.calls).toEqual([
      [{ upserts: [pinned[0]], deleteIds: [], policy }],
      [{ upserts: [renamed[0]], deleteIds: [], policy }],
    ])
  })

  it('rebases frozen capture deltas onto a restored baseline without restoring the old policy', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const captured = { ...history[0], id: 'captured-during-restore', title: '恢复期间捕获' }
    const restored = [{ ...history[1], id: 'restored-only', title: '来自备份' }]
    const restoredPolicy = { ...policy, maxRecords: 800, retentionDays: 90 }
    persistence.reset(history, policy)

    const lease = await persistence.acquireExclusiveLease()
    persistence.schedule(history, [captured, ...history], policy)
    persistence.reset(restored, restoredPolicy)
    lease.release()

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledWith({
      upserts: [captured],
      deleteIds: [],
      policy: restoredPolicy,
    })
  })

  it('preserves a restored same-id row when a frozen schedule modified an older value', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const locallyPinned = [{ ...history[0], pinned: true }, history[1]]
    const restored = [{ ...history[0], title: '备份中的新正文', content: 'restored body' }, history[1]]
    persistence.reset(history, policy)

    const lease = await persistence.acquireExclusiveLease()
    persistence.schedule(history, locallyPinned, policy)
    persistence.reset(restored, policy)
    lease.release()

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('preserves a restored same-id row when a frozen schedule deleted an older value', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    const restored = [{ ...history[0], title: '备份中仍存在', content: 'restored body' }, history[1]]
    persistence.reset(history, policy)

    const lease = await persistence.acquireExclusiveLease()
    persistence.schedule(history, [history[1]], policy)
    persistence.reset(restored, policy)
    lease.release()

    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('coalesces repeated frozen changes for the same id into one bounded net delta', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset(history, policy)

    const lease = await persistence.acquireExclusiveLease()
    let previous: ClipboardItem[] = history
    for (let index = 1; index <= 500; index += 1) {
      const next = [{ ...history[0], title: `冻结变更 ${index}` }, history[1]]
      persistence.schedule(previous, next, policy)
      previous = next
    }

    lease.release()
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({
      upserts: [{ ...history[0], title: '冻结变更 500' }],
      deleteIds: [],
      policy,
    })
  })

  it('retains only one item per unique frozen capture instead of every full history snapshot', async () => {
    const apply = vi.fn().mockResolvedValue({ prunedIds: [] })
    const persistence = createIncrementalHistoryPersistence(apply)
    persistence.reset(history, policy)

    const lease = await persistence.acquireExclusiveLease()
    let previous: ClipboardItem[] = history
    for (let index = 0; index < 500; index += 1) {
      const captured: ClipboardItem = {
        ...history[0],
        id: `frozen-capture-${index}`,
        title: `冻结捕获 ${index}`,
        copiedAt: new Date(Date.UTC(2026, 6, 18, 10, 0, index)).toISOString(),
      }
      const next = [captured, ...previous]
      persistence.schedule(previous, next, policy)
      previous = next
    }

    lease.release()
    await expect(persistence.flush()).resolves.toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0].upserts).toHaveLength(500)
  })

  it('rejects a second exclusive lease while the first lease is active', async () => {
    const persistence = createIncrementalHistoryPersistence(vi.fn().mockResolvedValue({ prunedIds: [] }))
    persistence.reset(history, policy)

    const lease = await persistence.acquireExclusiveLease()
    await expect(persistence.acquireExclusiveLease()).rejects.toThrow('历史写入队列已冻结')
    lease.release()
  })
})
