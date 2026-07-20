import { pinyin } from 'pinyin-pro'

export type ClipKind = 'text' | 'code' | 'link' | 'image' | 'file'
export type ClipboardFormat = 'text' | 'html' | 'rtf' | 'image' | 'files'
export type OcrStatus = 'pending' | 'completed' | 'unavailable' | 'failed' | 'oversized'
export type HistoryMatchSource = 'none' | 'direct' | 'index' | 'ocr'

export interface ClipboardFile {
  path: string
  name: string
  extension?: string
  size?: number
  modifiedAt?: string
  directory: boolean
  exists: boolean
}
export type ClipKindFilter = 'all' | 'pinned' | ClipKind
export type RetentionPeriod = '7' | '30' | '90' | 'forever'

export interface ClipboardItemBase {
  id: string
  kind: ClipKind
  title: string
  content: string
  sourceApp: string
  copiedAt: string
  pinned: boolean
  dimensions?: string
  color?: string
  // 保持旧版持久化记录和现有调用方兼容；新捕获记录会明确记录格式。
  formats?: ClipboardFormat[]
  omittedFormats?: ClipboardFormat[]
  files?: ClipboardFile[]
  imageHash?: string
  ocrStatus?: OcrStatus
  collectionId?: string
  permanent?: boolean
  updatedAt?: string
}

export interface LoadedClipboardItem extends ClipboardItemBase {
  searchTerms: string[]
  sourceAppIcon?: string
  imageUrl?: string
  html?: string
  rtfBase64?: string
  ocrText?: string
  payloadLoaded?: true
}

export interface ClipboardItemSummary extends ClipboardItemBase {
  searchTerms: []
  payloadLoaded: false
  // native 查询摘要始终提供；可选仅便于非 native/测试调用方构造本地摘要。
  matchSource?: HistoryMatchSource
  // 应用图标是有上限的列表元数据，不属于需要延迟加载的正文载荷。
  sourceAppIcon?: string
  // 摘要绝不能携带正文载荷；never 也让联合类型的现有只读访问保持可收窄。
  imageUrl?: never
  html?: never
  rtfBase64?: never
  ocrText?: never
}

export type ClipboardItem = LoadedClipboardItem | ClipboardItemSummary

export interface CapturedClipboardPayload {
  kind: 'text' | 'image' | 'file'
  content: string
  capturedAt: string
  sourceApp?: string
  sourceAppIcon?: string
  width?: number
  height?: number
  formats?: readonly ClipboardFormat[]
  omittedFormats?: readonly ClipboardFormat[]
  html?: string
  rtfBase64?: string
  files?: ClipboardFile[]
  imageHash?: string
}

const SOURCE_APP_ICON_PREFIX = 'data:image/png;base64,'
const MAX_SOURCE_APP_ICON_DATA_URL_LENGTH = 64 * 1024
const PINYIN_INDEX_MAX_CHARACTERS = 4096
const HAN_CHARACTER = /\p{Script=Han}/u
const SEARCH_QUERY_WHITESPACE = /[\p{White_Space}\uFEFF]+/gu
const SEARCH_EDGE_WHITESPACE = /^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu
const CLIPBOARD_FORMAT_ORDER: readonly ClipboardFormat[] = ['text', 'html', 'rtf', 'image', 'files']
const MAX_HISTORY_CURSOR_UTF16 = 512
export const MAX_OCR_TEXT_BYTES = 256 * 1024
const CURSOR_ID_PREFIX = '-9223372036854775808\n'
const UNICODE_CONTROL_CHARACTER = /\p{Cc}/u
const CLIPBOARD_ITEM_KEYS = new Set([
  'id', 'kind', 'title', 'content', 'sourceApp', 'sourceAppIcon', 'copiedAt', 'pinned',
  'searchTerms', 'imageUrl', 'dimensions', 'color', 'formats', 'omittedFormats', 'html',
  'rtfBase64', 'files', 'ocrText', 'ocrStatus', 'collectionId', 'permanent', 'updatedAt',
  'imageHash',
  'payloadLoaded',
])
const CLIPBOARD_FILE_KEYS = new Set([
  'path', 'name', 'extension', 'size', 'modifiedAt', 'directory', 'exists',
])

