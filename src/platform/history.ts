import {
  parseClipboardItems,
  isValidImageHash,
  isValidClipboardItemId,
  normalizeSourceAppIcon,
  trimSearchWhitespace,
  type ClipboardItem,
  type ClipboardItemSummary,
  type LoadedClipboardItem,
  type OcrStatus,
} from '../domain/clipboard'
import {
  isValidHistoryCursor,
  normalizeHistoryQuery,
  type HistoryPage,
  type HistoryQuery,
} from '../domain/historyQuery'
import {
  normalizeBatchAction,
  normalizeBatchResult,
  normalizeBatchTarget,
  normalizeCollection,
  normalizeCollectionName,
  normalizeCollections,
  normalizeSnippetDraft,
  type BatchAction,
  type BatchResult,
  type BatchTarget,
  type Collection,
  type SnippetDraft,
} from '../domain/collections'
import { isTauriRuntime } from './desktop'

export type HistoryInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

export interface CapacityPolicy {
  maxRecords: number
  maxImageBytes: number
  retentionDays: number | null
}

export interface HistoryMutation {
  upserts: ClipboardItem[]
  deleteIds: string[]
  policy: CapacityPolicy
}

export interface HistoryMutationResult {
  prunedIds: string[]
}

export interface CollectionDeleteResult {
  affectedCount: number
}

export interface StorageStats {
  databaseBytes: number
  walBytes: number
  shmBytes: number
  totalPhysicalBytes: number
  recordCount: number
  pinnedCount: number
  permanentCount: number
  imageBytes: number
  richFormatBytes: number
  fileRecordCount: number
  logicalBytes: number
  oldestCopiedAt: string | null
  newestCopiedAt: string | null
  maxRecords: number
  maxImageBytes: number
  retentionDays: number | null
}

export type BackupResult = { status: 'cancelled' } | { status: 'saved' }

export type PreparedRestoreResult =
  | { status: 'cancelled' }
  | {
      status: 'prepared'
      token: string
      currentCount: number
      incomingCount: number
      schemaVersion: number
    }

export type PreparedRestore = Extract<PreparedRestoreResult, { status: 'prepared' }>

export interface RestoreResult {
  status: 'restored'
  importedCount: number
  schemaVersion: number
  policy: CapacityPolicy
  stats: StorageStats
}

export interface DiscardResult {
  status: 'discarded'
}

export type HistoryHealth =
  | { status: 'healthy' }
  | {
      status: 'recovered'
      reason: 'corrupt' | 'notADatabase'
      quarantinePath: string
    }
  | {
      status: 'readOnlyError'
      reason: 'busy' | 'permissionDenied' | 'io' | 'diskFull' | 'incompatible' | 'quarantineFailed' | 'unknown'
    }
  | {
      status: 'readOnlyError'
      reason: 'freshDatabaseFailed'
      recoveryReason: 'corrupt' | 'notADatabase'
      quarantinePath: string
    }

export type StorageOperation =
  | 'backup'
  | 'prepare-restore'
  | 'commit-restore'
  | 'discard-restore'
  | 'compact'
  | 'policy'
  | 'refresh'
  | null

export type ClipPayloadLoadResult =
  | { status: 'loaded'; item: LoadedClipboardItem }
  | { status: 'missing' }
  | { status: 'failed' }

export interface HistoryExclusiveLease {
  release: () => void
}

export interface IncrementalHistoryPersistence {
  reset: (items: ClipboardItem[], policy: CapacityPolicy) => void
  schedule: (previous: ClipboardItem[], next: ClipboardItem[], policy: CapacityPolicy) => void
  flush: () => Promise<boolean>
  isDirty: () => boolean
  isFrozen: () => boolean
  acquireExclusiveLease: () => Promise<HistoryExclusiveLease>
  acknowledgeExternalOcrPatch: (id: string, imageHash: string, patch: ExternalOcrPatch) => boolean
  cancel: () => void
}

export interface ExternalOcrPatch {
  ocrStatus: Exclude<OcrStatus, 'pending'>
  ocrText?: string
}

export interface HistoryOperationSnapshot {
  items: ClipboardItem[]
  policy: CapacityPolicy
}

export type HistoryOperationResult<T> =
  | { status: 'failed' }
  | { status: 'committed'; value: T }
  | { status: 'committedRefreshFailed'; value: T }

export interface SerializedHistoryOperation<T> {
  mutate: () => Promise<T | null>
  refresh: () => Promise<HistoryOperationSnapshot | null>
  commit: (snapshot: HistoryOperationSnapshot) => void
}

export interface SerializedHistoryOperationLane {
  run: <T>(operation: SerializedHistoryOperation<T>) => Promise<HistoryOperationResult<T>>
  invalidate: () => void
  isBusy: () => boolean
}

