import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('every GitHub Action is pinned to a full commit SHA with a readable version comment', () => {
  const workflows = readdirSync('.github/workflows', { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => readFileSync(`.github/workflows/${entry.name}`, 'utf8'))
    .join('\n')
  const actionLines = [...workflows.matchAll(/^\s*uses\s*:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/gmu)]

  assert.ok(actionLines.length > 0)
  for (const [, action, version] of actionLines) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u)
    assert.ok(version, `${action} 缺少可读版本注释`)
  }
})

test('weekly security audit covers npm production dependencies and Rust advisories', () => {
  const workflow = readIfPresent('.github/workflows/security-audit.yml')

  assert.match(workflow, /^\s*schedule\s*:/mu)
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/u)
  assert.match(workflow, /rustsec\/audit-check@[0-9a-f]{40}\s+#\s+v2\.0\.0/u)
})

test('Dependabot watches npm, Cargo, and GitHub Actions every week', () => {
  const config = readIfPresent('.github/dependabot.yml')

  for (const ecosystem of ['npm', 'cargo', 'github-actions']) {
    assert.match(config, new RegExp(`package-ecosystem:\\s*["']${ecosystem}["']`, 'u'))
  }
  assert.ok((config.match(/interval:\s*["']weekly["']/gu) ?? []).length >= 3)
})
