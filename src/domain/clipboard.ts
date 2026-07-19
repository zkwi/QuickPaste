import { pinyin } from 'pinyin-pro'

export type ClipKind = 'text' | 'code' | 'link' | 'image'
export type ClipKindFilter = 'all' | 'pinned' | ClipKind
export type RetentionPeriod = '7' | '30' | '90' | 'forever'

export interface ClipboardItem {
  id: string
  kind: ClipKind
  title: string
  content: string
  sourceApp: string
  sourceAppIcon?: string
  copiedAt: string
  pinned: boolean
  searchTerms: string[]
  imageUrl?: string
  dimensions?: string
  color?: string
}

export interface CapturedClipboardPayload {
  kind: 'text' | 'image'
  content: string
  capturedAt: string
  sourceApp?: string
  sourceAppIcon?: string
  width?: number
  height?: number
}

const SOURCE_APP_ICON_PREFIX = 'data:image/png;base64,'
const MAX_SOURCE_APP_ICON_DATA_URL_LENGTH = 64 * 1024
const PINYIN_INDEX_MAX_CHARACTERS = 4096
const HAN_CHARACTER = /\p{Script=Han}/u

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

export function parseClipboardItems(value: unknown): ClipboardItem[] | null {
  if (!Array.isArray(value)) return null

  const parsedItems: ClipboardItem[] = []
  const ids = new Set<string>()
  for (const valueItem of value) {
    if (!isRecord(valueItem)) return null

    const { id, kind, title, content, sourceApp, copiedAt } = valueItem
    if (typeof id !== 'string' || !id || ids.has(id)) return null
    if (kind !== 'text' && kind !== 'code' && kind !== 'link' && kind !== 'image') return null
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

    const item: ClipboardItem = {
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
  ].join('\n'))
}

export function applyClipFilter(items: ClipboardItem[], filter: ClipFilter): ClipboardItem[] {
  const terms = normalizeSearchText(filter.query)
    .split(/\s+/)
    .filter(Boolean)

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

function classifyCapturedText(content: string): Exclude<ClipKind, 'image'> {
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

export function createClipboardItem(
  payload: CapturedClipboardPayload,
  id = `captured-${Date.now()}`,
): ClipboardItem {
  const sourceAppIcon = normalizeSourceAppIcon(payload.sourceAppIcon)
  if (payload.kind === 'image') {
    const dimensions = payload.width && payload.height ? `${payload.width} × ${payload.height}` : undefined
    const sourceApp = payload.sourceApp || 'Windows 剪贴板'
    const title = dimensions ? `剪贴板图片 · ${dimensions}` : '剪贴板图片'
    const content = dimensions ? `来自系统剪贴板的图片，尺寸 ${dimensions}` : '来自系统剪贴板的图片'
    const item: ClipboardItem = {
      id,
      kind: 'image',
      title,
      content,
      sourceApp,
      copiedAt: payload.capturedAt,
      pinned: false,
      searchTerms: ['windows', 'clipboard', 'image', 'tupian', ...pinyinSearchTerms([title, content, sourceApp])],
      imageUrl: payload.content,
      dimensions,
      color: '#B06E4F',
    }
    if (sourceAppIcon) item.sourceAppIcon = sourceAppIcon
    return item
  }

  const kind = classifyCapturedText(payload.content)
  const title = capturedTextTitle(payload.content, kind)
  const sourceApp = payload.sourceApp || 'Windows 剪贴板'
  const colors: Record<Exclude<ClipKind, 'image'>, string> = {
    text: '#337C74',
    code: '#3A648E',
    link: '#5276A7',
  }
  const item: ClipboardItem = {
    id,
    kind,
    title,
    content: payload.content,
    sourceApp,
    copiedAt: payload.capturedAt,
    pinned: false,
    searchTerms: ['windows', 'clipboard', ...pinyinSearchTerms([title, payload.content, sourceApp])],
    color: colors[kind],
  }
  if (sourceAppIcon) item.sourceAppIcon = sourceAppIcon
  return item
}

export function mergeCapturedClip(items: ClipboardItem[], incoming: ClipboardItem): ClipboardItem[] {
  const isSameContent = (clip: ClipboardItem) => incoming.kind === 'image'
    ? clip.kind === 'image' && clip.imageUrl === incoming.imageUrl
    : clip.kind !== 'image' && clip.content === incoming.content
  const previous = items.find(isSameContent)

  const mergedIncoming = {
    ...incoming,
    pinned: previous?.pinned ?? incoming.pinned,
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

export function pruneExpiredClips(
  items: ClipboardItem[],
  retention: RetentionPeriod,
  now = new Date(),
): ClipboardItem[] {
  const cutoff = now.getTime() - Number(retention) * 86_400_000

  return items.filter((clip) => {
    if (clip.pinned) return true
    const timestamp = new Date(clip.copiedAt).getTime()
    if (Number.isNaN(timestamp)) return false
    return retention === 'forever' || timestamp >= cutoff
  })
}

export function limitHistory(items: ClipboardItem[], maximum: number): ClipboardItem[] {
  if (maximum <= 0) return items.filter((clip) => clip.pinned)
  let ordinarySlots = maximum
  return items.filter((clip) => {
    if (clip.pinned) return true
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
  const remaining = items.filter((clip) => clip.pinned)
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