export function normalizeSourceAppIcon(value: unknown): string | undefined {
  if (typeof value !== 'string'
    || value.length > MAX_SOURCE_APP_ICON_DATA_URL_LENGTH
    || !value.startsWith(`${SOURCE_APP_ICON_PREFIX}iVBORw0KGgo`)) {
    return undefined
  }

  const encoded = value.slice(SOURCE_APP_ICON_PREFIX.length)
  return encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ? value
    : undefined
}

export interface ClipFilter {
  query: string
  kind: ClipKindFilter
}

export interface RemovedClip {
  clip: ClipboardItem
  index: number
}

export interface RemoveClipResult {
  items: ClipboardItem[]
  undo: RemovedClip | null
}

export interface ClearHistoryResult {
  items: ClipboardItem[]
  removedCount: number
}

export function normalizeSearchText(value: string): string {
  // Unicode 默认小写只在词尾 Sigma 上有上下文差异；折叠为 σ 后既能保留原生转换速度，
  // 也能确保整串筛选与按字素建立的高亮索引完全一致。
  return value.normalize('NFKC').toLowerCase().replaceAll('ς', 'σ')
}

export function normalizeSearchQueryText(value: string): string {
  return normalizeSearchText(value).replace(SEARCH_QUERY_WHITESPACE, ' ').trim()
}

export function trimSearchWhitespace(value: string): string {
  return value.replace(SEARCH_EDGE_WHITESPACE, '')
}

export function isValidClipboardItemId(value: unknown): value is string {
  if (typeof value !== 'string'
    || !value
    || trimSearchWhitespace(value) !== value
    || UNICODE_CONTROL_CHARACTER.test(value)) return false
  const cursorBytes = new TextEncoder().encode(`${CURSOR_ID_PREFIX}${value}`).length
  return 4 * Math.ceil(cursorBytes / 3) <= MAX_HISTORY_CURSOR_UTF16
}

