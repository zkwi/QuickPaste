export type CodePreviewLanguage =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'powershell'
  | 'python'
  | 'rust'
  | 'sql'
  | 'css'
  | 'xml'
  | 'bash'

const LANGUAGE_HINTS: Readonly<Record<string, CodePreviewLanguage>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  json: 'json',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  powershell: 'powershell',
  py: 'python',
  pyw: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  sql: 'sql',
  css: 'css',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  sh: 'bash',
  bash: 'bash',
}

function languageFromHint(value: string): CodePreviewLanguage | undefined {
  return LANGUAGE_HINTS[value.trim().toLowerCase()]
}

function languageFromTitle(title: string): CodePreviewLanguage | undefined {
  const match = title.trim().match(/\.([a-z0-9]+)(?:\s|$)/i)
  return match ? languageFromHint(match[1] ?? '') : undefined
}

function languageFromFence(code: string): CodePreviewLanguage | undefined {
  const match = code.match(/^\s*```\s*([a-z0-9]+)/i)
  return match ? languageFromHint(match[1] ?? '') : undefined
}

function isJsonContainer(code: string): boolean {
  if (!code.startsWith('{') && !code.startsWith('[')) return false
  try {
    const parsed: unknown = JSON.parse(code)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

/**
 * 只识别固定白名单中的高置信度片段；模糊内容保持纯文本，避免自动高亮误判。
 */
export function inferCodeLanguage(title: string, content: string): CodePreviewLanguage | undefined {
  const titleLanguage = languageFromTitle(title)
  if (titleLanguage) return titleLanguage

  const code = content.trim()
  if (!code) return undefined

  const fencedLanguage = languageFromFence(code)
  if (fencedLanguage) return fencedLanguage
  if (isJsonContainer(code)) return 'json'

  if (/^\s*(?:<\?xml\b|<!doctype\s+html\b|<[a-z][\w:-]*(?:\s+[^<>]*?)?\s*\/?>)/i.test(code)) {
    return 'xml'
  }
  if (/(?:^|\n)\s*(?:[@.#][\w-][^{]*|[a-z][\w-]*(?:\s+[.#][\w-]+)*)\s*\{[^{}]*[\w-]+\s*:[^{}]+\}/i.test(code)) {
    return 'css'
  }
  if (/(?:^|\n)\s*(?:param\s*\(|\$[a-z_]\w*\s*=.*\b(?:Get|Set|New|Remove|Invoke|Start|Stop)-[a-z]|(?:Get|Set|New|Remove|Invoke|Start|Stop|Where|ForEach)-[a-z])/i.test(code)) {
    return 'powershell'
  }
  if (/(?:^|\n)\s*(?:def\s+[a-z_]\w*\s*\([^)]*\)\s*:|class\s+[a-z_]\w*(?:\([^)]*\))?\s*:|from\s+[\w.]+\s+import\s+|import\s+[a-z_]\w*|if\s+__name__\s*==)/i.test(code)) {
    return 'python'
  }
  if (/(?:^|\n)\s*(?:fn\s+main\s*\(|use\s+std::|(?:pub\s+)?fn\s+[a-z_]\w*\s*\([^)]*\)[^{]*\{|let\s+mut\s+|impl(?:<[^>]+>)?\s+\w+\s*\{|println!\s*\()/i.test(code)) {
    return 'rust'
  }
  if (/^\s*(?:select\b[\s\S]*\bfrom\b|insert\s+into\b|update\b[\s\S]*\bset\b|delete\s+from\b|create\s+(?:table|index|view)\b|alter\s+table\b|with\b[\s\S]*\bselect\b)/i.test(code)) {
    return 'sql'
  }
  if (/(?:\b(?:interface|type|enum|namespace)\s+[a-z_$]\w*|\bimport\s+type\b|\b(?:const|let|var)\s+[a-z_$]\w*\s*:\s*[^=\n]+\s*=|\bfunction\s+[a-z_$]\w*\s*\([^)]*:\s*[^)]*\))/i.test(code)) {
    return 'typescript'
  }
  if (/(?:^|\n)\s*(?:const|let|var)\s+[a-z_$]\w*\s*=|\bfunction\s+[a-z_$]\w*\s*\(|=>|\bconsole\.(?:log|warn|error)\s*\(|\bexport\s+(?:default|const|function|class)\b/i.test(code)) {
    return 'javascript'
  }
  if (/^#![^\n]*\b(?:ba)?sh\b|(?:^|\n)\s*(?:set\s+-e|export\s+[A-Z_]\w*=|if\s+\[|for\s+\w+\s+in\s+|echo\s+\$)/i.test(code)) {
    return 'bash'
  }
  return undefined
}
