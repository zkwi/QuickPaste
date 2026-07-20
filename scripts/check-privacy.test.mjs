import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  listCandidateFiles,
  scanCandidatePath,
  scanRepositoryPrivacy,
  scanTextPrivacy,
} from './check-privacy.mjs'

test('scanTextPrivacy reports personal paths, emails, private keys and common tokens', () => {
  const personalPath = ['C:', 'Users', 'real-person', 'secret.txt'].join('\\')
  const personalEmail = ['maintainer', 'personal-domain.dev'].join('@')
  const privateKeyHeader = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
  const githubToken = ['github', '_pat_', 'A'.repeat(32)].join('')
  const awsAccessKey = ['AKIA', 'B'.repeat(16)].join('')
  const openAiToken = ['sk', '-', 'C'.repeat(40)].join('')
  const slackToken = ['xoxb', '-', 'D'.repeat(16)].join('')
  const googleApiKey = ['AIza', 'E'.repeat(35)].join('')
  const npmToken = ['npm', '_', 'F'.repeat(36)].join('')
  const stripeKey = ['sk', '_live_', 'G'.repeat(24)].join('')
  const hardcodedCredential = `api_key = "${'Ab9_'.repeat(8)}"`
  const text = [
    personalPath,
    personalEmail,
    privateKeyHeader,
    githubToken,
    awsAccessKey,
    openAiToken,
    slackToken,
    googleApiKey,
    npmToken,
    stripeKey,
    hardcodedCredential,
  ].join('\n')

  assert.deepEqual(scanTextPrivacy('src/config.ts', text), [
    'src/config.ts:1 包含个人 Windows 用户目录',
    'src/config.ts:2 包含非 GitHub noreply 邮箱',
    'src/config.ts:3 包含私钥内容',
    'src/config.ts:4 包含疑似 GitHub 访问令牌',
    'src/config.ts:5 包含疑似 AWS 访问密钥',
    'src/config.ts:6 包含疑似 OpenAI API 密钥',
    'src/config.ts:7 包含疑似 Slack 访问令牌',
    'src/config.ts:8 包含疑似 Google API 密钥',
    'src/config.ts:9 包含疑似 npm 访问令牌',
    'src/config.ts:10 包含疑似 Stripe 生产密钥',
    'src/config.ts:11 包含疑似硬编码凭据',
  ])
})

test('scanTextPrivacy allows documentation examples, GitHub URLs and noreply identities', () => {
  const text = [
    ['C:', 'Users', 'example', 'project'].join('/'),
    ['security', 'example.com'].join('@'),
    ['13426573+zkwi', 'users.noreply.github.com'].join('@'),
    'git' + '@' + 'github.com:zkwi/QuickPaste.git',
    'https://github.com/zkwi/QuickPaste/releases/latest',
    'packageManager = npm' + '@' + '11.9.0',
    'icons/128x128' + '@' + '2x.png',
    'api_key = "replace_with_your_api_key"',
  ].join('\n')

  assert.deepEqual(scanTextPrivacy('README.md', text), [])
  assert.deepEqual(
    scanTextPrivacy('package-lock.json', ['dependency-owner', 'vendor.dev'].join('@')),
    [],
  )
  assert.deepEqual(
    scanTextPrivacy('THIRD_PARTY_LICENSES_RUST.md', ['upstream-author', 'project.dev'].join('@')),
    [],
  )
})

test('scanCandidatePath rejects local data, screenshots and generated artifacts', () => {
  assert.deepEqual([
    ...scanCandidatePath('data/history.sqlite3-wal'),
    ...scanCandidatePath('logs/quickpaste.log'),
    ...scanCandidatePath('screenshots/private-window.png'),
    ...scanCandidatePath('dist/assets/app.js'),
    ...scanCandidatePath('release/QuickPaste.exe'),
    ...scanCandidatePath('signing/private.pfx'),
  ], [
    'data/history.sqlite3-wal 可能是剪贴板数据库或本地数据库',
    'logs/quickpaste.log 可能是运行日志',
    'screenshots/private-window.png 可能是用户截图',
    'dist/assets/app.js 属于构建产物或本地工作目录',
    'release/QuickPaste.exe 属于可执行文件或发布产物',
    'signing/private.pfx 可能包含私钥或签名证书',
  ])

  assert.deepEqual(scanCandidatePath('src/domain/clipboard.ts'), [])
  assert.deepEqual(scanCandidatePath('src-tauri/icons/128x128.png'), [])
  assert.deepEqual(scanCandidatePath('public/quickpaste-mark.svg'), [])
})

test('listCandidateFiles includes tracked and untracked source but excludes ignored files', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quickpaste-privacy-git-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  await writeFile(join(root, '.gitignore'), 'ignored.log\n')
  await writeFile(join(root, 'tracked.md'), '# tracked\n')
  await writeFile(join(root, 'untracked.ts'), 'export {}\n')
  await writeFile(join(root, 'ignored.log'), 'private log\n')
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.gitignore', 'tracked.md'], { cwd: root })

  assert.deepEqual(await listCandidateFiles(root), [
    '.gitignore',
    'tracked.md',
    'untracked.ts',
  ])
})

test('scanRepositoryPrivacy ignores binary icons and scans untracked source content', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quickpaste-privacy-scan-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src-tauri', 'icons'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src-tauri', 'icons', 'icon.png'), Buffer.from([0, 1, 2, 3]))
  await writeFile(
    join(root, 'src', 'config.ts'),
    `export const owner = "${['owner', 'private.dev'].join('@')}"\n`,
  )

  assert.deepEqual(await scanRepositoryPrivacy(root, [
    'src-tauri/icons/icon.png',
    'src/config.ts',
  ]), [
    'src/config.ts:1 包含非 GitHub noreply 邮箱',
  ])
})
