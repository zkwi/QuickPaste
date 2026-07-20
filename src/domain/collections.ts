import { isValidClipboardItemId, trimSearchWhitespace } from './clipboard'
import { normalizeHistoryQuery, type HistoryQuery } from './historyQuery'

export interface Collection {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sortOrder: number
}

export interface SnippetDraft {
  id?: string
  title: string
  content: string
  collectionId?: string
  kind: 'text' | 'code'
}

export type BatchAction =
  | { type: 'move'; collectionId: string | null }
  | { type: 'setPinned'; pinned: boolean }
  | { type: 'delete' }

export type BatchHistoryQuery = Omit<HistoryQuery, 'limit' | 'cursor'>

export interface QueryUpperBound {
  copiedAt: string
  id: string
}

export type BatchTarget =
  | { mode: 'ids'; ids: string[] }
  | {
    mode: 'query'
    query: BatchHistoryQuery
    upperBound: QueryUpperBound
    excludedIds: string[]
  }

export interface BatchResult {
  matchedCount: number
  changedCount: number
  deletedCount: number
  prunedIds: string[]
}

export type ManagerSelection =
  | { mode: 'explicit'; ids: Set<string>; anchorId?: string }
  | {
    mode: 'allMatching'
    queryKey: string
    upperBound: QueryUpperBound
    excludedIds: Set<string>
    count: number
  }

export type ManagerSelectionState = 'none' | 'mixed' | 'all'

export const MAX_BATCH_TARGET_IDS = 10_000

const COLLECTION_KEYS = new Set(['id', 'name', 'createdAt', 'updatedAt', 'sortOrder'])
const SNIPPET_DRAFT_KEYS = new Set(['id', 'title', 'content', 'collectionId', 'kind'])
const BATCH_QUERY_KEYS = new Set(['text', 'kinds', 'sourceApps', 'collection', 'pinned'])
const QUERY_UPPER_BOUND_KEYS = new Set(['copiedAt', 'id'])
const BATCH_RESULT_KEYS = new Set([
  'matchedCount', 'changedCount', 'deletedCount', 'prunedIds',
])
const CONTROL_CHARACTER = /\p{Cc}/u
const CANONICAL_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_COLLECTION_NAME_UTF16 = 512
const UTF8_ENCODER = new TextEncoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactShape(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return keys.every((key) => allowedKeys.has(key))
    && requiredKeys.every((key) => Object.hasOwn(value, key))
}

export function isCanonicalUtcMillis(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_UTC_MILLIS.test(value)) return false
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

export function normalizeCollectionName(
  value: unknown,
  collections: readonly Pick<Collection, 'id' | 'name'>[],
  excludingId?: string,
): string {
  if (typeof value !== 'string') throw new Error('集合名称无效')
  const name = trimSearchWhitespace(value)
  if (!name || name.length > MAX_COLLECTION_NAME_UTF16 || CONTROL_CHARACTER.test(name)) {
    throw new Error('集合名称无效')
  }
  if (collections.some((collection) => collection.id !== excludingId
    && trimSearchWhitespace(collection.name) === name)) {
    throw new Error('集合名称已存在')
  }
  return name
}

export function normalizeCollection(value: unknown): Collection {
  if (!isRecord(value)
    || !hasExactShape(value, COLLECTION_KEYS, ['id', 'name', 'createdAt', 'updatedAt', 'sortOrder'])
    || !isValidClipboardItemId(value.id)
    || !isCanonicalUtcMillis(value.createdAt)
    || !isCanonicalUtcMillis(value.updatedAt)
    || !Number.isSafeInteger(value.sortOrder)
    || value.createdAt > value.updatedAt) {
    throw new Error('集合数据无效')
  }
  return {
    id: value.id,
    name: normalizeCollectionName(value.name, []),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    sortOrder: value.sortOrder as number,
  }
}