async function invokeThroughTauri(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

const CURRENT_HISTORY_SCHEMA_VERSION = 9

function parseCapacityPolicy(value: unknown): CapacityPolicy | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['maxRecords', 'maxImageBytes', 'retentionDays'])
    || !isSafeUnsignedInteger(value.maxRecords)
    || !isSafeUnsignedInteger(value.maxImageBytes)
    || value.retentionDays !== null && !isSafeUnsignedInteger(value.retentionDays)) return null
  return {
    maxRecords: value.maxRecords,
    maxImageBytes: value.maxImageBytes,
    retentionDays: value.retentionDays as number | null,
  }
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

const STORAGE_STATS_KEYS = [
  'databaseBytes', 'walBytes', 'shmBytes', 'totalPhysicalBytes', 'recordCount',
  'pinnedCount', 'permanentCount', 'imageBytes', 'richFormatBytes', 'fileRecordCount',
  'logicalBytes', 'oldestCopiedAt', 'newestCopiedAt', 'maxRecords', 'maxImageBytes',
  'retentionDays',
] as const

function parseStorageStats(value: unknown): StorageStats | null {
  if (!isRecord(value) || !hasExactKeys(value, STORAGE_STATS_KEYS)) return null
  const unsignedKeys = [
    'databaseBytes', 'walBytes', 'shmBytes', 'totalPhysicalBytes', 'recordCount',
    'pinnedCount', 'permanentCount', 'imageBytes', 'richFormatBytes', 'fileRecordCount',
    'logicalBytes', 'maxRecords', 'maxImageBytes',
  ] as const
  if (unsignedKeys.some((key) => !isSafeUnsignedInteger(value[key]))) return null
  if (value.retentionDays !== null && !isSafeUnsignedInteger(value.retentionDays)) return null
  const physicalBytes = (value.databaseBytes as number)
    + (value.walBytes as number)
    + (value.shmBytes as number)
  if (!Number.isSafeInteger(physicalBytes)
    || physicalBytes !== value.totalPhysicalBytes
    || (value.pinnedCount as number) > (value.recordCount as number)
    || (value.permanentCount as number) > (value.recordCount as number)
    || (value.fileRecordCount as number) > (value.recordCount as number)) return null

  const hasRows = (value.recordCount as number) > 0
  if (hasRows) {
    if (!isCanonicalUtcTimestamp(value.oldestCopiedAt)
      || !isCanonicalUtcTimestamp(value.newestCopiedAt)
      || value.oldestCopiedAt > value.newestCopiedAt) return null
  } else if (value.oldestCopiedAt !== null || value.newestCopiedAt !== null) {
    return null
  }
  return { ...(value as unknown as StorageStats) }
}

function isOpaqueRestoreToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function parseBackupResult(value: unknown): BackupResult | null {
  if (!isRecord(value) || !hasExactKeys(value, ['status'])) return null
  return value.status === 'cancelled' || value.status === 'saved'
    ? { status: value.status }
    : null
}

function parsePreparedRestoreResult(value: unknown): PreparedRestoreResult | null {
  if (!isRecord(value) || typeof value.status !== 'string') return null
  if (value.status === 'cancelled') {
    return hasExactKeys(value, ['status']) ? { status: 'cancelled' } : null
  }
  if (value.status !== 'prepared'
    || !hasExactKeys(value, ['status', 'token', 'currentCount', 'incomingCount', 'schemaVersion'])
    || !isOpaqueRestoreToken(value.token)
    || !isSafeUnsignedInteger(value.currentCount)
    || !isSafeUnsignedInteger(value.incomingCount)
    || value.schemaVersion !== CURRENT_HISTORY_SCHEMA_VERSION) return null
  return {
    status: 'prepared',
    token: value.token,
    currentCount: value.currentCount,
    incomingCount: value.incomingCount,
    schemaVersion: value.schemaVersion,
  }
}

function parseRestoreResult(value: unknown): RestoreResult | null {
  if (!isRecord(value)
    || value.status !== 'restored'
    || !hasExactKeys(value, ['status', 'importedCount', 'schemaVersion', 'policy', 'stats'])
    || !isSafeUnsignedInteger(value.importedCount)
    || value.schemaVersion !== CURRENT_HISTORY_SCHEMA_VERSION) return null
  const policy = parseCapacityPolicy(value.policy)
  const stats = parseStorageStats(value.stats)
  if (!policy || !stats
    || policy.maxRecords !== stats.maxRecords
    || policy.maxImageBytes !== stats.maxImageBytes
    || policy.retentionDays !== stats.retentionDays
    || value.importedCount !== stats.recordCount) return null
  return {
    status: 'restored',
    importedCount: value.importedCount,
    schemaVersion: value.schemaVersion,
    policy,
    stats,
  }
}

