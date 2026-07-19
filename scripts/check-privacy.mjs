import { execFileSync } from 'node:child_process'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const MAX_TEXT_SCAN_BYTES = 5 * 1024 * 1024
const GENERATED_PATH = /(^|\/)(node_modules|dist|target|build|out|coverage|bundle|artifacts?|test-results|playwright-report|\.vite|\.turbo)(\/|$)/i
const DATABASE_FILE = /(?:^|\/)[^/]+\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i
const CLIPBOARD_EXPORT = /(?:^|\/)(?:clipboard(?:[-_.]history)?|history)(?:[-_.][^/]*)?\.(?:json|csv|txt)$/i
const LOG_FILE = /(^|\/)logs?(\/|$)|\.log$/i
const RASTER_IMAGE = /\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i
const SAFE_RASTER_IMAGE = /^src-tauri\/icons\//i
const PUBLISHABLE_BINARY = /\.(?:exe|msi|msix|appx|dll|pdb|dmp|zip|7z|rar|tar|gz|js\.map)$/i
const PRIVATE_KEY_FILE = /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pfx|p12|pvk|pem|key))$/i
const ENVIRONMENT_FILE = /(^|\/)\.env(?:\..+)?$/i
const EMAIL_EXEMPT_FILE = /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|cargo\.lock|pnpm-lock\.yaml|yarn\.lock)$/i
const WINDOWS_USER_PATH = /(?:\b[a-z]:[\\/]+|\\\\[^\\/\s]+[\\/]+)users[\\/]+([^\\/\s"'`<>:]+)(?=[\\/])/gi
const EMAIL = /[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*\.[a-z]{2,63}\b/gi
const PRIVATE_KEY_MARKER = /-----BEGIN (?:(?:[A-Z0-9]+ )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i
const GENERIC_CREDENTIAL = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["'`]([^"'`\r\n]{16,})["'`]/i

const GENERIC_WINDOWS_USERS = new Set([
  'alice',
  'bob',
  'default',
  'default user',
  'example',
  'public',
  'user',
  'username',
  'your-name',
  'yourname',
])

const SECRET_PATTERNS = [
  {
    label: 'GitHub 访问令牌',
    pattern: /\b(?:gh[pousr]_[a-z\d_]{30,255}|github_pat_[a-z\d_]{20,255})\b/i,
  },
  {
    label: 'AWS 访问密钥',
    pattern: /\b(?:AKIA|ASIA)[A-Z\d]{16}\b/,
  },
  {
    label: 'OpenAI API 密钥',
    pattern: /\bsk-(?:proj-)?[a-z\d_-]{32,}\b/i,
  },
  {
    label: 'Slack 访问令牌',
    pattern: /\bxox[baprs]-[a-z\d-]{10,}\b/i,
  },
  {
    label: 'Google API 密钥',
    pattern: /\bAIza[a-z\d_-]{35}\b/i,
  },
  {
    label: 'npm 访问令牌',
    pattern: /\bnpm_[a-z\d]{32,}\b/i,
  },
  {
    label: 'Stripe 生产密钥',
    pattern: /\bsk_live_[a-z\d]{16,}\b/i,
  },
]

function normalizeRepositoryPath(file) {
  return file.replaceAll('\\', '/')
}

function isGenericWindowsUser(user) {
  const normalized = user.trim().toLowerCase()
  return GENERIC_WINDOWS_USERS.has(normalized)
    || normalized.includes('${')
    || normalized.includes('%')
    || normalized.startsWith('<')
}

function containsPersonalWindowsPath(line) {
  WINDOWS_USER_PATH.lastIndex = 0
  for (const match of line.matchAll(WINDOWS_USER_PATH)) {
    if (!isGenericWindowsUser(match[1])) return true
  }
  return false
}

function isAllowedEmail(address) {
  const normalized = address.toLowerCase()
  const separator = normalized.lastIndexOf('@')
  if (separator < 1) return true
  const local = normalized.slice(0, separator)
  const domain = normalized.slice(separator + 1)

  if (domain === 'users.noreply.github.com') return true
  if (local === 'noreply' && domain === 'github.com') return true
  if (local === 'git' && domain === 'github.com') return true
  if (/^\d+x\.(?:png|jpe?g|webp|gif|svg)$/.test(domain)) return true
  if (['example.com', 'example.org', 'example.net'].includes(domain)) return true
  if (domain.endsWith('.example') || domain.endsWith('.invalid') || domain.endsWith('.test')) return true
  return false
}

function containsPersonalEmail(line) {
  EMAIL.lastIndex = 0
  return [...line.matchAll(EMAIL)].some((match) => !isAllowedEmail(match[0]))
}

function isPlaceholderCredential(value) {
  const normalized = value.trim().toLowerCase()
  return normalized.length === 0
    || /(?:replace|example|placeholder|changeme|dummy|sample|not[-_ ]?real|your[-_]|process\.env|\$\{|<[^>]+>)/i.test(normalized)
    || /^x+$/i.test(normalized)
}

export function scanTextPrivacy(file, text) {
  const repositoryPath = normalizeRepositoryPath(file)
  const issues = []
  const skipEmailCheck = EMAIL_EXEMPT_FILE.test(repositoryPath)
  const lines = text.split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    const location = `${repositoryPath}:${index + 1}`
    if (containsPersonalWindowsPath(line)) {
      issues.push(`${location} 包含个人 Windows 用户目录`)
    }
    if (!skipEmailCheck && containsPersonalEmail(line)) {
      issues.push(`${location} 包含非 GitHub noreply 邮箱`)
    }
    if (PRIVATE_KEY_MARKER.test(line)) {
      issues.push(`${location} 包含私钥内容`)
    }

    let recognizedSecret = false
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (!pattern.test(line)) continue
      issues.push(`${location} 包含疑似 ${label}`)
      recognizedSecret = true
    }

    if (!recognizedSecret) {
      const credential = line.match(GENERIC_CREDENTIAL)?.[1]
      if (credential && !isPlaceholderCredential(credential)) {
        issues.push(`${location} 包含疑似硬编码凭据`)
      }
    }
  }

  return issues
}

export function scanCandidatePath(file) {
  const repositoryPath = normalizeRepositoryPath(file)
  if (GENERATED_PATH.test(repositoryPath)) {
    return [`${repositoryPath} 属于构建产物或本地工作目录`]
  }
  if (DATABASE_FILE.test(repositoryPath) || CLIPBOARD_EXPORT.test(repositoryPath)) {
    return [`${repositoryPath} 可能是剪贴板数据库或本地数据库`]
  }
  if (LOG_FILE.test(repositoryPath)) {
    return [`${repositoryPath} 可能是运行日志`]
  }
  if (RASTER_IMAGE.test(repositoryPath) && !SAFE_RASTER_IMAGE.test(repositoryPath)) {
    return [`${repositoryPath} 可能是用户截图`]
  }
  if (PUBLISHABLE_BINARY.test(repositoryPath)) {
    return [`${repositoryPath} 属于可执行文件或发布产物`]
  }
  if (PRIVATE_KEY_FILE.test(repositoryPath)) {
    return [`${repositoryPath} 可能包含私钥或签名证书`]
  }
  if (ENVIRONMENT_FILE.test(repositoryPath) && !/(^|\/)\.env\.example$/i.test(repositoryPath)) {
    return [`${repositoryPath} 可能包含本地环境配置`]
  }
  return []
}

async function isCurrentCandidate(root, file) {
  try {
    const fileStat = await lstat(resolve(root, file))
    return fileStat.isFile() || fileStat.isSymbolicLink()
  } catch {
    return false
  }
}

export async function listCandidateFiles(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
  const candidates = [...new Set(output.split('\0').filter(Boolean))]
  const existing = []
  for (const file of candidates) {
    if (await isCurrentCandidate(root, file)) existing.push(normalizeRepositoryPath(file))
  }
  return existing.sort((left, right) => left.localeCompare(right, 'en'))
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

export async function scanRepositoryPrivacy(root, candidateFiles) {
  const files = candidateFiles ?? await listCandidateFiles(root)
  const issues = []

  for (const file of files) {
    const repositoryPath = normalizeRepositoryPath(file)
    issues.push(...scanCandidatePath(repositoryPath))

    const absolutePath = resolve(root, file)
    let fileStat
    try {
      fileStat = await lstat(absolutePath)
    } catch {
      continue
    }

    if (fileStat.isSymbolicLink()) {
      const target = await readlink(absolutePath)
      issues.push(...scanTextPrivacy(repositoryPath, target))
      continue
    }
    if (!fileStat.isFile()) continue
    if (fileStat.size > MAX_TEXT_SCAN_BYTES) {
      issues.push(`${repositoryPath} 超过隐私内容扫描上限 5 MiB，需要人工复核`)
      continue
    }

    const text = decodeText(await readFile(absolutePath))
    if (text !== null) issues.push(...scanTextPrivacy(repositoryPath, text))
  }

  return issues
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const files = await listCandidateFiles(root)
  const issues = await scanRepositoryPrivacy(root, files)
  if (issues.length > 0) {
    console.error('公共仓库隐私检查失败：')
    for (const issue of issues) console.error(`- ${issue}`)
    process.exitCode = 1
    return
  }
  console.log(`公共仓库隐私检查通过：已扫描 ${files.length} 个候选文件。`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()
