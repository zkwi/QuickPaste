import {
  normalizeSearchQueryText,
  isValidClipboardItemId,
  trimSearchWhitespace,
  type ClipboardItemSummary,
  type ClipKind,
  type HistoryMatchSource,
  type OcrStatus,
} from './clipboard'

export type { ClipboardItemSummary } from './clipboard'

export type CollectionScope =
  | { mode: 'any' }
  | { mode: 'unfiled' }
  | { mode: 'collection'; id: string }

export interface HistoryQuery {
  text: string
  kinds: ClipKind[]
  sourceApps: string[]
  collection: CollectionScope
  pinned?: boolean
  permanent?: boolean
  limit: number
  cursor?: string
}

export interface HistoryPage {
  items: ClipboardItemSummary[]
  nextCursor?: string
  totalCount: number
}

const CLIP_KIND_ORDER: readonly ClipKind[] = ['text', 'code', 'link', 'image', 'file']
const COLLECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
const MAX_QUERY_LIMIT = 200
const MAX_CURSOR_LENGTH = 512
const MIN_CANONICAL_UTC_MILLIS = -62_167_219_200_000
const MAX_CANONICAL_UTC_MILLIS = 253_402_300_799_999
const CURSOR_CONTROL_CHARACTER = /\p{Cc}/u

export function isValidHistoryCursor(value: unknown): value is string {
  if (typeof value !== 'string'
    || !value
    || value.length > MAX_CURSOR_LENGTH
    || CONTROL_CHARACTER.test(value)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || value.length % 4 !== 0) return false

  try {
    const binary = atob(value)
    if (btoa(binary) !== value) return false
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )
    const separator = decoded.indexOf('\n')
    if (separator < 1) return false
    const millisText = decoded.slice(0, separator)
    const id = decoded.slice(separator + 1)
    if (!isValidClipboardItemId(id) || CURSOR_CONTROL_CHARACTER.test(id) || millisText.startsWith('+')) return false
    const millis = Number(millisText)
    return Number.isSafeInteger(millis)
      && String(millis) === millisText
      && millis >= MIN_CANONICAL_UTC_MILLIS
      && millis <= MAX_CANONICAL_UTC_MILLIS
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKinds(value: unknown): ClipKind[] {
  if (!Array.isArray(value) || value.some((kind) => !CLIP_KIND_ORDER.includes(kind as ClipKind))) {
    throw new Error('历史类型筛选无效')
  }
  const kinds = new Set(value as ClipKind[])
  return CLIP_KIND_ORDER.filter((kind) => kinds.has(kind))
}

function normalizeSourceApps(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((source) => typeof source !== 'string')) {
    throw new Error('历史来源筛选无效')
  }
  return [...new Set(value.map(trimSearchWhitespace).filter(Boolean))].sort()
}

function normalizeCollection(value: unknown): CollectionScope {
  if (!isRecord(value)) throw new Error('历史集合筛选无效')
  if (value.mode === 'any') return { mode: 'any' }
  if (value.mode === 'unfiled') return { mode: 'unfiled' }
  if (value.mode !== 'collection' || typeof value.id !== 'string') {
    throw new Error('历史集合筛选无效')
  }
  const id = trimSearchWhitespace(value.id)
  if (!COLLECTION_ID.test(id)) throw new Error('历史集合标识无效')
  return { mode: 'collection', id }
}

export function normalizeHistoryQuery(value: HistoryQuery): HistoryQuery {
  if (!isRecord(value) || typeof value.text !== 'string') throw new Error('历史查询无效')
  if (value.pinned !== undefined && typeof value.pinned !== 'boolean') {
    throw new Error('固定筛选无效')
  }
  if (value.permanent !== undefined && typeof value.permanent !== 'boolean') {
    throw new Error('永久片段筛选无效')
  }
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_QUERY_LIMIT) {
    throw new Error('历史分页大小无效')
  }
  if (value.cursor !== undefined && !isValidHistoryCursor(value.cursor)) {
    throw new Error('历史分页游标无效')
  }

  return {
    text: normalizeSearchQueryText(value.text),
    kinds: normalizeKinds(value.kinds),
    sourceApps: normalizeSourceApps(value.sourceApps),
    collection: normalizeCollection(value.collection),
    ...(value.pinned === undefined ? {} : { pinned: value.pinned }),
    ...(value.permanent === undefined ? {} : { permanent: value.permanent }),
    limit: value.limit,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  }
}

export function historyQueryKey(value: HistoryQuery): string {
  const query = normalizeHistoryQuery(value)
  return JSON.stringify({
    text: query.text,
    kinds: query.kinds,
    sourceApps: query.sourceApps,
    collection: query.collection,
    ...(query.pinned === undefined ? {} : { pinned: query.pinned }),
    ...(query.permanent === undefined ? {} : { permanent: query.permanent }),
    limit: query.limit,
  })
}

export function historyMatchBadge(
  clip: {
    payloadLoaded?: boolean
    matchSource?: HistoryMatchSource
    kind: ClipKind
    ocrStatus?: OcrStatus
  },
  hasTerms: boolean,
): 'ocr' | 'index' | null {
  if (!hasTerms || clip.payloadLoaded !== false) return null
  if (clip.matchSource === 'ocr'
    && clip.kind === 'image'
    && clip.ocrStatus === 'completed') return 'ocr'
  return clip.matchSource === 'index' ? 'index' : null
}