function parseDiscardResult(value: unknown): DiscardResult | null {
  return isRecord(value) && hasExactKeys(value, ['status']) && value.status === 'discarded'
    ? { status: 'discarded' }
    : null
}

const RECOVERY_REASONS = new Set(['corrupt', 'notADatabase'])
const READ_ONLY_REASONS = new Set([
  'busy', 'permissionDenied', 'io', 'diskFull', 'incompatible', 'quarantineFailed',
  'unknown',
])

function isConfirmedQuarantinePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && trimSearchWhitespace(value) === value
    && !/\p{Cc}/u.test(value)
}

function parseHistoryHealth(value: unknown): HistoryHealth | null {
  if (!isRecord(value) || typeof value.status !== 'string') return null
  if (value.status === 'healthy') {
    return hasExactKeys(value, ['status']) ? { status: 'healthy' } : null
  }
  if (value.status === 'recovered') {
    if (!hasExactKeys(value, ['status', 'reason', 'quarantinePath'])
      || typeof value.reason !== 'string'
      || !RECOVERY_REASONS.has(value.reason)
      || !isConfirmedQuarantinePath(value.quarantinePath)) return null
    return {
      status: 'recovered',
      reason: value.reason as 'corrupt' | 'notADatabase',
      quarantinePath: value.quarantinePath,
    }
  }
  if (value.status === 'readOnlyError' && value.reason === 'freshDatabaseFailed') {
    if (!hasExactKeys(value, ['status', 'reason', 'recoveryReason', 'quarantinePath'])
      || typeof value.recoveryReason !== 'string'
      || !RECOVERY_REASONS.has(value.recoveryReason)
      || !isConfirmedQuarantinePath(value.quarantinePath)) return null
    return {
      status: 'readOnlyError',
      reason: 'freshDatabaseFailed',
      recoveryReason: value.recoveryReason as 'corrupt' | 'notADatabase',
      quarantinePath: value.quarantinePath,
    }
  }
  if (value.status === 'readOnlyError'
    && hasExactKeys(value, ['status', 'reason'])
    && typeof value.reason === 'string'
    && READ_ONLY_REASONS.has(value.reason)) {
    return {
      status: 'readOnlyError',
      reason: value.reason as 'busy' | 'permissionDenied' | 'io' | 'diskFull' | 'incompatible' | 'quarantineFailed' | 'unknown',
    }
  }
  return null
}

async function invokeParsed<T>(
  command: string,
  args: Record<string, unknown>,
  parser: (value: unknown) => T | null,
  invokeAdapter?: HistoryInvoke,
): Promise<T | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null
  try {
    return parser(await (invokeAdapter ?? invokeThroughTauri)(command, args))
  } catch {
    return null
  }
}

export function createNativeHistoryBackup(invokeAdapter?: HistoryInvoke): Promise<BackupResult | null> {
  return invokeParsed('create_history_backup', {}, parseBackupResult, invokeAdapter)
}

export function prepareNativeHistoryRestore(invokeAdapter?: HistoryInvoke): Promise<PreparedRestoreResult | null> {
  return invokeParsed('prepare_history_restore', {}, parsePreparedRestoreResult, invokeAdapter)
}

export function commitNativeHistoryRestore(
  token: string,
  invokeAdapter?: HistoryInvoke,
): Promise<RestoreResult | null> {
  if (!isOpaqueRestoreToken(token)) return Promise.resolve(null)
  return invokeParsed('commit_history_restore', { token }, parseRestoreResult, invokeAdapter)
}

export function discardNativeHistoryRestore(
  token: string,
  invokeAdapter?: HistoryInvoke,
): Promise<DiscardResult | null> {
  if (!isOpaqueRestoreToken(token)) return Promise.resolve(null)
  return invokeParsed('discard_history_restore', { token }, parseDiscardResult, invokeAdapter)
}

export function getNativeHistoryHealth(invokeAdapter?: HistoryInvoke): Promise<HistoryHealth | null> {
  return invokeParsed('get_history_health', {}, parseHistoryHealth, invokeAdapter)
}

export function getNativeStorageStats(invokeAdapter?: HistoryInvoke): Promise<StorageStats | null> {
  return invokeParsed('get_storage_stats', {}, parseStorageStats, invokeAdapter)
}

export function compactNativeHistoryDatabase(invokeAdapter?: HistoryInvoke): Promise<StorageStats | null> {
  return invokeParsed('compact_history_database', {}, parseStorageStats, invokeAdapter)
}