function pinyinSearchTerms(values: string[]): string[] {
  const source = values.join('\n').slice(0, PINYIN_INDEX_MAX_CHARACTERS)
  if (!HAN_CHARACTER.test(source)) return []

  const options = { toneType: 'none', type: 'array', nonZh: 'removed', v: true } as const
  const syllables = pinyin(source, options)
  const initials = pinyin(source, { ...options, pattern: 'first' })
  return [...new Set([
    syllables.join(''),
    initials.join(''),
  ].map(normalizeSearchText).filter(Boolean))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClipboardFormat(value: unknown): value is ClipboardFormat {
  return value === 'text' || value === 'html' || value === 'rtf' || value === 'image' || value === 'files'
}

export function isValidImageHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function isCanonicalOcrText(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.includes('\0')
    || new TextEncoder().encode(value).length > MAX_OCR_TEXT_BYTES) return false
  const withoutCrLf = value.replaceAll('\r\n', '')
  return !withoutCrLf.includes('\r') && !withoutCrLf.includes('\n')
}

function sortClipboardFormats(values: Iterable<ClipboardFormat>): ClipboardFormat[] {
  const formats = new Set(values)
  return CLIPBOARD_FORMAT_ORDER.filter((format) => formats.has(format))
}

function normalizeCapturedOmittedFormats(
  value: readonly ClipboardFormat[] | undefined,
  savedFormats: readonly ClipboardFormat[],
): ClipboardFormat[] | undefined {
  if (!value || value.length === 0) return undefined
  if (!value.every(isClipboardFormat)) throw new Error('未知的剪贴板格式')

  const omittedFormats = sortClipboardFormats(value)
  if (omittedFormats.some((format) => savedFormats.includes(format))) {
    throw new Error('遗漏格式不能与已保存格式重叠')
  }
  return omittedFormats
}

function parseFiles(value: unknown): ClipboardFile[] | null {
  if (!Array.isArray(value)) return null

  const files: ClipboardFile[] = []
  for (const file of value) {
    if (!isRecord(file)
      || Object.keys(file).some((key) => !CLIPBOARD_FILE_KEYS.has(key))
      || typeof file.path !== 'string'
      || typeof file.name !== 'string'
      || typeof file.directory !== 'boolean'
      || typeof file.exists !== 'boolean'
      || (file.extension !== undefined && typeof file.extension !== 'string')
      || (file.size !== undefined && (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0))
      || (file.modifiedAt !== undefined && typeof file.modifiedAt !== 'string')) {
      return null
    }
    files.push({
      path: file.path,
      name: file.name,
      directory: file.directory,
      exists: file.exists,
      ...(typeof file.extension === 'string' ? { extension: file.extension } : {}),
      ...(typeof file.size === 'number' ? { size: file.size } : {}),
      ...(typeof file.modifiedAt === 'string' ? { modifiedAt: file.modifiedAt } : {}),
    })
  }
  return files
}

export function parseClipboardItems(value: unknown): LoadedClipboardItem[] | null {
  if (!Array.isArray(value)) return null

  const parsedItems: LoadedClipboardItem[] = []
  const ids = new Set<string>()
  for (const valueItem of value) {
    if (!isRecord(valueItem)
      || Object.keys(valueItem).some((key) => !CLIPBOARD_ITEM_KEYS.has(key))
      || valueItem.payloadLoaded === false
      || valueItem.payloadLoaded !== undefined && valueItem.payloadLoaded !== true) return null

    const { id, kind, title, content, sourceApp, copiedAt } = valueItem
    if (!isValidClipboardItemId(id) || ids.has(id)) return null
    if (kind !== 'text' && kind !== 'code' && kind !== 'link' && kind !== 'image' && kind !== 'file') return null
    if (typeof title !== 'string' || typeof content !== 'string' || typeof sourceApp !== 'string') return null
    if (typeof copiedAt !== 'string') return null
    if (valueItem.pinned !== undefined && typeof valueItem.pinned !== 'boolean') return null
    if (valueItem.searchTerms !== undefined && valueItem.searchTerms !== null) {
      if (!Array.isArray(valueItem.searchTerms) || !valueItem.searchTerms.every((term) => typeof term === 'string')) {
        return null
      }
    }
    if ([valueItem.imageUrl, valueItem.dimensions, valueItem.color]
      .some((optional) => optional !== undefined && optional !== null && typeof optional !== 'string')) {
      return null
    }
    if (valueItem.formats !== undefined && (!Array.isArray(valueItem.formats)
      || valueItem.formats.length === 0
      || !valueItem.formats.every(isClipboardFormat)
      || new Set(valueItem.formats).size !== valueItem.formats.length)) return null
    const formats = valueItem.formats as ClipboardFormat[] | undefined
    let omittedFormats: ClipboardFormat[] | undefined
    if (valueItem.omittedFormats !== undefined) {
      if (!Array.isArray(valueItem.omittedFormats)
        || valueItem.omittedFormats.length === 0
        || !valueItem.omittedFormats.every(isClipboardFormat)
        || new Set(valueItem.omittedFormats).size !== valueItem.omittedFormats.length) return null
      omittedFormats = valueItem.omittedFormats as ClipboardFormat[]
      const canonicalOmittedFormats = sortClipboardFormats(omittedFormats)
      if (!omittedFormats.every((format, index) => format === canonicalOmittedFormats[index])) return null
      const savedFormats = formats ?? (kind === 'image' ? ['image'] : kind === 'file' ? [] : ['text'])
      if (omittedFormats.some((format) => savedFormats.includes(format))) return null
    }
    const parsedFiles = valueItem.files === undefined ? undefined : parseFiles(valueItem.files)
    if (valueItem.files !== undefined && parsedFiles === null) return null
    const files = parsedFiles ?? undefined
    const hasFiles = files !== undefined && files.length > 0
    if ([valueItem.html, valueItem.rtfBase64, valueItem.ocrText, valueItem.collectionId, valueItem.updatedAt]
      .some((optional) => optional !== undefined && typeof optional !== 'string')) return null
    if (valueItem.imageHash !== undefined && !isValidImageHash(valueItem.imageHash)) return null
    if (valueItem.ocrStatus !== undefined
      && valueItem.ocrStatus !== 'pending'
      && valueItem.ocrStatus !== 'completed'
      && valueItem.ocrStatus !== 'unavailable'
      && valueItem.ocrStatus !== 'failed'
      && valueItem.ocrStatus !== 'oversized') return null
    if (kind === 'image') {
      if (valueItem.ocrStatus !== undefined && !isValidImageHash(valueItem.imageHash)) return null
      if (valueItem.ocrStatus === 'completed' && !isCanonicalOcrText(valueItem.ocrText)) return null
      if (valueItem.ocrText !== undefined && valueItem.ocrStatus !== 'completed') return null
    }
    if (kind !== 'image'
      && (valueItem.imageHash !== undefined
        || valueItem.ocrText !== undefined
        || valueItem.ocrStatus !== undefined)) return null
    if (valueItem.permanent !== undefined && typeof valueItem.permanent !== 'boolean') return null
    if (typeof valueItem.html === 'string' && !formats?.includes('html')) return null
    if (typeof valueItem.rtfBase64 === 'string' && !formats?.includes('rtf')) return null
    if (hasFiles && (kind !== 'file' || !formats?.includes('files'))) return null
    if (kind === 'file' && (!formats
      || formats.length !== 1
      || formats[0] !== 'files'
      || !hasFiles
      || valueItem.html !== undefined
      || valueItem.rtfBase64 !== undefined
      || valueItem.imageUrl !== undefined)) return null
    if (kind === 'image' && (hasFiles
      || (formats !== undefined && (formats.length !== 1 || formats[0] !== 'image')))) return null
    if ((kind === 'text' || kind === 'code' || kind === 'link') && formats
      && (!formats.includes('text') || formats.some((format) => format !== 'text' && format !== 'html' && format !== 'rtf'))) return null
    if (valueItem.permanent === true
      && ((kind !== 'text' && kind !== 'code')
        || formats?.length !== 1
        || formats[0] !== 'text'
        || omittedFormats !== undefined
        || hasFiles
        || valueItem.html !== undefined
        || valueItem.rtfBase64 !== undefined
        || valueItem.imageUrl !== undefined
        || valueItem.imageHash !== undefined
        || valueItem.ocrText !== undefined
        || valueItem.ocrStatus !== undefined
        || valueItem.color !== undefined
        || valueItem.dimensions !== undefined)) return null

    const item: LoadedClipboardItem = {
      id,
      kind,
      title,
      content,
      sourceApp,
      copiedAt,
      pinned: valueItem.pinned ?? false,
      searchTerms: valueItem.searchTerms == null ? [] : [...valueItem.searchTerms],
    }
    if (typeof valueItem.imageUrl === 'string') item.imageUrl = valueItem.imageUrl
    if (typeof valueItem.dimensions === 'string') item.dimensions = valueItem.dimensions
    if (typeof valueItem.color === 'string') item.color = valueItem.color
    if (formats) item.formats = [...formats]
    if (omittedFormats) item.omittedFormats = [...omittedFormats]
    if (typeof valueItem.html === 'string') item.html = valueItem.html
    if (typeof valueItem.rtfBase64 === 'string') item.rtfBase64 = valueItem.rtfBase64
    if (hasFiles) item.files = files
    if (typeof valueItem.imageHash === 'string') item.imageHash = valueItem.imageHash
    if (typeof valueItem.ocrText === 'string') item.ocrText = valueItem.ocrText
    if (valueItem.ocrStatus !== undefined) item.ocrStatus = valueItem.ocrStatus as OcrStatus
    if (typeof valueItem.collectionId === 'string') item.collectionId = valueItem.collectionId
    if (typeof valueItem.permanent === 'boolean') item.permanent = valueItem.permanent
    if (typeof valueItem.updatedAt === 'string') item.updatedAt = valueItem.updatedAt
    const sourceAppIcon = normalizeSourceAppIcon(valueItem.sourceAppIcon)
    if (sourceAppIcon) item.sourceAppIcon = sourceAppIcon

    ids.add(id)
    parsedItems.push(item)
  }

  return parsedItems
}

function searchableText(clip: ClipboardItem): string {
  return normalizeSearchText([
    clip.title,
    clip.content,
    clip.sourceApp,
    clip.kind,
    ...clip.searchTerms,
    clip.ocrText ?? '',
    ...(clip.files?.map((file) => file.name) ?? []),
  ].join('\n'))
}

export function applyClipFilter(items: ClipboardItem[], filter: ClipFilter): ClipboardItem[] {
  const normalizedQuery = normalizeSearchQueryText(filter.query)
  const terms = normalizedQuery ? normalizedQuery.split(' ') : []

  return items.filter((clip) => {
    const matchesKind = filter.kind === 'all'
      || (filter.kind === 'pinned' ? clip.pinned : clip.kind === filter.kind)

    if (!matchesKind) return false
    if (terms.length === 0) return true

    const haystack = searchableText(clip)
    return terms.every((term) => haystack.includes(term))
  })
}

export function togglePinned(items: ClipboardItem[], id: string): ClipboardItem[] {
  return items.map((clip) => clip.id === id ? { ...clip, pinned: !clip.pinned } : clip)
}

function classifyCapturedText(content: string): Exclude<ClipKind, 'image' | 'file'> {
  if (/^https?:\/\/\S+$/i.test(content.trim())) return 'link'
  if (/(^|\n)\s*(const|let|var|function|class|import|export|fn|use|def|SELECT|INSERT|UPDATE)\b|[{}][\s\S]*[;=]/m.test(content)) return 'code'
  return 'text'
}

function capturedTextTitle(content: string, kind: ClipKind): string {
  const compact = content.trim()
  if (kind === 'link') {
    try {
      const url = new URL(compact)
      return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 42)
    } catch {
      return compact.slice(0, 42)
    }
  }

  const firstLine = compact.split(/\r?\n/).find(Boolean) ?? ''
  return firstLine.slice(0, 36) || (kind === 'code' ? '代码片段' : '文本片段')
}