export function normalizeCollections(value: unknown): Collection[] {
  if (!Array.isArray(value)) throw new Error('集合列表无效')
  const collections: Collection[] = []
  const ids = new Set<string>()
  for (const candidate of value) {
    const normalized = normalizeCollection(candidate)
    if (ids.has(normalized.id)) throw new Error('集合标识重复')
    normalizeCollectionName(normalized.name, collections)
    ids.add(normalized.id)
    collections.push(normalized)
  }
  return collections
}

export function nextCollectionSortOrder(collections: readonly Pick<Collection, 'sortOrder'>[]): number {
  if (collections.some((collection) => !Number.isSafeInteger(collection.sortOrder))) {
    throw new Error('集合排序值无效')
  }
  if (collections.length === 0) return 0
  const maximum = Math.max(...collections.map(({ sortOrder }) => sortOrder))
  if (maximum === Number.MAX_SAFE_INTEGER) throw new Error('集合排序值已用尽')
  return maximum + 1
}

export function normalizeSnippetDraft(
  value: unknown,
  collections?: readonly Pick<Collection, 'id'>[],
): SnippetDraft {
  if (!isRecord(value)
    || !hasExactShape(value, SNIPPET_DRAFT_KEYS, ['title', 'content', 'kind'])
    || (value.id !== undefined && !isValidClipboardItemId(value.id))
    || typeof value.title !== 'string'
    || typeof value.content !== 'string'
    || (value.kind !== 'text' && value.kind !== 'code')) {
    throw new Error('片段草稿无效')
  }
  const title = trimSearchWhitespace(value.title)
  if (!title || title.length > MAX_COLLECTION_NAME_UTF16 || CONTROL_CHARACTER.test(title)) {
    throw new Error('片段标题无效')
  }
  if (!trimSearchWhitespace(value.content)) throw new Error('片段正文不能为空')

  let collectionId: string | undefined
  if (value.collectionId !== undefined) {
    if (!isValidClipboardItemId(value.collectionId)) throw new Error('片段集合标识无效')
    collectionId = value.collectionId
    if (collections && !collections.some((collection) => collection.id === collectionId)) {
      throw new Error('片段集合不存在')
    }
  }

  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    title,
    content: value.content,
    ...(collectionId === undefined ? {} : { collectionId }),
    kind: value.kind,
  }
}

export function toBatchHistoryQuery(value: HistoryQuery): BatchHistoryQuery {
  const query = normalizeHistoryQuery(value)
  return {
    text: query.text,
    kinds: query.kinds,
    sourceApps: query.sourceApps,
    collection: query.collection,
    ...(query.pinned === undefined ? {} : { pinned: query.pinned }),
  }
}

export function normalizeBatchHistoryQuery(value: unknown): BatchHistoryQuery {
  if (!isRecord(value)
    || !hasExactShape(value, BATCH_QUERY_KEYS, ['text', 'kinds', 'sourceApps', 'collection'])) {
    throw new Error('批量历史查询无效')
  }
  return toBatchHistoryQuery({
    text: value.text as string,
    kinds: value.kinds as HistoryQuery['kinds'],
    sourceApps: value.sourceApps as string[],
    collection: value.collection as HistoryQuery['collection'],
    ...(value.pinned === undefined ? {} : { pinned: value.pinned as boolean }),
    limit: 1,
  })
}

export function batchHistoryQueryKey(value: HistoryQuery | BatchHistoryQuery): string {
  const query = isRecord(value) && Object.hasOwn(value, 'limit')
    ? toBatchHistoryQuery(value as HistoryQuery)
    : normalizeBatchHistoryQuery(value)
  return JSON.stringify(query)
}

export function normalizeQueryUpperBound(value: unknown): QueryUpperBound {
  if (!isRecord(value)
    || !hasExactShape(value, QUERY_UPPER_BOUND_KEYS, ['copiedAt', 'id'])
    || !isCanonicalUtcMillis(value.copiedAt)
    || !isValidClipboardItemId(value.id)) {
    throw new Error('批量查询上界无效')
  }
  return { copiedAt: value.copiedAt, id: value.id }
}

