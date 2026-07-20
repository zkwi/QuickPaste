import {
  MAX_BATCH_TARGET_IDS,
  batchHistoryQueryKey,
  clearManagerSelectionOnQueryChange,
  createAllMatchingSelection,
  emptyManagerSelection,
  isAtOrBeforeQueryUpperBound,
  isManagerItemSelected,
  managerSelectedCount,
  managerSelectionState,
  nextCollectionSortOrder,
  normalizeBatchAction,
  normalizeBatchHistoryQuery,
  normalizeBatchResult,
  normalizeBatchTarget,
  normalizeCollectionName,
  normalizeCollection,
  normalizeCollections,
  normalizeQueryUpperBound,
  normalizeSnippetDraft,
  selectManagerRange,
  toBatchHistoryQuery,
  toBatchTarget,
  toggleManagerSelection,
  type BatchHistoryQuery,
  type Collection,
  type ManagerSelection,
  type SnippetDraft,
} from './collections'
import type { HistoryQuery } from './historyQuery'

const collection = (overrides: Partial<Collection> = {}): Collection => ({
  id: 'collection-1',
  name: 'Work',
  createdAt: '2026-07-19T01:02:03.004Z',
  updatedAt: '2026-07-19T01:02:03.004Z',
  sortOrder: 0,
  ...overrides,
})

describe('collection domain contract', () => {
  it('trims Unicode edge whitespace and keeps exact case-sensitive uniqueness', () => {
    const existing = [collection()]

    expect(normalizeCollectionName('\uFEFF  Personal\u0085', existing)).toBe('Personal')
    expect(normalizeCollectionName('work', existing)).toBe('work')
    expect(() => normalizeCollectionName(' Work ', existing)).toThrow('集合名称已存在')
    expect(normalizeCollectionName(' Work ', existing, 'collection-1')).toBe('Work')
  })

  it.each(['', ' \uFEFF ', 'line\nbreak', 'x'.repeat(513)])(
    'rejects an empty, controlled, or overlong collection name %j',
    (name) => expect(() => normalizeCollectionName(name, [])).toThrow(),
  )

  it('accepts only the closed one-level collection shape and unique ids/names', () => {
    expect(normalizeCollection(collection())).toEqual(collection())
    expect(normalizeCollections([collection(), collection({
      id: 'collection-2',
      name: 'Personal',
      sortOrder: 1,
    })])).toEqual([
      collection(),
      collection({ id: 'collection-2', name: 'Personal', sortOrder: 1 }),
    ])

    expect(() => normalizeCollections([{ ...collection(), parentId: 'root' }])).toThrow()
    const { updatedAt: _updatedAt, ...missingUpdatedAt } = collection()
    expect(() => normalizeCollections([missingUpdatedAt])).toThrow()
    expect(() => normalizeCollections([collection(), collection({ sortOrder: 1 })])).toThrow('集合标识重复')
    expect(() => normalizeCollections([collection(), collection({ id: 'collection-2', sortOrder: 1 })]))
      .toThrow('集合名称已存在')
    expect(() => normalizeCollections([collection({ createdAt: '2026-07-19T01:02:03Z' })])).toThrow()
    expect(() => normalizeCollections([collection({ updatedAt: '2026-07-19T01:02:03.003Z' })])).toThrow()
  })

  it('allocates max sort order plus one and rejects unsafe overflow', () => {
    expect(nextCollectionSortOrder([])).toBe(0)
    expect(nextCollectionSortOrder([
      collection({ sortOrder: -2 }),
      collection({ id: 'collection-2', name: 'Personal', sortOrder: 7 }),
    ])).toBe(8)
    expect(() => nextCollectionSortOrder([
      collection({ sortOrder: Number.MAX_SAFE_INTEGER }),
    ])).toThrow('集合排序值已用尽')
  })
})