const HISTORY_SUMMARY_KEYS = new Set([
  'id', 'kind', 'title', 'content', 'sourceApp', 'copiedAt', 'updatedAt', 'pinned',
  'permanent', 'collectionId', 'searchTerms', 'ocrStatus', 'color', 'dimensions', 'formats',
  'omittedFormats', 'payloadLoaded', 'files', 'imageHash', 'matchSource',
])
const HISTORY_FULL_KEYS = new Set([
  'id', 'kind', 'title', 'content', 'sourceApp', 'sourceAppIcon', 'copiedAt', 'updatedAt',
  'pinned', 'permanent', 'collectionId', 'searchTerms', 'ocrText', 'ocrStatus', 'color',
  'dimensions', 'formats', 'omittedFormats', 'payloadLoaded', 'html', 'rtfBase64', 'imageUrl',
  'files', 'imageHash',
])
const HISTORY_REQUIRED_KEYS = [
  'id', 'kind', 'title', 'content', 'sourceApp', 'copiedAt', 'updatedAt', 'pinned',
  'permanent', 'searchTerms', 'formats', 'payloadLoaded', 'files',
] as const

function hasExactNativeItemShape(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  payloadLoaded: boolean,
): value is Record<string, unknown> {
  return isRecord(value)
    && value.payloadLoaded === payloadLoaded
    && HISTORY_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowedKeys.has(key))
    && !Object.values(value).some((field) => field === null || field === undefined)
}

function parseNativeFullItems(value: unknown): LoadedClipboardItem[] | null {
  if (!Array.isArray(value)
    || value.some((item) => !hasExactNativeItemShape(item, HISTORY_FULL_KEYS, true))) return null
  for (const item of value) {
    if (Object.hasOwn(item, 'sourceAppIcon')
      && normalizeSourceAppIcon(item.sourceAppIcon) !== item.sourceAppIcon) return null
  }
  return parseClipboardItems(value)
}

function parseHistorySummary(value: unknown): ClipboardItemSummary | null {
  if (!hasExactNativeItemShape(value, HISTORY_SUMMARY_KEYS, false)) return null
  if (typeof value.content !== 'string' || [...value.content].length > 512) return null
  if (!Array.isArray(value.searchTerms) || value.searchTerms.length > 0) return null
  const matchSource = value.matchSource
  if (matchSource !== 'none' && matchSource !== 'direct' && matchSource !== 'index' && matchSource !== 'ocr') return null
  if (matchSource === 'ocr' && (value.kind !== 'image' || value.ocrStatus !== 'completed')) return null

  // 摘要不携带 OCR 正文；completed 的空串只用于复用完整记录的不变量校验，随后立即丢弃。
  const { matchSource: _matchSource, ...clipboardValue } = value
  const parsed = parseClipboardItems([{
    ...clipboardValue,
    payloadLoaded: true,
    ...(value.ocrStatus === 'completed' ? { ocrText: '' } : {}),
  }])?.[0]
  if (!parsed) return null
  const {
    sourceAppIcon: _sourceAppIcon,
    imageUrl: _imageUrl,
    html: _html,
    rtfBase64: _rtfBase64,
    ocrText: _ocrText,
    payloadLoaded: _payloadLoaded,
    searchTerms: _searchTerms,
    ...summary
  } = parsed
  return {
    ...summary,
    files: summary.files?.map((file) => ({ ...file })) ?? [],
    searchTerms: [],
    payloadLoaded: false,
    matchSource,
  }
}

function parseHistoryPage(value: unknown): HistoryPage | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['items', 'nextCursor', 'totalCount'].includes(key))
    || !Array.isArray(value.items)
    || !Number.isSafeInteger(value.totalCount)
    || (value.totalCount as number) < value.items.length
    || (value.nextCursor !== undefined && !isValidHistoryCursor(value.nextCursor))) return null

  const items: ClipboardItemSummary[] = []
  const ids = new Set<string>()
  for (const rawItem of value.items) {
    const item = parseHistorySummary(rawItem)
    if (!item || ids.has(item.id)) return null
    ids.add(item.id)
    items.push(item)
  }
  return {
    items,
    ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}),
    totalCount: value.totalCount as number,
  }
}

function isValidPayloadId(value: string): boolean {
  return isValidClipboardItemId(value)
}

export async function queryNativeHistory(
  query: HistoryQuery,
  invokeAdapter?: HistoryInvoke,
): Promise<HistoryPage | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null
  let normalized: HistoryQuery
  try {
    normalized = normalizeHistoryQuery(query)
  } catch {
    return null
  }

  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('query_clipboard_history', { query: normalized })
    return parseHistoryPage(result)
  } catch {
    return null
  }
}

export async function loadNativeClipPayload(
  id: string,
  invokeAdapter?: HistoryInvoke,
): Promise<ClipPayloadLoadResult> {
  if (!isValidPayloadId(id) || !invokeAdapter && !isTauriRuntime()) return { status: 'failed' }
  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('get_clip_payload', { id })
    if (result === null) return { status: 'missing' }
    const item = parseNativeFullItems([result])?.[0]
    return item?.id === id ? { status: 'loaded', item } : { status: 'failed' }
  } catch {
    return { status: 'failed' }
  }
}

