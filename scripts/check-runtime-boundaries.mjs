import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const QUICK_MANAGER_CONTROLS = [
  'ManagerBulkToolbar',
  'SnippetEditor',
  'StorageManager',
  'manager-bulk-toolbar',
  'snippet-editor',
  'manager-collection-editor',
]

const NETWORK_CAPABILITIES = [
  ['fetch(', /\bfetch\s*\(/u],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/u],
  ['WebSocket', /\bWebSocket\b/u],
  ['reqwest', /\breqwest\b/u],
  ['ureq', /\bureq\b/u],
  ['hyper', /\bhyper\b/u],
  ['http://', /http:\/\//iu],
  ['https://', /https:\/\//iu],
]

const FORBIDDEN_DEPENDENCY = /(?:^|[/@_-])(?:ffmpeg|fluent-ffmpeg|tesseract|onnx|tensorflow|whisper|transformers|paddleocr)(?:$|[/@_.-])/iu
const FORBIDDEN_RESOURCE = /(?:^|[/\\])ffmpeg(?:\.exe)?$|\.(?:onnx|tflite|gguf|traineddata|mlmodelc?|ort)$/iu

export function extractQuickPanelTemplate(appSource) {
  const condition = appSource.indexOf("currentView === 'quick'")
  if (condition < 0) throw new Error('quick panel branch was not found')
  const start = appSource.lastIndexOf('<section', condition)
  const libraryCondition = appSource.indexOf('v-else key="library"', condition)
  const end = libraryCondition < 0 ? -1 : appSource.lastIndexOf('<section', libraryCondition)
  if (start < 0 || end <= start) throw new Error('quick panel boundary was not found')
  return appSource.slice(start, end)
}

export function scanQuickPanelBoundary(quickTemplate) {
  return QUICK_MANAGER_CONTROLS
    .filter((control) => quickTemplate.includes(control))
    .map((control) => `quick panel contains forbidden manager control: ${control}`)
}

export function scanLocalOnlyModule(file, source) {
  return NETWORK_CAPABILITIES
    .filter(([, pattern]) => pattern.test(source))
    .map(([label]) => `${file} contains forbidden network capability: ${label}`)
}

function packageNames(lockfile) {
  if (!lockfile || typeof lockfile !== 'object' || Array.isArray(lockfile)) return []
  const packages = lockfile.packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return []
  const names = new Set()
  for (const [path, value] of Object.entries(packages)) {
    if (path.startsWith('node_modules/')) names.add(path.slice('node_modules/'.length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const section of ['dependencies', 'optionalDependencies']) {
      const dependencies = value[section]
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
      Object.keys(dependencies).forEach((name) => names.add(name))
    }
  }
  return [...names]
}

export function scanForbiddenRuntimeDependencies(lockfile) {
  return packageNames(lockfile)
    .filter((name) => FORBIDDEN_DEPENDENCY.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => `forbidden bundled runtime dependency: ${name}`)
}

function collectResourcePaths(value, paths) {
  if (typeof value === 'string') {
    paths.push(value.replaceAll('\\', '/'))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectResourcePaths(entry, paths))
    return
  }
  if (!value || typeof value !== 'object') return
  Object.values(value).forEach((entry) => collectResourcePaths(entry, paths))
}

export function scanPackagedResources(tauriConfig) {
  const paths = []
  collectResourcePaths(tauriConfig?.bundle?.resources, paths)
  return [...new Set(paths)]
    .filter((path) => FORBIDDEN_RESOURCE.test(path))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((path) => `forbidden packaged runtime asset: ${path}`)
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function scanRuntimeBoundaries(root) {
  const issues = []
  const appSource = await readFile(resolve(root, 'src/App.vue'), 'utf8')
  issues.push(...scanQuickPanelBoundary(extractQuickPanelTemplate(appSource)))

  for (const file of [
    'src/platform/history.ts',
    'src/platform/ocr.ts',
    'src-tauri/src/history.rs',
    'src-tauri/src/ocr.rs',
    'src-tauri/src/clipboard_formats.rs',
  ]) {
    const source = await readOptional(resolve(root, file))
    if (source !== null) issues.push(...scanLocalOnlyModule(file, source))
  }

  const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
  const tauriConfig = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  issues.push(...scanForbiddenRuntimeDependencies(lockfile))
  issues.push(...scanPackagedResources(tauriConfig))
  return issues
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const issues = await scanRuntimeBoundaries(root)
  if (issues.length > 0) {
    console.error('运行时边界检查失败：')
    issues.forEach((issue) => console.error(`- ${issue}`))
    process.exitCode = 1
    return
  }
  console.log('运行时边界检查通过：快速面板、离线模块、依赖与打包资源均符合约束。')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()