function capturedFormats(payload: CapturedClipboardPayload, kind: ClipKind): ClipboardFormat[] {
  if (kind === 'file') return ['files']
  if (kind === 'image') return ['image']

  return [
    'text',
    ...(typeof payload.html === 'string' ? ['html' as const] : []),
    ...(typeof payload.rtfBase64 === 'string' ? ['rtf' as const] : []),
  ]
}

export function createClipboardItem(
  payload: CapturedClipboardPayload,
  id = `captured-${Date.now()}`,
): LoadedClipboardItem {
  const sourceAppIcon = normalizeSourceAppIcon(payload.sourceAppIcon)
  if (payload.kind === 'image') {
    if (!isValidImageHash(payload.imageHash)) throw new Error('图片捕获缺少有效哈希')
    const formats = capturedFormats(payload, 'image')
    const omittedFormats = normalizeCapturedOmittedFormats(payload.omittedFormats, formats)
    const dimensions = payload.width && payload.height ? `${payload.width} × ${payload.height}` : undefined
    const sourceApp = payload.sourceApp || 'Windows 剪贴板'
    const title = dimensions ? `剪贴板图片 · ${dimensions}` : '剪贴板图片'
    const content = dimensions ? `来自系统剪贴板的图片，尺寸 ${dimensions}` : '来自系统剪贴板的图片'
    const item: LoadedClipboardItem = {
      id,
      kind: 'image',
      title,
      content,
      sourceApp,
      copiedAt: payload.capturedAt,
      pinned: false,
      searchTerms: ['windows', 'clipboard', 'image', 'tupian', ...pinyinSearchTerms([title, content, sourceApp])],
      imageUrl: payload.content,
      imageHash: payload.imageHash,
      ocrStatus: 'pending',
      dimensions,
      color: '#B06E4F',
      formats,
      ...(omittedFormats ? { omittedFormats } : {}),
    }
    if (sourceAppIcon) item.sourceAppIcon = sourceAppIcon
    return item
  }

  if (payload.kind === 'file') {
    const files = payload.files ?? []
    if (files.length === 0) throw new Error('文件剪贴板记录不能为空')
    const sourceApp = payload.sourceApp || 'Windows 剪贴板'
    const formats = capturedFormats(payload, 'file')
    const omittedFormats = normalizeCapturedOmittedFormats(payload.omittedFormats, formats)
    const item: LoadedClipboardItem = {
      id,
      kind: 'file',
      title: files.length === 1 ? files[0].name : `${files.length} 个文件`,
      content: files.map((file) => file.path).join('\n'),
      sourceApp,
      copiedAt: payload.capturedAt,
      pinned: false,
      searchTerms: ['windows', 'clipboard', 'files', ...pinyinSearchTerms([sourceApp, ...files.map((file) => file.name)])],
      files,
      formats,
      ...(omittedFormats ? { omittedFormats } : {}),
      color: '#80684A',
    }
    if (sourceAppIcon) item.sourceAppIcon = sourceAppIcon
    return item
  }

  const kind = classifyCapturedText(payload.content)
  const title = capturedTextTitle(payload.content, kind)
  const sourceApp = payload.sourceApp || 'Windows 剪贴板'
  const colors: Record<Exclude<ClipKind, 'image' | 'file'>, string> = {
    text: '#337C74',
    code: '#3A648E',
    link: '#5276A7',
  }
  const item: LoadedClipboardItem = {
    id,
    kind,
    title,
    content: payload.content,
    sourceApp,
    copiedAt: payload.capturedAt,
    pinned: false,
    searchTerms: ['windows', 'clipboard', ...pinyinSearchTerms([title, payload.content, sourceApp])],
    color: colors[kind],
    formats: capturedFormats(payload, kind),
  }
  const omittedFormats = normalizeCapturedOmittedFormats(payload.omittedFormats, item.formats ?? ['text'])
  if (omittedFormats) item.omittedFormats = omittedFormats
  if (typeof payload.html === 'string') item.html = payload.html
  if (typeof payload.rtfBase64 === 'string') item.rtfBase64 = payload.rtfBase64
  if (sourceAppIcon) item.sourceAppIcon = sourceAppIcon
  return item
}