export async function loadNativeHistory(invokeAdapter?: HistoryInvoke): Promise<ClipboardItem[] | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null

  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('load_clipboard_history', {})
    return parseNativeFullItems(result)
  } catch {
    return null
  }
}

export async function applyNativeHistoryMutation(
  mutation: HistoryMutation,
  invokeAdapter?: HistoryInvoke,
): Promise<HistoryMutationResult | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null

  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('apply_history_mutation', { ...mutation })
    if (!isRecord(result) || !hasExactKeys(result, ['prunedIds'])) return null
    const prunedIds = result.prunedIds
    if (!Array.isArray(prunedIds)) return null
    if (prunedIds.some((id) => !isValidClipboardItemId(id))) return null
    if (new Set(prunedIds).size !== prunedIds.length) return null
    return { prunedIds: [...prunedIds] }
  } catch {
    return null
  }
}

export async function listNativeHistoryCollections(
  invokeAdapter?: HistoryInvoke,
): Promise<Collection[] | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null
  try {
    return normalizeCollections(
      await (invokeAdapter ?? invokeThroughTauri)('list_history_collections', {}),
    )
  } catch {
    return null
  }
}

export async function createNativeHistoryCollection(
  name: string,
  invokeAdapter?: HistoryInvoke,
): Promise<Collection | null> {
  let normalizedName: string
  try {
    normalizedName = normalizeCollectionName(name, [])
  } catch {
    return null
  }
  if (!invokeAdapter && !isTauriRuntime()) return null
  try {
    return normalizeCollection(await (invokeAdapter ?? invokeThroughTauri)(
      'create_history_collection',
      { name: normalizedName },
    ))
  } catch {
    return null
  }
}

export async function renameNativeHistoryCollection(
  id: string,
  name: string,
  invokeAdapter?: HistoryInvoke,
): Promise<Collection | null> {
  if (!isValidClipboardItemId(id)) return null
  let normalizedName: string
  try {
    normalizedName = normalizeCollectionName(name, [])
  } catch {
    return null
  }
  if (!invokeAdapter && !isTauriRuntime()) return null
  try {
    return normalizeCollection(await (invokeAdapter ?? invokeThroughTauri)(
      'rename_history_collection',
      { id, name: normalizedName },
    ))
  } catch {
    return null
  }
}

export async function deleteNativeHistoryCollection(
  id: string,
  invokeAdapter?: HistoryInvoke,
): Promise<CollectionDeleteResult | null> {
  if (!isValidClipboardItemId(id) || !invokeAdapter && !isTauriRuntime()) return null
  try {
    const value = await (invokeAdapter ?? invokeThroughTauri)('delete_history_collection', { id })
    if (!isRecord(value)
      || !hasExactKeys(value, ['affectedCount'])
      || !isSafeUnsignedInteger(value.affectedCount)) return null
    return { affectedCount: value.affectedCount }
  } catch {
    return null
  }
}

function isPlainPermanentSnippet(item: LoadedClipboardItem): boolean {
  return item.permanent === true
    && (item.kind === 'text' || item.kind === 'code')
    && item.formats?.length === 1
    && item.formats[0] === 'text'
    && !item.html
    && !item.rtfBase64
    && !item.imageUrl
    && (item.files?.length ?? 0) === 0
    && (item.omittedFormats?.length ?? 0) === 0
}

export async function saveNativeHistorySnippet(
  draft: SnippetDraft,
  invokeAdapter?: HistoryInvoke,
): Promise<LoadedClipboardItem | null> {
  let normalizedDraft: SnippetDraft
  try {
    normalizedDraft = normalizeSnippetDraft(draft)
  } catch {
    return null
  }
  if (!invokeAdapter && !isTauriRuntime()) return null
  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('save_history_snippet', {
      draft: normalizedDraft,
    })
    const item = parseNativeFullItems([result])?.[0]
    return item && isPlainPermanentSnippet(item) ? item : null
  } catch {
    return null
  }
}

export async function applyNativeHistoryBatch(
  target: BatchTarget,
  action: BatchAction,
  invokeAdapter?: HistoryInvoke,
): Promise<BatchResult | null> {
  let normalizedTarget: BatchTarget
  let normalizedAction: BatchAction
  try {
    normalizedTarget = normalizeBatchTarget(target)
    normalizedAction = normalizeBatchAction(action)
  } catch {
    return null
  }
  if (!invokeAdapter && !isTauriRuntime()) return null
  try {
    return normalizeBatchResult(await (invokeAdapter ?? invokeThroughTauri)(
      'apply_history_batch',
      { target: normalizedTarget, action: normalizedAction },
    ))
  } catch {
    return null
  }
}

