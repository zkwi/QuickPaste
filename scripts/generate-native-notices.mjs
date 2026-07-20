import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const target = 'x86_64-pc-windows-msvc'

function normalizeGeneratedText(value) {
  return `${value.replace(/\r\n?/gu, '\n').replace(/[ \t]+$/gmu, '').trimEnd()}\n`
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

const localAppData = process.env.LOCALAPPDATA
if (!localAppData) throw new Error('LOCALAPPDATA 不可用，无法定位 Tauri NSIS 工具缓存。')

const nsisRoot = path.join(localAppData, 'tauri', 'NSIS')
const nsisVersion = execFileSync(path.join(nsisRoot, 'makensis.exe'), ['/VERSION'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim().replace(/^v/u, '')
const nsisCopying = await readFile(path.join(nsisRoot, 'COPYING'), 'utf8')

const metadata = JSON.parse(execFileSync('cargo', [
  'metadata',
  '--locked',
  '--format-version', '1',
  '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'),
  '--filter-platform', target,
], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }))

const sqlitePackage = metadata.packages.find(pkg => pkg.name === 'libsqlite3-sys')
if (!sqlitePackage) throw new Error('Cargo 依赖图中缺少 libsqlite3-sys。')
const sqliteRoot = path.dirname(sqlitePackage.manifest_path)
const sqliteHeader = await readFile(path.join(sqliteRoot, 'sqlite3', 'sqlite3.h'), 'utf8')
const sqliteVersion = sqliteHeader.match(/^#define SQLITE_VERSION\s+"([^"]+)"/mu)?.[1]
const sqliteBlessing = sqliteHeader.match(/^\/\*[\s\S]*?\*\//u)?.[0]
if (!sqliteVersion || !sqliteBlessing) throw new Error('无法从 bundled SQLite 头文件读取版本或 public-domain blessing。')

const markdown = `# 原生安装与数据库第三方声明

本文件由 \`node scripts/generate-native-notices.mjs\` 从 Tauri 使用的本机 NSIS 工具缓存和 Cargo 锁定的 \`libsqlite3-sys\` bundled source 生成。

## NSIS ${nsisVersion}

QuickPaste 安装包由 NSIS ${nsisVersion} 生成，并使用其 LZMA 压缩模块。下面完整保留 NSIS 分发包的 \`COPYING\`，其中包括 zlib/libpng、bzip2、Common Public License 1.0 以及 LZMA special exception。QuickPaste 没有修改 NSIS 或其压缩模块。

上游：<https://nsis.sourceforge.io/>

<pre>
${escapeHtml(nsisCopying.trimEnd())}
</pre>

## SQLite ${sqliteVersion}

\`rusqlite\` 的 \`bundled\` feature 将 SQLite ${sqliteVersion} 编译进 QuickPaste。SQLite 上游将其源码置于 public domain；详情见 <https://www.sqlite.org/copyright.html>。

<pre>
${escapeHtml(sqliteBlessing)}
</pre>
`

await writeFile(path.join(root, 'THIRD_PARTY_LICENSES_NATIVE.md'), normalizeGeneratedText(markdown), 'utf8')
console.log(`原生第三方声明已生成：NSIS ${nsisVersion}，SQLite ${sqliteVersion}。`)