const currentQuery: HistoryQuery = {
  text: '\uFEFF  全角 ＡＢＣ  ',
  kinds: ['link', 'text', 'link'],
  sourceApps: [' Word ', 'Edge', 'Word'],
  collection: { mode: 'collection', id: '\uFEFFcollection-1\u0085' },
  pinned: false,
  limit: 50,
  cursor: btoa('1784426400000\nclip-100'),
}

const normalizedBatchQuery: BatchHistoryQuery = {
  text: '全角 abc',
  kinds: ['text', 'link'],
  sourceApps: ['Edge', 'Word'],
  collection: { mode: 'collection', id: 'collection-1' },
  pinned: false,
}

describe('batch query and command contracts', () => {
  it('reuses canonical history-query normalization while removing cursor and limit', () => {
    expect(toBatchHistoryQuery(currentQuery)).toEqual(normalizedBatchQuery)
    expect(normalizeBatchHistoryQuery(normalizedBatchQuery)).toEqual(normalizedBatchQuery)
    expect(batchHistoryQueryKey(currentQuery)).toBe(batchHistoryQueryKey({
      ...currentQuery,
      limit: 200,
      cursor: btoa('1784426300000\nclip-050'),
    }))
    expect(batchHistoryQueryKey(currentQuery)).toBe(batchHistoryQueryKey(normalizedBatchQuery))
    expect(() => normalizeBatchHistoryQuery({ ...normalizedBatchQuery, limit: 50 })).toThrow()
    expect(() => normalizeBatchHistoryQuery({ ...normalizedBatchQuery, cursor: currentQuery.cursor })).toThrow()
  })

  it('accepts only a canonical UTC-millisecond/id upper bound', () => {
    expect(normalizeQueryUpperBound({
      copiedAt: '2026-07-19T01:02:03.004Z',
      id: 'clip-100',
    })).toEqual({ copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' })

    expect(() => normalizeQueryUpperBound({ copiedAt: '2026-07-19T01:02:03Z', id: 'clip-100' })).toThrow()
    expect(() => normalizeQueryUpperBound({ copiedAt: '2026-07-19T01:02:03.004Z', id: ' clip-100' })).toThrow()
    expect(() => normalizeQueryUpperBound({
      copiedAt: '2026-07-19T01:02:03.004Z',
      id: 'clip-100',
      cursor: 'not-part-of-the-bound',
    })).toThrow()

    expect(isAtOrBeforeQueryUpperBound(
      { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-099' },
      { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' },
    )).toBe(true)
    expect(isAtOrBeforeQueryUpperBound(
      { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-101' },
      { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' },
    )).toBe(false)
    expect(isAtOrBeforeQueryUpperBound(
      { copiedAt: '2026-07-19T01:02:03.005Z', id: 'clip-001' },
      { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' },
    )).toBe(false)
    // SQLite BINARY follows UTF-8 bytes, unlike JavaScript's UTF-16 string comparison.
    expect(isAtOrBeforeQueryUpperBound(
      { copiedAt: '2026-07-19T01:02:03.004Z', id: '😀' },
      { copiedAt: '2026-07-19T01:02:03.004Z', id: '\uE000' },
    )).toBe(false)
  })

  it('normalizes closed idempotent actions and validates move destinations', () => {
    expect(normalizeBatchAction({ type: 'move', collectionId: null }, [collection()]))
      .toEqual({ type: 'move', collectionId: null })
    expect(normalizeBatchAction({ type: 'move', collectionId: 'collection-1' }, [collection()]))
      .toEqual({ type: 'move', collectionId: 'collection-1' })
    expect(normalizeBatchAction({ type: 'setPinned', pinned: false }, [collection()]))
      .toEqual({ type: 'setPinned', pinned: false })
    expect(normalizeBatchAction({ type: 'delete' }, [collection()])).toEqual({ type: 'delete' })

    expect(() => normalizeBatchAction({ type: 'move', collectionId: 'unknown' }, [collection()]))
      .toThrow('目标集合不存在')
    expect(() => normalizeBatchAction({ type: 'togglePinned' }, [collection()])).toThrow()
    expect(() => normalizeBatchAction({ type: 'delete', confirmed: true }, [collection()])).toThrow()
  })

  it('deduplicates bounded explicit ids and treats an empty target as a valid no-op', () => {
    expect(normalizeBatchTarget({ mode: 'ids', ids: ['clip-2', 'clip-1', 'clip-2'] }))
      .toEqual({ mode: 'ids', ids: ['clip-2', 'clip-1'] })
    expect(normalizeBatchTarget({ mode: 'ids', ids: [] })).toEqual({ mode: 'ids', ids: [] })
    expect(() => normalizeBatchTarget({ mode: 'ids', ids: [' invalid'] })).toThrow()
    expect(() => normalizeBatchTarget({
      mode: 'ids',
      ids: Array.from({ length: MAX_BATCH_TARGET_IDS + 1 }, (_, index) => `clip-${index}`),
    })).toThrow('批量目标过多')
    expect(() => normalizeBatchTarget({
      mode: 'ids',
      ids: Array(MAX_BATCH_TARGET_IDS + 1).fill('clip-1'),
    })).toThrow('批量目标过多')
  })

  it('normalizes a query target without materializing matching ids', () => {
    expect(normalizeBatchTarget({
      mode: 'query',
      query: normalizedBatchQuery,
      upperBound: { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' },
      excludedIds: ['clip-2', 'clip-1', 'clip-2'],
    })).toEqual({
      mode: 'query',
      query: normalizedBatchQuery,
      upperBound: { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' },
      excludedIds: ['clip-2', 'clip-1'],
    })
    expect(() => normalizeBatchTarget({
      mode: 'query',
      query: { ...normalizedBatchQuery, limit: 50 },
      upperBound: { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' },
      excludedIds: [],
    })).toThrow()
  })

  it('normalizes safe native batch counts and bounded pruned ids', () => {
    expect(normalizeBatchResult({
      matchedCount: 3,
      changedCount: 2,
      deletedCount: 0,
      prunedIds: ['clip-4', 'clip-4'],
    })).toEqual({ matchedCount: 3, changedCount: 2, deletedCount: 0, prunedIds: ['clip-4'] })
    const largePrune = Array.from(
      { length: MAX_BATCH_TARGET_IDS + 1 },
      (_, index) => `pruned-${index}`,
    )
    expect(normalizeBatchResult({
      matchedCount: 30_000,
      changedCount: 30_000,
      deletedCount: 0,
      prunedIds: largePrune,
    }).prunedIds).toEqual(largePrune)
    expect(() => normalizeBatchResult({
      matchedCount: 1,
      changedCount: 2,
      deletedCount: 0,
      prunedIds: [],
    })).toThrow()
    expect(() => normalizeBatchResult({
      matchedCount: 2,
      changedCount: 1,
      deletedCount: 2,
      prunedIds: [],
    })).toThrow()
    expect(() => normalizeBatchResult({
      matchedCount: Number.MAX_SAFE_INTEGER + 1,
      changedCount: 0,
      deletedCount: 0,
      prunedIds: [],
    })).toThrow()
  })
})

const upperBound = { copiedAt: '2026-07-19T01:02:03.004Z', id: 'clip-100' }
const coordinate = (id: string, copiedAt = '2026-07-19T01:02:03.003Z') => ({ copiedAt, id })

describe('manager selection model', () => {
  it('toggles explicit ids immutably and moves the range anchor only on Space', () => {
    const empty = emptyManagerSelection()
    const selected = toggleManagerSelection(empty, coordinate('clip-2'))
    const deselected = toggleManagerSelection(selected, coordinate('clip-2'))

    expect(empty).toEqual({ mode: 'explicit', ids: new Set() })
    expect(selected).toEqual({ mode: 'explicit', ids: new Set(['clip-2']), anchorId: 'clip-2' })
    expect(deselected).toEqual({ mode: 'explicit', ids: new Set(), anchorId: 'clip-2' })
    const item = coordinate('clip-2')
    expect(isManagerItemSelected(selected, item)).toBe(true)
    expect(isManagerItemSelected(empty, item)).toBe(false)
  })

  it('adds a contiguous loaded Shift+Space range without changing focus state', () => {
    const anchored = toggleManagerSelection(emptyManagerSelection(), coordinate('clip-2'))
    const ranged = selectManagerRange(
      anchored,
      ['clip-1', 'clip-2', 'clip-3', 'clip-4'],
      'clip-4',
    )

    expect(ranged).toEqual({
      mode: 'explicit',
      ids: new Set(['clip-2', 'clip-3', 'clip-4']),
      anchorId: 'clip-2',
    })
    expect(() => selectManagerRange(anchored, ['clip-1', 'clip-2'], 'not-loaded')).toThrow()
  })

  it('selects all matching records without materializing 10,000 ids', () => {
    const selection = createAllMatchingSelection(currentQuery, upperBound, 10_000)

    expect(selection).toEqual({
      mode: 'allMatching',
      queryKey: batchHistoryQueryKey(currentQuery),
      upperBound,
      excludedIds: new Set(),
      count: 10_000,
    })
    expect(managerSelectedCount(selection)).toBe(10_000)
    expect(isManagerItemSelected(selection, {
      copiedAt: '2026-07-19T01:02:03.003Z',
      id: 'clip-55',
    })).toBe(true)
    expect(isManagerItemSelected(selection, {
      copiedAt: '2026-07-19T01:02:03.005Z',
      id: 'newer-clip',
    })).toBe(false)
    expect(isManagerItemSelected(selection, { copiedAt: 'invalid', id: 'clip-55' })).toBe(false)
    expect('ids' in selection).toBe(false)
  })

  it('uses exclusions for allMatching toggles and reselects a loaded range', () => {
    const all = createAllMatchingSelection(currentQuery, upperBound, 4)
    const withoutTwo = toggleManagerSelection(all, coordinate('clip-2'))
    const withoutTwoAndThree = toggleManagerSelection(withoutTwo, coordinate('clip-3'))
    const ranged = selectManagerRange(
      withoutTwoAndThree,
      ['clip-1', 'clip-2', 'clip-3', 'clip-4'],
      'clip-3',
      'clip-2',
    )

    expect(withoutTwoAndThree).toEqual({ ...all, excludedIds: new Set(['clip-2', 'clip-3']) })
    expect(managerSelectedCount(withoutTwoAndThree)).toBe(2)
    expect(isManagerItemSelected(withoutTwoAndThree, {
      copiedAt: '2026-07-19T01:02:03.003Z',
      id: 'clip-2',
    })).toBe(false)
    expect(ranged).toEqual(all)

    expect(() => toggleManagerSelection(all, coordinate(
      'newer-clip',
      '2026-07-19T01:02:03.005Z',
    ))).toThrow('记录不属于冻结选择')
    expect(() => toggleManagerSelection(all, { copiedAt: 'invalid', id: 'clip-1' })).toThrow()
    expect(managerSelectedCount(all)).toBe(4)
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsafe allMatching count %s',
    (count) => expect(() => createAllMatchingSelection(currentQuery, upperBound, count)).toThrow(),
  )

  it('rejects selections whose exclusions exceed the match count or safety bound', () => {
    const impossible: ManagerSelection = {
      mode: 'allMatching',
      queryKey: batchHistoryQueryKey(currentQuery),
      upperBound,
      excludedIds: new Set(['clip-1', 'clip-2']),
      count: 1,
    }
    expect(() => managerSelectedCount(impossible)).toThrow()

    const overBound: ManagerSelection = {
      mode: 'allMatching',
      queryKey: batchHistoryQueryKey(currentQuery),
      upperBound,
      excludedIds: new Set(Array.from(
        { length: MAX_BATCH_TARGET_IDS + 1 },
        (_, index) => `clip-${index}`,
      )),
      count: MAX_BATCH_TARGET_IDS + 1,
    }
    expect(() => managerSelectedCount(overBound)).toThrow()
  })

  it('clears either selection mode only when the canonical batch query key changes', () => {
    const explicit = toggleManagerSelection(emptyManagerSelection(), coordinate('clip-1'))
    const sameQuerySelection = clearManagerSelectionOnQueryChange(
      explicit,
      currentQuery,
      { ...currentQuery, limit: 200, cursor: undefined },
    )
    expect(sameQuerySelection).toEqual(explicit)
    expect(sameQuerySelection).not.toBe(explicit)
    expect(clearManagerSelectionOnQueryChange(
      explicit,
      currentQuery,
      { ...currentQuery, text: 'different' },
    )).toEqual(emptyManagerSelection())

    const all = createAllMatchingSelection(currentQuery, upperBound, 4)
    expect(clearManagerSelectionOnQueryChange(
      all,
      currentQuery,
      { ...currentQuery, collection: { mode: 'unfiled' } },
    )).toEqual(emptyManagerSelection())
  })

  it('reports none/mixed/all and converts selection into the native batch target', () => {
    const explicit = toggleManagerSelection(emptyManagerSelection(), coordinate('clip-1'))
    expect(managerSelectionState(emptyManagerSelection(), 4)).toBe('none')
    expect(managerSelectionState(explicit, 4)).toBe('mixed')
    expect(managerSelectionState(createAllMatchingSelection(currentQuery, upperBound, 4), 4)).toBe('all')
    expect(toBatchTarget(explicit, currentQuery)).toEqual({ mode: 'ids', ids: ['clip-1'] })

    const allWithoutTwo = toggleManagerSelection(
      createAllMatchingSelection(currentQuery, upperBound, 4),
      coordinate('clip-2'),
    )
    expect(toBatchTarget(allWithoutTwo, currentQuery)).toEqual({
      mode: 'query',
      query: normalizedBatchQuery,
      upperBound,
      excludedIds: ['clip-2'],
    })
    expect(() => toBatchTarget(allWithoutTwo, { ...currentQuery, pinned: true }))
      .toThrow('选择与当前查询不一致')
  })
})

describe('permanent snippet draft contract', () => {
  it('normalizes a create/edit draft while preserving the exact plain-text body', () => {
    const draft: SnippetDraft = {
      id: 'snippet-1',
      title: '\uFEFF  Daily command  ',
      content: '  npm run check\n',
      collectionId: 'collection-1',
      kind: 'code',
    }

    expect(normalizeSnippetDraft(draft, [collection()])).toEqual({
      id: 'snippet-1',
      title: 'Daily command',
      content: '  npm run check\n',
      collectionId: 'collection-1',
      kind: 'code',
    })
    expect(normalizeSnippetDraft({
      title: 'Note',
      content: 'text',
      kind: 'text',
    }, [collection()])).toEqual({ title: 'Note', content: 'text', kind: 'text' })
  })

  it.each([
    { title: 'Title', content: ' \uFEFF\n', kind: 'text' },
    { title: 'Title', content: 'body', kind: 'image' },
    { title: ' ', content: 'body', kind: 'text' },
    { id: ' bad-id', title: 'Title', content: 'body', kind: 'text' },
    { title: 'Title', content: 'body', kind: 'text', html: '<b>body</b>' },
  ])('rejects an invalid or non-plain snippet draft %#', (draft) => {
    expect(() => normalizeSnippetDraft(draft, [collection()])).toThrow()
  })

  it('rejects an invalid or unknown collection without inventing nesting', () => {
    expect(() => normalizeSnippetDraft({
      title: 'Note',
      content: 'text',
      collectionId: 'unknown',
      kind: 'text',
    }, [collection()])).toThrow('片段集合不存在')
    expect(() => normalizeSnippetDraft({
      title: 'Note',
      content: 'text',
      collectionId: ' collection-1 ',
      kind: 'text',
    }, [collection()])).toThrow('片段集合标识无效')
  })
})