function cloneItems(items: ClipboardItem[]): ClipboardItem[] {
  return items.map((item) => {
    const arrays = {
      ...(item.formats ? { formats: [...item.formats] } : {}),
      ...(item.omittedFormats ? { omittedFormats: [...item.omittedFormats] } : {}),
      ...(item.files ? { files: item.files.map((file) => ({ ...file })) } : {}),
    }
    if (item.payloadLoaded === false) {
      return { ...item, ...arrays, searchTerms: [], payloadLoaded: false }
    }
    return { ...item, ...arrays, searchTerms: [...item.searchTerms] }
  })
}

function clonePolicy(policy: CapacityPolicy): CapacityPolicy {
  return { ...policy }
}

function sameOrderedArray<T>(
  left: T[] | undefined,
  right: T[] | undefined,
  sameValue: (leftValue: T, rightValue: T) => boolean,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length
    && left.every((value, index) => sameValue(value, right[index]))
}

function sameFile(left: NonNullable<ClipboardItem['files']>[number], right: NonNullable<ClipboardItem['files']>[number]): boolean {
  return left.path === right.path
    && left.name === right.name
    && left.extension === right.extension
    && left.size === right.size
    && left.modifiedAt === right.modifiedAt
    && left.directory === right.directory
    && left.exists === right.exists
}

function sameItem(left: ClipboardItem, right: ClipboardItem): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.title === right.title
    && left.content === right.content
    && left.sourceApp === right.sourceApp
    && left.sourceAppIcon === right.sourceAppIcon
    && left.copiedAt === right.copiedAt
    && left.pinned === right.pinned
    && sameOrderedArray(left.searchTerms, right.searchTerms, (leftTerm, rightTerm) => leftTerm === rightTerm)
    && left.imageUrl === right.imageUrl
    && left.dimensions === right.dimensions
    && left.color === right.color
    && sameOrderedArray(left.formats, right.formats, (leftFormat, rightFormat) => leftFormat === rightFormat)
    && sameOrderedArray(left.omittedFormats, right.omittedFormats, (leftFormat, rightFormat) => leftFormat === rightFormat)
    && left.html === right.html
    && left.rtfBase64 === right.rtfBase64
    && sameOrderedArray(left.files, right.files, sameFile)
    && left.ocrText === right.ocrText
    && left.ocrStatus === right.ocrStatus
    && left.imageHash === right.imageHash
    && left.collectionId === right.collectionId
    && left.permanent === right.permanent
    && left.updatedAt === right.updatedAt
    && left.payloadLoaded === right.payloadLoaded
}

function samePolicy(left: CapacityPolicy, right: CapacityPolicy): boolean {
  return left.maxRecords === right.maxRecords
    && left.maxImageBytes === right.maxImageBytes
    && left.retentionDays === right.retentionDays
}

function createMutation(
  confirmedItems: ClipboardItem[],
  confirmedPolicy: CapacityPolicy,
  targetItems: ClipboardItem[],
  targetPolicy: CapacityPolicy,
): HistoryMutation | null {
  const confirmedById = new Map(confirmedItems.map((item) => [item.id, item]))
  const targetById = new Map(targetItems.map((item) => [item.id, item]))
  const upserts = targetItems.filter((item) => {
    const previous = confirmedById.get(item.id)
    return !previous || !sameItem(previous, item)
  })
  const deleteIds = confirmedItems
    .filter((item) => !targetById.has(item.id))
    .map((item) => item.id)

  if (upserts.length === 0 && deleteIds.length === 0 && samePolicy(confirmedPolicy, targetPolicy)) return null
  return { upserts: cloneItems(upserts), deleteIds, policy: clonePolicy(targetPolicy) }
}

interface DeferredHistoryChange {
  before: ClipboardItem | null
  after: ClipboardItem | null
}

function sameOptionalItem(left: ClipboardItem | null, right: ClipboardItem | null): boolean {
  if (!left || !right) return left === right
  return sameItem(left, right)
}

function rebaseDeferredChanges(
  target: ClipboardItem[],
  changes: Map<string, DeferredHistoryChange>,
): ClipboardItem[] {
  const targetById = new Map(target.map((item) => [item.id, item]))
  const removedIds = new Set<string>()
  for (const [id, change] of changes) {
    const current = targetById.get(id)
    if (change.before && !change.after && current && sameItem(current, change.before)) removedIds.add(id)
  }
  const rebased = target
    .filter((item) => !removedIds.has(item.id))
    .map((item) => ({ ...item }))
  const indexById = new Map(rebased.map((item, index) => [item.id, index]))
  for (const [id, change] of changes) {
    if (!change.after) continue
    const index = indexById.get(id)
    if (change.before) {
      if (index === undefined || !sameItem(rebased[index], change.before)) continue
      rebased[index] = cloneItems([change.after])[0]
    } else if (index === undefined) {
      indexById.set(id, rebased.length)
      rebased.push(cloneItems([change.after])[0])
    }
  }
  return rebased
}