export function mergeCapturedClip(items: ClipboardItem[], incoming: ClipboardItem): ClipboardItem[] {
  const isSameContent = (clip: ClipboardItem) => clip.kind === incoming.kind
    && clipContentIdentity(clip) === clipContentIdentity(incoming)
  const previous = items.find(isSameContent)

  // 永久片段的 id、正文和原始时间是可编辑对象的稳定身份；重复捕获只把它移到前面。
  if (previous?.permanent === true) {
    return [previous, ...items.filter((clip) => clip !== previous)]
  }

  const mergedIncoming = {
    ...incoming,
    pinned: previous?.pinned ?? incoming.pinned,
    permanent: previous?.permanent ?? incoming.permanent,
    collectionId: previous?.collectionId ?? incoming.collectionId,
  }
  if (incoming.kind === 'image'
    && incoming.imageHash
    && previous?.kind === 'image'
    && previous.imageHash === incoming.imageHash
    && previous.ocrStatus !== undefined
    && ['completed', 'unavailable', 'oversized'].includes(previous.ocrStatus)) {
    const completedPayloadAvailable = previous.ocrStatus !== 'completed'
      || (previous.payloadLoaded !== false && typeof previous.ocrText === 'string')
    if (completedPayloadAvailable) {
      mergedIncoming.ocrStatus = previous.ocrStatus
      if (previous.ocrText !== undefined) mergedIncoming.ocrText = previous.ocrText
      else delete mergedIncoming.ocrText
    }
  }
  if (!mergedIncoming.sourceAppIcon) {
    delete mergedIncoming.sourceAppIcon
    if (previous?.sourceApp === incoming.sourceApp && previous.sourceAppIcon) {
      mergedIncoming.sourceAppIcon = previous.sourceAppIcon
    }
  }

  return [
    mergedIncoming,
    ...items.filter((clip) => !isSameContent(clip)),
  ]
}

