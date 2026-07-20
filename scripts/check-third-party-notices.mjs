import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

function fail(message) {
  throw new Error(`第三方声明检查失败：${message}`)
}

function runNpmList() {
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ls --omit=dev --all --parseable'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
  }
  return execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' })
}

function parseComponentRows(markdown) {
  const rows = new Set()
  for (const line of markdown.split(/\r?\n/u)) {
    const match = line.match(/^\| \[([^\]]+)\]\([^)]+\) \| ([^|]+?) \|/u)
    if (match) rows.add(`${match[1]}@${match[2].trim()}`)
  }
  return rows
}

function assertSameSet(label, expected, actual) {
  const missing = [...expected].filter(value => !actual.has(value))
  const extra = [...actual].filter(value => !expected.has(value))
  if (missing.length || extra.length) {
    fail(`${label} 与锁定依赖不一致；missing=${missing.join(', ') || '-'}；extra=${extra.join(', ') || '-'}`)
  }
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex').toUpperCase()
}

function assertCanonicalText(filename, contents) {
  if (contents.includes('\r') || /[ \t]+$/mu.test(contents) || !contents.endsWith('\n') || contents.endsWith('\n\n')) {
    fail(`${filename} 必须使用 LF、无行尾空格且只有一个末尾换行`)
  }
}

const npmExpected = new Set()
const rootPath = await realpath(root)
for (const listedPath of runNpmList().split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
  const packagePath = await realpath(listedPath)
  if (packagePath === rootPath) continue
  const pkg = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'))
  npmExpected.add(`${pkg.name}@${pkg.version}`)
}

const npmNotices = await readFile(path.join(root, 'THIRD_PARTY_LICENSES_NPM.md'), 'utf8')
assertCanonicalText('THIRD_PARTY_LICENSES_NPM.md', npmNotices)
assertSameSet('npm notices', npmExpected, parseComponentRows(npmNotices))

const cargoTree = execFileSync('cargo', [
  'tree', '--locked',
  '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'),
  '--target', 'x86_64-pc-windows-msvc',
  '--edges', 'normal,build',
  '--prefix', 'none',
  '--format', '{p}',
], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })

const rustExpected = new Set()
for (const line of cargoTree.split(/\r?\n/u)) {
  const match = line.match(/^(.+) v([^ ]+)/u)
  if (!match || match[1] === 'quickpaste') continue
  rustExpected.add(`${match[1]}@${match[2]}`)
}
const rustNotices = await readFile(path.join(root, 'THIRD_PARTY_LICENSES_RUST.md'), 'utf8')
assertCanonicalText('THIRD_PARTY_LICENSES_RUST.md', rustNotices)
assertSameSet('Rust notices', rustExpected, parseComponentRows(rustNotices))

const summary = await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
const npmLockHash = await sha256(path.join(root, 'package-lock.json'))
const cargoLockHash = await sha256(path.join(root, 'src-tauri', 'Cargo.lock'))
if (!summary.includes(npmLockHash) || !summary.includes(cargoLockHash)) fail('锁文件 SHA-256 未同步到 THIRD_PARTY_NOTICES.md')

for (const filename of ['THIRD_PARTY_LICENSES_NPM.md', 'THIRD_PARTY_LICENSES_RUST.md', 'THIRD_PARTY_LICENSES_NATIVE.md']) {
  if (!summary.includes(filename)) fail(`总声明没有引用 ${filename}`)
}

const nativeNotices = await readFile(path.join(root, 'THIRD_PARTY_LICENSES_NATIVE.md'), 'utf8')
assertCanonicalText('THIRD_PARTY_LICENSES_NATIVE.md', nativeNotices)
if (!nativeNotices.includes('NSIS 3.11') || !nativeNotices.includes('SQLite 3.50.2')) fail('NSIS/SQLite 版本声明不完整')

const tauriConfig = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const resources = Object.keys(tauriConfig.bundle?.resources || {})
for (const filename of ['../THIRD_PARTY_NOTICES.md', '../THIRD_PARTY_LICENSES_NPM.md', '../THIRD_PARTY_LICENSES_RUST.md', '../THIRD_PARTY_LICENSES_NATIVE.md']) {
  if (!resources.includes(filename)) fail(`Tauri bundle resources 缺少 ${filename}`)
}

console.log(`第三方声明检查通过：npm ${npmExpected.size} 个包，Rust ${rustExpected.size} 个 crate，NSIS/SQLite 已覆盖。`)