export function createIncrementalHistoryPersistence(
  apply: (mutation: HistoryMutation) => Promise<HistoryMutationResult | null>,
  options: { delayMs?: number; onSaveFailed?: () => void; onCapacityPruned?: (ids: string[]) => void } = {},
): IncrementalHistoryPersistence {
  const delayMs = options.delayMs ?? 180
  let confirmedItems: ClipboardItem[] = []
  let confirmedPolicy: CapacityPolicy = { maxRecords: 500, maxImageBytes: 256 * 1024 * 1024, retentionDays: 30 }
  let targetItems: ClipboardItem[] = []
  let targetPolicy = clonePolicy(confirmedPolicy)
  let dirty = false
  let resetGeneration = 0
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingFlush: Promise<boolean> | null = null
  let frozen = false
  let leaseSequence = 0
  let activeLease = 0
  let deferredPolicyBefore = clonePolicy(targetPolicy)
  let deferredPolicyAfter = clonePolicy(targetPolicy)
  const deferredChanges = new Map<string, DeferredHistoryChange>()

  const clearTimer = () => {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = undefined
  }

  const updateDirty = () => {
    dirty = createMutation(confirmedItems, confirmedPolicy, targetItems, targetPolicy) !== null
  }

  const armSaveTimer = () => {
    clearTimer()
    if (dirty && !frozen) saveTimer = setTimeout(() => { void flush() }, delayMs)
  }

  const replayDeferredSchedules = () => {
    targetItems = rebaseDeferredChanges(targetItems, deferredChanges)
    if (!samePolicy(deferredPolicyBefore, deferredPolicyAfter)) targetPolicy = clonePolicy(deferredPolicyAfter)
    deferredChanges.clear()
    updateDirty()
    armSaveTimer()
  }

  const releaseExclusiveLease = (lease: number) => {
    if (!frozen || lease !== activeLease) return
    frozen = false
    activeLease = 0
    replayDeferredSchedules()
  }

  const acknowledgeExternalOcrPatch = (
    id: string,
    imageHash: string,
    patch: ExternalOcrPatch,
  ): boolean => {
    if (!isValidClipboardItemId(id) || !isValidImageHash(imageHash)) return false
    const patchKeys = Object.keys(patch)
    if (patchKeys.some((key) => key !== 'ocrStatus' && key !== 'ocrText')
      || (patch.ocrStatus !== 'completed'
        && patch.ocrStatus !== 'unavailable'
        && patch.ocrStatus !== 'failed'
        && patch.ocrStatus !== 'oversized')
      || (patch.ocrStatus === 'completed'
        ? typeof patch.ocrText !== 'string'
          || new TextEncoder().encode(patch.ocrText).length > 256 * 1024
        : patch.ocrText !== undefined)) return false

    const confirmed = confirmedItems.find((item) => item.id === id)
    const target = targetItems.find((item) => item.id === id)
    if (!confirmed || !target
      || confirmed.kind !== 'image'
      || target.kind !== 'image'
      || confirmed.imageHash !== imageHash
      || target.imageHash !== imageHash
      || confirmed.ocrStatus !== 'pending'
      || target.ocrStatus !== 'pending') return false

    const patchItem = (item: ClipboardItem): ClipboardItem => {
      if (item.id !== id) return item
      const next: ClipboardItem = { ...item, imageHash, ocrStatus: patch.ocrStatus }
      if (next.payloadLoaded !== false && patch.ocrStatus === 'completed') {
        next.ocrText = patch.ocrText
      } else if (next.payloadLoaded !== false) {
        delete next.ocrText
      }
      return next
    }
    confirmedItems = confirmedItems.map(patchItem)
    targetItems = targetItems.map(patchItem)
    updateDirty()
    return true
  }

  const flush = async (): Promise<boolean> => {
    clearTimer()
    if (pendingFlush) return pendingFlush
    if (!dirty) return true

    pendingFlush = (async () => {
      while (dirty) {
        const attemptGeneration = resetGeneration
        const mutation = createMutation(confirmedItems, confirmedPolicy, targetItems, targetPolicy)
        if (!mutation) {
          dirty = false
          return true
        }
        const sentItems = cloneItems(targetItems)
        const sentPolicy = clonePolicy(targetPolicy)
        let result: HistoryMutationResult | null = null
        try {
          result = await apply(mutation)
        } catch {
          result = null
        }
        if (attemptGeneration !== resetGeneration) continue
        if (!result) {
          updateDirty()
          options.onSaveFailed?.()
          return false
        }
        const prunedIds = new Set(result.prunedIds)
        confirmedItems = sentItems.filter((item) => !prunedIds.has(item.id))
        confirmedPolicy = sentPolicy
        const sentById = new Map(sentItems.map((item) => [item.id, item]))
        const removedFromTarget: string[] = []
        targetItems = targetItems.filter((item) => {
          if (!prunedIds.has(item.id)) return true
          const sentItem = sentById.get(item.id)
          if (!sentItem || !sameItem(sentItem, item)) return true
          removedFromTarget.push(item.id)
          return false
        })
        if (removedFromTarget.length > 0) options.onCapacityPruned?.(removedFromTarget)
        updateDirty()
      }
      return true
    })()

    try {
      return await pendingFlush
    } finally {
      pendingFlush = null
    }
  }

  const acquireExclusiveLease = async (): Promise<HistoryExclusiveLease> => {
    if (frozen) throw new Error('历史写入队列已冻结')
    frozen = true
    clearTimer()
    activeLease = ++leaseSequence
    const lease = activeLease
    deferredPolicyBefore = clonePolicy(targetPolicy)
    deferredPolicyAfter = clonePolicy(targetPolicy)
    const drained = await flush()
    if (!drained) {
      releaseExclusiveLease(lease)
      throw new Error('历史写入队列尚未排空')
    }
    let released = false
    return {
      release() {
        if (released) return
        released = true
        releaseExclusiveLease(lease)
      },
    }
  }

  return {
    reset(items, policy) {
      clearTimer()
      resetGeneration += 1
      confirmedItems = cloneItems(items)
      confirmedPolicy = clonePolicy(policy)
      targetItems = cloneItems(items)
      targetPolicy = clonePolicy(policy)
      dirty = false
    },
    schedule(_previous, next, policy) {
      if (frozen) {
        const previousById = new Map(_previous.map((item) => [item.id, item]))
        const nextById = new Map(next.map((item) => [item.id, item]))
        const changedIds = new Set([...previousById.keys(), ...nextById.keys()])
        for (const id of changedIds) {
          const previousItem = previousById.get(id) ?? null
          const nextItem = nextById.get(id) ?? null
          if (sameOptionalItem(previousItem, nextItem)) continue
          const existing = deferredChanges.get(id)
          const before = existing ? existing.before : (previousItem ? cloneItems([previousItem])[0] : null)
          const after = nextItem ? cloneItems([nextItem])[0] : null
          if (sameOptionalItem(before, after)) deferredChanges.delete(id)
          else deferredChanges.set(id, { before, after })
        }
        deferredPolicyAfter = clonePolicy(policy)
        return
      }
      targetItems = cloneItems(next)
      targetPolicy = clonePolicy(policy)
      updateDirty()
      armSaveTimer()
    },
    flush,
    isDirty: () => dirty,
    isFrozen: () => frozen,
    acquireExclusiveLease,
    acknowledgeExternalOcrPatch,
    cancel: clearTimer,
  }
}