function clipContentIdentity(clip: ClipboardItem): string {
  const omittedFormats = sortClipboardFormats(clip.omittedFormats ?? [])
  if (clip.kind === 'image') return JSON.stringify({
    image: clip.imageHash ? { hash: clip.imageHash } : { payload: clip.imageUrl ?? clip.content },
    omittedFormats,
  })
  if (clip.kind === 'file') return JSON.stringify({
    files: (clip.files ?? []).map((file) => [file.path, file.directory]),
    omittedFormats,
  })

  const formats = (clip.formats ?? ['text']).filter((format) => format === 'html' || format === 'rtf').sort()
  return JSON.stringify({
    content: clip.content,
    formats,
    html: formats.includes('html') ? clip.html ?? '' : '',
    rtfBase64: formats.includes('rtf') ? clip.rtfBase64 ?? '' : '',
    omittedFormats,
  })
}

function isProtectedHistoryClip(clip: ClipboardItem): boolean {
  return clip.pinned || clip.permanent === true
}

export function pruneExpiredClips(
  items: ClipboardItem[],
  retention: RetentionPeriod,
  now = new Date(),
): ClipboardItem[] {
  const cutoff = now.getTime() - Number(retention) * 86_400_000

  return items.filter((clip) => {
    if (isProtectedHistoryClip(clip)) return true
    const timestamp = new Date(clip.copiedAt).getTime()
    if (Number.isNaN(timestamp)) return false
    return retention === 'forever' || timestamp >= cutoff
  })
}