export function isAtOrBeforeQueryUpperBound(
  item: QueryUpperBound,
  upperBound: QueryUpperBound,
): boolean {
  const normalizedItem = normalizeQueryUpperBound(item)
  const normalizedUpperBound = normalizeQueryUpperBound(upperBound)
  return normalizedItem.copiedAt < normalizedUpperBound.copiedAt
    || (normalizedItem.copiedAt === normalizedUpperBound.copiedAt
      && sqliteBinaryLessThanOrEqual(normalizedItem.id, normalizedUpperBound.id))
}

function sqliteBinaryLessThanOrEqual(left: string, right: string): boolean {
  // 原生查询的 id 使用 SQLite BINARY 排序；非 ASCII id 不能用 JavaScript UTF-16 顺序代替。
  const leftBytes = UTF8_ENCODER.encode(left)
  const rightBytes = UTF8_ENCODER.encode(right)
  const sharedLength = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! < rightBytes[index]!
  }
  return leftBytes.length <= rightBytes.length
}

export function normalizeBatchAction(
  value: unknown,
  collections?: readonly Pick<Collection, 'id'>[],
): BatchAction {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('批量操作无效')
  if (value.type === 'delete') {
    if (!hasExactShape(value, new Set(['type']), ['type'])) throw new Error('批量删除操作无效')
    return { type: 'delete' }
  }
  if (value.type === 'setPinned') {
    if (!hasExactShape(value, new Set(['type', 'pinned']), ['type', 'pinned'])
      || typeof value.pinned !== 'boolean') {
      throw new Error('批量固定操作无效')
    }
    return { type: 'setPinned', pinned: value.pinned }
  }
  if (value.type !== 'move'
    || !hasExactShape(value, new Set(['type', 'collectionId']), ['type', 'collectionId'])
    || (value.collectionId !== null && !isValidClipboardItemId(value.collectionId))) {
    throw new Error('批量移动操作无效')
  }
  if (value.collectionId !== null
    && collections
    && !collections.some(({ id }) => id === value.collectionId)) {
    throw new Error('目标集合不存在')
  }
  return { type: 'move', collectionId: value.collectionId }
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('批量目标标识无效')
  if (value.length > MAX_BATCH_TARGET_IDS) throw new Error('批量目标过多')
  if (value.some((id) => !isValidClipboardItemId(id))) {
    throw new Error('批量目标标识无效')
  }
  const ids = [...new Set(value as string[])]
  if (ids.length > MAX_BATCH_TARGET_IDS) throw new Error('批量目标过多')
  return ids
}

function normalizePrunedIds(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.some((id) => !isValidClipboardItemId(id))) {
    throw new Error('容量剪枝标识无效')
  }
  // 目标/排除项需要 IPC 输入上限；剪枝结果可能合法地超过 10,000 条，不能复用该限制。
  return [...new Set(value as string[])]
}

export function normalizeBatchTarget(value: unknown): BatchTarget {
  if (!isRecord(value)) throw new Error('批量目标无效')
  if (value.mode === 'ids') {
    if (!hasExactShape(value, new Set(['mode', 'ids']), ['mode', 'ids'])) {
      throw new Error('批量显式目标无效')
    }
    return { mode: 'ids', ids: normalizeIds(value.ids) }
  }
  if (value.mode !== 'query'
    || !hasExactShape(
      value,
      new Set(['mode', 'query', 'upperBound', 'excludedIds']),
      ['mode', 'query', 'upperBound', 'excludedIds'],
    )) {
    throw new Error('批量查询目标无效')
  }
  return {
    mode: 'query',
    query: normalizeBatchHistoryQuery(value.query),
    upperBound: normalizeQueryUpperBound(value.upperBound),
    excludedIds: normalizeIds(value.excludedIds),
  }
}

function normalizeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('批量结果计数无效')
  return value as number
}

