import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkCandidatePaths,
  checkMarkdownLinks,
  extractLocalMarkdownLinks,
} from './check-repository.mjs'

test('extractLocalMarkdownLinks only returns portable repository links', () => {
  const markdown = [
    '[开发说明](CONTRIBUTING.md)',
    '![架构图](docs/architecture.png)',
    '[站点](https://example.com)',
    '[章节](#quality-gate)',
    '[邮件](mailto:security@example.com)',
  ].join('\n')

  assert.deepEqual(extractLocalMarkdownLinks(markdown), [
    { target: 'CONTRIBUTING.md', line: 1 },
    { target: 'docs/architecture.png', line: 2 },
  ])
})

test('checkMarkdownLinks reports broken and machine-specific links', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quickpaste-docs-'))
  context.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'README.md'), [
    '[有效](docs/setup.md)',
    '[丢失](docs/missing.md)',
    '[本机路径](C:/Users/example/private.md)',
  ].join('\n'))
  await writeFile(join(root, 'docs', 'setup.md'), '# Setup\n')

  assert.deepEqual(await checkMarkdownLinks(root, ['README.md']), [
    'README.md:2 链接目标不存在：docs/missing.md',
    'README.md:3 使用了本机绝对路径：C:/Users/example/private.md',
  ])
})

test('checkCandidatePaths rejects generated, sensitive and oversized files', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quickpaste-files-'))
  context.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n')
  await writeFile(join(root, 'large.bin'), Buffer.alloc(32))

  assert.deepEqual(await checkCandidatePaths(root, [
    'src/main.ts',
    'dist/app.js',
    '.vite/cache.bin',
    'src-tauri/gen/schemas/app.json',
    'test-results/report.json',
    '.env.local',
    'src/.env.production',
    'signing/private.pfx',
    'signing/private.pvk',
    'data/history.sqlite3-wal',
    'data/history.sqlite3-shm',
    'data/history.sqlite3-journal',
    'large.bin',
  ], 16), [
    'dist/app.js 属于生成文件或本地工作目录',
    '.vite/cache.bin 属于生成文件或本地工作目录',
    'src-tauri/gen/schemas/app.json 属于生成文件或本地工作目录',
    'test-results/report.json 属于生成文件或本地工作目录',
    '.env.local 可能包含本地配置或敏感信息',
    'src/.env.production 可能包含本地配置或敏感信息',
    'signing/private.pfx 可能包含本地配置或敏感信息',
    'signing/private.pvk 可能包含本地配置或敏感信息',
    'data/history.sqlite3-wal 可能包含本地配置或敏感信息',
    'data/history.sqlite3-shm 可能包含本地配置或敏感信息',
    'data/history.sqlite3-journal 可能包含本地配置或敏感信息',
    'large.bin 超过仓库单文件上限 16 B（当前 32 B）',
  ])
})
