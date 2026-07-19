import { normalizeSearchText } from './clipboard'

export interface HighlightSegment {
  text: string
  matched: boolean
}

export interface SearchHighlighter {
  readonly hasTerms: boolean
  segments: (text: string) => HighlightSegment[]
  preview: (text: string) => string
}

interface TextRange {
  start: number
  end: number
}

interface NormalizedText {
  normalized: string
  originalRanges: TextRange[] | null
}

const TEXT_CACHE_LIMIT = 2_048
const SEARCH_PREVIEW_CODE_POINTS = 96
const SEARCH_PREVIEW_CONTEXT_BEFORE = 28
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const normalizedTextCache = new Map<string, NormalizedText>()

function cacheNormalizedText(text: string, value: NormalizedText): NormalizedText {
  if (!normalizedTextCache.has(text) && normalizedTextCache.size >= TEXT_CACHE_LIMIT) {
    normalizedTextCache.clear()
  }
  normalizedTextCache.set(text, value)
  return value
}

function normalizedTextWithOffsets(text: string): NormalizedText {
  const cached = normalizedTextCache.get(text)
  if (cached) return cached

  const normalized = normalizeSearchText(text)
  if (text.normalize('NFKC') === text && normalized.length === text.length) {
    return cacheNormalizedText(text, { normalized, originalRanges: null })
  }

  const originalRanges: TextRange[] = []
  for (const part of graphemeSegmenter.segment(text)) {
    const normalizedPart = normalizeSearchText(part.segment)
    for (let index = 0; index < normalizedPart.length; index += 1) {
      originalRanges.push({ start: part.index, end: part.index + part.segment.length })
    }
  }
  return cacheNormalizedText(text, { normalized, originalRanges })
}

function lowerBound(values: number[], target: number): number {
  let left = 0
  let right = values.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (values[middle] < target) left = middle + 1
    else right = middle
  }
  return left
}

export function createSearchHighlighter(query: string): SearchHighlighter {
  const terms = [...new Set(
    normalizeSearchText(query)
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  )].sort((left, right) => right.length - left.length)
  const matchedRangeCache = new Map<string, TextRange[]>()
  const previewTextCache = new Map<string, string>()

  function cacheValue<Value>(cache: Map<string, Value>, text: string, value: Value): Value {
    if (!cache.has(text) && cache.size >= TEXT_CACHE_LIMIT) cache.clear()
    cache.set(text, value)
    return value
  }

  function matchingRanges(text: string): TextRange[] {
    if (!text || terms.length === 0) return []

    const cached = matchedRangeCache.get(text)
    if (cached) return cached

    const { normalized: searchable, originalRanges } = normalizedTextWithOffsets(text)
    const normalizedRanges: TextRange[] = []
    for (const term of terms) {
      let offset = 0
      while (offset < searchable.length) {
        const start = searchable.indexOf(term, offset)
        if (start < 0) break
        normalizedRanges.push({ start, end: start + term.length })
        offset = start + term.length
      }
    }

    if (normalizedRanges.length === 0) {
      return cacheValue(matchedRangeCache, text, [])
    }

    const ranges = normalizedRanges.flatMap<TextRange>((range) => {
      if (!originalRanges) return [{ start: range.start, end: range.end }]
      const first = originalRanges[range.start]
      const last = originalRanges[range.end - 1]
      return first && last ? [{ start: first.start, end: last.end }] : []
    })

    ranges.sort((left, right) => left.start - right.start || left.end - right.end)
    const merged = ranges.reduce<TextRange[]>((result, range) => {
      const previous = result.at(-1)
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end)
      } else {
        result.push({ ...range })
      }
      return result
    }, [])

    return cacheValue(matchedRangeCache, text, merged)
  }

  function segments(text: string): HighlightSegment[] {
    const ranges = matchingRanges(text)
    if (ranges.length === 0) return [{ text, matched: false }]

    const result: HighlightSegment[] = []
    let offset = 0
    for (const range of ranges) {
      if (range.start > offset) result.push({ text: text.slice(offset, range.start), matched: false })
      result.push({ text: text.slice(range.start, range.end), matched: true })
      offset = range.end
    }
    if (offset < text.length) result.push({ text: text.slice(offset), matched: false })
    return result
  }

  function preview(text: string): string {
    if (terms.length === 0) return text

    const cached = previewTextCache.get(text)
    if (cached) return cached

    const firstMatch = matchingRanges(text)[0]
    if (!firstMatch) return cacheValue(previewTextCache, text, text)

    const offsets = [0]
    for (const character of text) offsets.push(offsets.at(-1)! + character.length)

    const matchStart = lowerBound(offsets, firstMatch.start)
    const matchEnd = lowerBound(offsets, firstMatch.end)
    const matchLength = Math.max(1, matchEnd - matchStart)
    const windowSize = Math.max(SEARCH_PREVIEW_CODE_POINTS, matchLength + SEARCH_PREVIEW_CONTEXT_BEFORE * 2)
    if (offsets.length - 1 <= windowSize) return cacheValue(previewTextCache, text, text)

    let start = Math.max(0, matchStart - SEARCH_PREVIEW_CONTEXT_BEFORE)
    const end = Math.min(offsets.length - 1, Math.max(matchEnd, start + windowSize))
    if (end - start < windowSize) start = Math.max(0, end - windowSize)

    const result = `${start > 0 ? '…' : ''}${text.slice(offsets[start], offsets[end])}${end < offsets.length - 1 ? '…' : ''}`
    return cacheValue(previewTextCache, text, result)
  }

  return {
    hasTerms: terms.length > 0,
    segments,
    preview,
  }
}
