import { execFileSync } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const GENERATED_PATH = /(^|\/)(node_modules|dist|target|output|coverage|\.vite|\.playwright-cli|\.playwright-mcp|test-results|playwright-report|gen\/schemas)(\/|$)/i
const SENSITIVE_FILE = /(^|\/)(\.env(?:\..+)?|[^/]+\.(?:pfx|p12|pvk|pem|key|log)|[^/]+\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?)$/i
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i
const UNC_PATH = /^(?:\\\\|\/\/)/

function displayBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function normalizeRepositoryPath(file) {
  return file.replaceAll('\\', '/')
}

function markdownTarget(rawTarget) {
  const trimmed = rawTarget.trim()
  if (trimmed.startsWith('<')) {
    const closing = trimmed.indexOf('>')
    return closing > 0 ? trimmed.slice(1, closing) : trimmed
  }
  return trimmed.split(/\s+(?=["'])/, 1)[0]
}

export function extractLocalMarkdownLinks(markdown) {
  const links = []
  const pattern = /!?\[[^\]]*\]\(([^)\n]+)\)/g
  for (const match of markdown.matchAll(pattern)) {
    const target = markdownTarget(match[1])
    if (!target || target.startsWith('#')) continue
    if (!WINDOWS_ABSOLUTE_PATH.test(target) && !UNC_PATH.test(target) && /^[a-z][a-z\d+.-]*:/i.test(target)) {
      continue
    }
    const line = markdown.slice(0, match.index).split('\n').length
    links.push({ target, line })
  }
  return links
}

export async function checkMarkdownLinks(root, markdownFiles) {
  const issues = []
  const repositoryRoot = resolve(root)

  for (const sourceFile of markdownFiles) {
    const sourcePath = resolve(repositoryRoot, sourceFile)
    const markdown = await readFile(sourcePath, 'utf8')
    for (const { target, line } of extractLocalMarkdownLinks(markdown)) {
      if (WINDOWS_ABSOLUTE_PATH.test(target) || UNC_PATH.test(target)) {
        issues.push(`${normalizeRepositoryPath(sourceFile)}:${line} 使用了本机绝对路径：${target}`)
        continue
      }

      const withoutFragment = target.split(/[?#]/, 1)[0]
      let decodedTarget
      try {
        decodedTarget = decodeURIComponent(withoutFragment)
      } catch {
        issues.push(`${normalizeRepositoryPath(sourceFile)}:${line} 链接包含无效编码：${target}`)
        continue
      }

      const targetPath = isAbsolute(decodedTarget)
        ? resolve(repositoryRoot, `.${decodedTarget}`)
        : resolve(dirname(sourcePath), decodedTarget)
      const targetRelativePath = relative(repositoryRoot, targetPath)
      if (targetRelativePath === '..' || targetRelativePath.startsWith(`..${sep}`)) {
        issues.push(`${normalizeRepositoryPath(sourceFile)}:${line} 链接超出仓库范围：${target}`)
        continue
      }

      try {
        await access(targetPath)
      } catch {
        issues.push(`${normalizeRepositoryPath(sourceFile)}:${line} 链接目标不存在：${target}`)
      }
    }
  }

  return issues
}

export async function checkCandidatePaths(root, files, maximumBytes = DEFAULT_MAX_FILE_BYTES) {
  const issues = []
  for (const file of files) {
    const repositoryPath = normalizeRepositoryPath(file)
    if (GENERATED_PATH.test(repositoryPath)) {
      issues.push(`${repositoryPath} 属于生成文件或本地工作目录`)
      continue
    }
    if (SENSITIVE_FILE.test(repositoryPath) && !/(^|\/)\.env\.example$/i.test(repositoryPath)) {
      issues.push(`${repositoryPath} 可能包含本地配置或敏感信息`)
      continue
    }

    try {
      const fileStat = await stat(resolve(root, file))
      if (fileStat.isFile() && fileStat.size > maximumBytes) {
        issues.push(`${repositoryPath} 超过仓库单文件上限 ${displayBytes(maximumBytes)}（当前 ${displayBytes(fileStat.size)}）`)
      }
    } catch {
      issues.push(`${repositoryPath} 无法读取或已不存在`)
    }
  }
  return issues
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
  const markdownFiles = files.filter((file) => file.toLowerCase().endsWith('.md'))
  const issues = [
    ...await checkCandidatePaths(root, files),
    ...await checkMarkdownLinks(root, markdownFiles),
  ]

  if (issues.length > 0) {
    console.error('仓库质量检查失败：')
    for (const issue of issues) console.error(`- ${issue}`)
    process.exitCode = 1
    return
  }

  console.log(`仓库质量检查通过：${files.length} 个候选文件，${markdownFiles.length} 个 Markdown 文档。`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()