export function normalizeBatchResult(value: unknown): BatchResult {
  if (!isRecord(value)
    || !hasExactShape(
      value,
      BATCH_RESULT_KEYS,
      ['matchedCount', 'changedCount', 'deletedCount', 'prunedIds'],
    )) {
    throw new Error('批量结果无效')
  }
  const matchedCount = normalizeCount(value.matchedCount)
  const changedCount = normalizeCount(value.changedCount)
  const deletedCount = normalizeCount(value.deletedCount)
  if (changedCount > matchedCount || deletedCount > changedCount) {
    throw new Error('批量结果计数无效')
  }
  return {
    matchedCount,
    changedCount,
    deletedCount,
    prunedIds: normalizePrunedIds(value.prunedIds),
  }
}

export function emptyManagerSelection(): ManagerSelection {
  return { mode: 'explicit', ids: new Set() }
}

function normalizeIdSet(value: unknown): Set<string> {
  if (!(value instanceof Set) || value.size > MAX_BATCH_TARGET_IDS) {
    throw new Error('管理选择标识无效')
  }
  const ids = [...value]
  if (ids.some((id) => !isValidClipboardItemId(id))) throw new Error('管理选择标识无效')
  return new Set(ids as string[])
}

export function normalizeManagerSelection(value: unknown): ManagerSelection {
  if (!isRecord(value)) throw new Error('管理选择无效')
  if (value.mode === 'explicit') {
    if (!hasExactShape(value, new Set(['mode', 'ids', 'anchorId']), ['mode', 'ids'])
      || (value.anchorId !== undefined && !isValidClipboardItemId(value.anchorId))) {
      throw new Error('管理显式选择无效')
    }
    const ids = normalizeIdSet(value.ids)
    return {
      mode: 'explicit',
      ids,
      ...(value.anchorId === undefined ? {} : { anchorId: value.anchorId }),
    }
  }
  if (value.mode !== 'allMatching'
    || !hasExactShape(
      value,
      new Set(['mode', 'queryKey', 'upperBound', 'excludedIds', 'count']),
      ['mode', 'queryKey', 'upperBound', 'excludedIds', 'count'],
    )
    || typeof value.queryKey !== 'string'
    || !value.queryKey) {
    throw new Error('管理全匹配选择无效')
  }
  const count = normalizeCount(value.count)
  const excludedIds = normalizeIdSet(value.excludedIds)
  if (excludedIds.size > count) throw new Error('管理选择排除数无效')
  return {
    mode: 'allMatching',
    queryKey: value.queryKey,
    upperBound: normalizeQueryUpperBound(value.upperBound),
    excludedIds,
    count,
  }
}

export function managerSelectedCount(selection: ManagerSelection): number {
  const normalized = normalizeManagerSelection(selection)
  return normalized.mode === 'explicit'
    ? normalized.ids.size
    : normalized.count - normalized.excludedIds.size
}

export function isManagerItemSelected(
  selection: ManagerSelection,
  item: QueryUpperBound,
): boolean {
  if (selection.mode === 'explicit') {
    return isRecord(item) && isValidClipboardItemId(item.id) && selection.ids.has(item.id)
  }
  try {
    const coordinate = normalizeQueryUpperBound(item)
    return isAtOrBeforeQueryUpperBound(coordinate, selection.upperBound)
      && !selection.excludedIds.has(coordinate.id)
  } catch {
    return false
  }
}

export function toggleManagerSelection(
  selection: ManagerSelection,
  item: QueryUpperBound,
): ManagerSelection {
  const normalized = normalizeManagerSelection(selection)
  if (normalized.mode === 'explicit') {
    if (!isRecord(item) || !isValidClipboardItemId(item.id)) throw new Error('管理选择标识无效')
    const id = item.id
    const ids = new Set(normalized.ids)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    if (ids.size > MAX_BATCH_TARGET_IDS) throw new Error('批量目标过多')
    return { mode: 'explicit', ids, anchorId: id }
  }

  const coordinate = normalizeQueryUpperBound(item)
  if (!isAtOrBeforeQueryUpperBound(coordinate, normalized.upperBound)) {
    throw new Error('记录不属于冻结选择')
  }
  const excludedIds = new Set(normalized.excludedIds)
  if (excludedIds.has(coordinate.id)) excludedIds.delete(coordinate.id)
  else excludedIds.add(coordinate.id)
  if (excludedIds.size > normalized.count || excludedIds.size > MAX_BATCH_TARGET_IDS) {
    throw new Error('管理选择排除数无效')
  }
  return { ...normalized, excludedIds }
}

