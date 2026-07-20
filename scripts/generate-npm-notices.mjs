import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outputPath = path.join(root, 'THIRD_PARTY_LICENSES_NPM.md')
const lockPath = path.join(root, 'package-lock.json')

function runNpmList() {
  const command = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ls --omit=dev --all --parseable']]
    : ['npm', ['ls', '--omit=dev', '--all', '--parseable']]
  return execFileSync(command[0], command[1], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function normalizeRepository(repository, homepage) {
  const value = typeof repository === 'string' ? repository : repository?.url
  let candidate = value || homepage || ''
  candidate = candidate
    .replace(/^git\+/, '')
    .replace(/^git:\/\/github\.com\//u, 'https://github.com/')
    .replace(/^github:/u, 'https://github.com/')
    .replace(/\.git$/u, '')
    .replace(/#readme$/u, '')
  if (/^[\w.-]+\/[\w.-]+$/u.test(candidate)) candidate = `https://github.com/${candidate}`
  return candidate
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function escapeHtml(value) {
  return value
    .replace(/\r\n?/gu, '\n')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function normalizeGeneratedText(value) {
  return `${value.replace(/\r\n?/gu, '\n').replace(/[ \t]+$/gmu, '').trimEnd()}\n`
}

const listedPaths = runNpmList()
  .split(/\r?\n/u)
  .map(value => value.trim())
  .filter(Boolean)

const rootPath = await realpath(root)
const packagePaths = []
for (const listedPath of listedPaths) {
  const resolved = await realpath(listedPath)
  if (resolved !== rootPath) packagePaths.push(resolved)
}

const packages = []
for (const packagePath of [...new Set(packagePaths)]) {
  const packageJson = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'))
  const filenames = await readdir(packagePath)
  const licenseFiles = filenames
    .filter(filename => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.|$)/iu.test(filename))
    .sort((left, right) => left.localeCompare(right, 'en'))

  packages.push({
    name: packageJson.name,
    version: packageJson.version,
    license: Array.isArray(packageJson.license) ? packageJson.license.join(' OR ') : packageJson.license,
    repository: normalizeRepository(packageJson.repository, packageJson.homepage),
    licenseTexts: await Promise.all(licenseFiles.map(async filename => ({
      filename,
      text: await readFile(path.join(packagePath, filename), 'utf8'),
    }))),
  })
}

packages.sort((left, right) => left.name.localeCompare(right.name, 'en') || left.version.localeCompare(right.version, 'en'))

const lockHash = createHash('sha256').update(await readFile(lockPath)).digest('hex').toUpperCase()
const lines = [
  '# npm 第三方许可证',
  '',
  '本文件由 `node scripts/generate-npm-notices.mjs` 根据 `package-lock.json` 和已安装的 production dependency closure 生成。开发依赖不会进入 Vite/Tauri 运行时包，因此不在表内。',
  '',
  `锁文件 SHA-256：\`${lockHash}\`。`,
  '',
  '## 组件清单',
  '',
  '| 组件 | 版本 | SPDX 表达式 |',
  '| --- | --- | --- |',
]

for (const pkg of packages) {
  const label = pkg.repository ? `[${pkg.name}](${pkg.repository})` : pkg.name
  lines.push(`| ${label} | ${escapeCell(pkg.version)} | \`${escapeCell(pkg.license || '未声明')}\` |`)
}

lines.push('', '## 包内许可证原文', '')
for (const pkg of packages) {
  if (pkg.licenseTexts.length === 0) {
    lines.push(
      `### ${pkg.name} ${pkg.version}`,
      '',
      `该 npm 包声明为 \`${pkg.license || '未声明'}\`，但发布的 npm tarball 没有单独携带许可证文件。上游仓库：${pkg.repository || '未声明'}。对应标准许可证全文同时包含在随包分发的 \`THIRD_PARTY_LICENSES_RUST.md\` 中。`,
      '',
    )
    continue
  }

  for (const license of pkg.licenseTexts) {
    lines.push(
      '<details>',
      `<summary>${pkg.name} ${pkg.version} — ${license.filename}</summary>`,
      '',
      '<pre>',
      escapeHtml(license.text.trimEnd()),
      '</pre>',
      '',
      '</details>',
      '',
    )
  }
}

await writeFile(outputPath, normalizeGeneratedText(lines.join('\n')), 'utf8')
console.log(`npm 第三方许可证已生成：${packages.length} 个 production packages。`)