export function limitHistory(items: ClipboardItem[], maximum: number): ClipboardItem[] {
  if (maximum <= 0) return items.filter(isProtectedHistoryClip)
  let ordinarySlots = maximum
  return items.filter((clip) => {
    if (isProtectedHistoryClip(clip)) return true
    if (ordinarySlots <= 0) return false
    ordinarySlots -= 1
    return true
  })
}

export function mergeCapturedClipIntoHistory(
  items: ClipboardItem[],
  incoming: ClipboardItem,
  retention: RetentionPeriod,
  maximum: number,
  now = new Date(),
): ClipboardItem[] {
  return limitHistory(
    pruneExpiredClips(mergeCapturedClip(items, incoming), retention, now),
    maximum,
  )
}

export function removeClip(items: ClipboardItem[], id: string): RemoveClipResult {
  const index = items.findIndex((clip) => clip.id === id)
  if (index < 0) return { items, undo: null }

  return {
    items: [...items.slice(0, index), ...items.slice(index + 1)],
    undo: { clip: items[index], index },
  }
}

export function clearUnpinnedHistory(items: ClipboardItem[]): ClearHistoryResult {
  const remaining = items.filter(isProtectedHistoryClip)
  return {
    items: remaining,
    removedCount: items.length - remaining.length,
  }
}

export function restoreClip(items: ClipboardItem[], removed: RemovedClip | null): ClipboardItem[] {
  if (!removed || items.some((clip) => clip.id === removed.clip.id)) return items

  const index = Math.min(Math.max(removed.index, 0), items.length)
  return [...items.slice(0, index), removed.clip, ...items.slice(index)]
}

export function moveSelection(current: number, delta: number, itemCount: number): number {
  if (itemCount <= 0) return -1
  const safeCurrent = current < 0 ? 0 : current
  return Math.min(Math.max(safeCurrent + delta, 0), itemCount - 1)
}

export function formatRelativeTime(
  value: string,
  now = new Date(),
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): string {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return locale === 'en-US' ? 'Unknown time' : '未知时间'
  }
  const differenceMs = Math.max(0, now.getTime() - timestamp.getTime())
  const minutes = Math.floor(differenceMs / 60_000)
  const hours = Math.floor(differenceMs / 3_600_000)
  const days = Math.floor(differenceMs / 86_400_000)

  if (locale === 'en-US') {
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
    if (days === 1) return 'Yesterday'
    if (days < 7) return `${days} days ago`
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(timestamp)
  }

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`

  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(timestamp)
}
