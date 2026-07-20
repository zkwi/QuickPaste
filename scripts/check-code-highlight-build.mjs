import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED_LANGUAGES = [
  'bash',
  'css',
  'javascript',
  'json',
  'powershell',
  'python',
  'rust',
  'sql',
  'typescript',
  'xml',
]

function normalized(value) {
  return String(value).replaceAll('\\', '/')
}

function staticClosure(manifest, entryKey) {
  const visited = new Set()
  const pending = [entryKey]
  while (pending.length > 0) {
    const key = pending.pop()
    if (!key || visited.has(key)) continue
    visited.add(key)
    for (const dependency of manifest[key]?.imports ?? []) pending.push(dependency)
  }
  return visited
}

export function validateCodeHighlightBuild(manifest, readAsset = () => '') {
  const errors = []
  const entries = Object.entries(manifest)
  const entry = entries.find(([, value]) => value?.isEntry)
  if (!entry) return ['manifest: missing application entry']
  const [entryKey, entryRecord] = entry
  const preview = entries.find(([key, value]) => (
    normalized(value?.src ?? key) === 'src/components/CodePreview.vue'
  ))
  if (!preview) return ['manifest: missing lazy CodePreview entry']
  const [previewKey, previewRecord] = preview

  const closure = staticClosure(manifest, entryKey)
  if (closure.has(previewKey)) errors.push('manifest: CodePreview entered the static application closure')
  for (const key of closure) {
    const source = normalized(manifest[key]?.src ?? key)
    if (source.includes('highlight.js/')) {
      errors.push(`manifest: highlight module entered static closure: ${source}`)
    }
  }
  if (!(entryRecord.dynamicImports ?? []).includes(previewKey)) {
    errors.push('manifest: application entry does not dynamically import CodePreview')
  }

  const previewClosure = staticClosure(manifest, previewKey)
  for (const key of previewClosure) {
    if (key === previewKey) continue
    const source = normalized(manifest[key]?.src ?? key)
    if (source.includes('highlight.js/')) {
      errors.push(`manifest: highlight module entered CodePreview static closure: ${source}`)
    }
  }
  const externalImportPattern = /(?:import\s*\(|from\s*)["'`](?:https?:)?\/\//i
  for (const key of previewClosure) {
    const source = normalized(manifest[key]?.src ?? key)
    const file = normalized(manifest[key]?.file ?? '')
    if (!file || /^(?:https?:)?\/\//i.test(file)) {
      errors.push(`manifest: non-local CodePreview closure chunk: ${source}`)
      continue
    }
    if (externalImportPattern.test(readAsset(file))) {
      errors.push(`manifest: external import in CodePreview closure chunk: ${source}`)
    }
  }

  const highlightImports = (previewRecord.dynamicImports ?? [])
    .map((key) => ({ key, source: normalized(manifest[key]?.src ?? key) }))
    .filter(({ source }) => source.includes('highlight.js/'))
  const allowedHighlightSources = new Set([
    'node_modules/highlight.js/es/core.js',
    'node_modules/highlight.js/lib/core.js',
    ...ALLOWED_LANGUAGES.flatMap((language) => [
      `node_modules/highlight.js/es/languages/${language}.js`,
      `node_modules/highlight.js/lib/languages/${language}.js`,
    ]),
  ])
  for (const { source } of highlightImports) {
    if (!allowedHighlightSources.has(source)) {
      errors.push(`manifest: forbidden highlight module: ${source}`)
    }
  }
  const emittedHighlightSources = entries
    .map(([key, value]) => normalized(value?.src ?? key))
    .filter((source) => source.includes('highlight.js/'))
  const dynamicHighlightSources = new Set(highlightImports.map(({ source }) => source))
  for (const source of emittedHighlightSources) {
    if (!dynamicHighlightSources.has(source)) {
      errors.push(`manifest: emitted highlight module is not a direct lazy preview import: ${source}`)
    }
  }
  const cores = highlightImports.filter(({ source }) => /\/highlight\.js\/(?:es|lib)\/core\.js$/.test(source))
  if (cores.length !== 1) errors.push(`manifest: expected one lazy highlight core, found ${cores.length}`)
  const languages = highlightImports
    .map(({ source }) => source.match(/\/highlight\.js\/(?:es|lib)\/languages\/([^/]+)\.js$/)?.[1])
    .filter(Boolean)
    .sort()
  if (JSON.stringify(languages) !== JSON.stringify(ALLOWED_LANGUAGES)) {
    errors.push(`manifest: unexpected lazy language set: ${languages.join(',')}`)
  }

  for (const { key, source } of highlightImports) {
    const file = normalized(manifest[key]?.file ?? '')
    if (!file || /^(?:https?:)?\/\//i.test(file)) {
      errors.push(`manifest: non-local highlight chunk: ${source}`)
      continue
    }
    const content = readAsset(file)
    if (externalImportPattern.test(content)) {
      errors.push(`manifest: external import in highlight chunk: ${source}`)
    }
  }
  return errors
}

function run() {
  const outputDirectory = resolve('dist')
  const manifestPath = resolve(outputDirectory, '.vite', 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('manifest: cannot read production Vite manifest')
  }
  const errors = validateCodeHighlightBuild(
    manifest,
    (file) => readFileSync(resolve(outputDirectory, file), 'utf8'),
  )
  if (errors.length > 0) throw new Error(errors.join('\n'))
  process.stdout.write('Code highlight build boundary passed.\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) run()
