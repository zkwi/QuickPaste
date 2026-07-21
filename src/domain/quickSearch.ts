export interface QuickSearchIntent {
  text: string
  permanent?: true
  sourceFragment?: string
  sourceApp?: string
}

function normalizedSource(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim()
}

export function parseQuickSearch(value: string, selectedSourceApp?: string): QuickSearchIntent {
  let text = value
  let permanent = false
  if (text.startsWith(';') || text.startsWith('；')) {
    permanent = true
    text = text.slice(1).trimStart()
  }

  const sourceApp = selectedSourceApp?.trim()
  if (!sourceApp && !permanent && text.startsWith('@')) {
    const prompt = text.slice(1)
    const separator = prompt.search(/\s/u)
    const sourceFragment = separator < 0 ? prompt : prompt.slice(0, separator)
    const remainingText = separator < 0 ? '' : prompt.slice(separator).trimStart()
    return { text: remainingText, sourceFragment }
  }

  return {
    text,
    ...(permanent ? { permanent: true as const } : {}),
    ...(sourceApp ? { sourceApp } : {}),
  }
}

export function suggestSourceApps(
  sourceApps: readonly string[],
  fragment: string,
  limit = 6,
): string[] {
  if (!Number.isInteger(limit) || limit < 1) return []
  const normalizedFragment = normalizedSource(fragment)
  const seen = new Set<string>()
  const candidates: Array<{ source: string; normalized: string; order: number }> = []

  for (const sourceApp of sourceApps) {
    const source = sourceApp.trim()
    const normalized = normalizedSource(source)
    if (!source || !normalized || seen.has(normalized)) continue
    seen.add(normalized)
    candidates.push({ source, normalized, order: candidates.length })
  }

  return candidates
    .filter(({ normalized }) => !normalizedFragment || normalized.includes(normalizedFragment))
    .sort((left, right) => {
      const leftPrefix = left.normalized.startsWith(normalizedFragment) ? 0 : 1
      const rightPrefix = right.normalized.startsWith(normalizedFragment) ? 0 : 1
      return leftPrefix - rightPrefix || left.order - right.order
    })
    .slice(0, limit)
    .map(({ source }) => source)
}