export function createSerializedHistoryOperationLane(
  persistence: Pick<IncrementalHistoryPersistence, 'acquireExclusiveLease' | 'reset'>,
): SerializedHistoryOperationLane {
  let tail: Promise<void> = Promise.resolve()
  let queued = 0
  let running = false
  let refreshGeneration = 0

  const execute = async <T>(
    operation: SerializedHistoryOperation<T>,
  ): Promise<HistoryOperationResult<T>> => {
    queued -= 1
    running = true
    const operationGeneration = ++refreshGeneration
    let lease: HistoryExclusiveLease | null = null
    try {
      try {
        lease = await persistence.acquireExclusiveLease()
      } catch {
        return { status: 'failed' }
      }

      let value: T | null
      try {
        value = await operation.mutate()
      } catch {
        return { status: 'failed' }
      }
      if (value === null) return { status: 'failed' }

      let snapshot: HistoryOperationSnapshot | null
      try {
        snapshot = await operation.refresh()
      } catch {
        snapshot = null
      }
      if (!snapshot || operationGeneration !== refreshGeneration) {
        return { status: 'committedRefreshFailed', value }
      }

      try {
        // reset 会复制数据；随后 UI 即使替换或修改响应对象，也不会污染已确认基线。
        persistence.reset(snapshot.items, snapshot.policy)
        operation.commit(snapshot)
      } catch {
        return { status: 'committedRefreshFailed', value }
      }
      return { status: 'committed', value }
    } finally {
      lease?.release()
      running = false
    }
  }

  return {
    run<T>(operation: SerializedHistoryOperation<T>): Promise<HistoryOperationResult<T>> {
      queued += 1
      const result = tail.then(
        () => execute(operation),
        () => execute(operation),
      )
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    invalidate() {
      refreshGeneration += 1
    },
    isBusy: () => running || queued > 0,
  }
}