export function selectManagerRange(
  selection: ManagerSelection,
  loadedIds: readonly string[],
  focusedId: string,
  allMatchingAnchorId?: string,
): ManagerSelection {
  const ids = normalizeIds(loadedIds)
  if (ids.length !== loadedIds.length) throw new Error('管理列表标识重复')
  const focusedIndex = ids.indexOf(focusedId)
  if (focusedIndex < 0) throw new Error('焦点记录不在当前列表')

  const normalized = normalizeManagerSelection(selection)
  const requestedAnchor = normalized.mode === 'explicit'
    ? normalized.anchorId
    : allMatchingAnchorId
  if (requestedAnchor !== undefined && !isValidClipboardItemId(requestedAnchor)) {
    throw new Error('管理选择锚点无效')
  }
  const candidateAnchorIndex = requestedAnchor === undefined ? -1 : ids.indexOf(requestedAnchor)
  const anchorIndex = candidateAnchorIndex < 0 ? focusedIndex : candidateAnchorIndex
  const range = ids.slice(
    Math.min(anchorIndex, focusedIndex),
    Math.max(anchorIndex, focusedIndex) + 1,
  )

  if (normalized.mode === 'explicit') {
    const selectedIds = new Set(normalized.ids)
    range.forEach((id) => selectedIds.add(id))
    if (selectedIds.size > MAX_BATCH_TARGET_IDS) throw new Error('批量目标过多')
    return {
      mode: 'explicit',
      ids: selectedIds,
      anchorId: candidateAnchorIndex < 0 ? focusedId : normalized.anchorId,
    }
  }
  const excludedIds = new Set(normalized.excludedIds)
  range.forEach((id) => excludedIds.delete(id))
  return { ...normalized, excludedIds }
}

export function createAllMatchingSelection(
  query: HistoryQuery | BatchHistoryQuery,
  upperBound: QueryUpperBound,
  count: number,
): ManagerSelection {
  const normalizedCount = normalizeCount(count)
  return {
    mode: 'allMatching',
    queryKey: batchHistoryQueryKey(query),
    upperBound: normalizeQueryUpperBound(upperBound),
    excludedIds: new Set(),
    count: normalizedCount,
  }
}

export function clearManagerSelectionOnQueryChange(
  selection: ManagerSelection,
  previousQuery: HistoryQuery | BatchHistoryQuery,
  nextQuery: HistoryQuery | BatchHistoryQuery,
): ManagerSelection {
  const normalized = normalizeManagerSelection(selection)
  return batchHistoryQueryKey(previousQuery) === batchHistoryQueryKey(nextQuery)
    ? normalized
    : emptyManagerSelection()
}

export function managerSelectionState(
  selection: ManagerSelection,
  totalCount: number,
): ManagerSelectionState {
  const normalizedTotal = normalizeCount(totalCount)
  const selectedCount = managerSelectedCount(selection)
  if (selectedCount > normalizedTotal) throw new Error('管理选择计数无效')
  if (selectedCount === 0) return 'none'
  return selectedCount === normalizedTotal ? 'all' : 'mixed'
}

export function toBatchTarget(
  selection: ManagerSelection,
  currentQuery: HistoryQuery | BatchHistoryQuery,
): BatchTarget {
  const normalized = normalizeManagerSelection(selection)
  if (normalized.mode === 'explicit') {
    return normalizeBatchTarget({ mode: 'ids', ids: [...normalized.ids] })
  }
  const query = 'limit' in currentQuery
    ? toBatchHistoryQuery(currentQuery as HistoryQuery)
    : normalizeBatchHistoryQuery(currentQuery)
  if (normalized.queryKey !== batchHistoryQueryKey(query)) {
    throw new Error('选择与当前查询不一致')
  }
  return normalizeBatchTarget({
    mode: 'query',
    query,
    upperBound: normalized.upperBound,
    excludedIds: [...normalized.excludedIds],
  })
}
