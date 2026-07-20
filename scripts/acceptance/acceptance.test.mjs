import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  DPI_SCALE_FACTORS,
  SCENARIO_PLANS,
  createAcceptanceRun,
  createPendingResult,
  nearestRank,
  validateAcceptanceResult,
  validateMetricsSnapshot,
} from './acceptance.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const acceptanceScript = resolve(scriptDirectory, 'acceptance.mjs')

const pasteCounterKeys = [
  'directSucceeded',
  'directFailed',
  'clipboardWriteFailed',
  'clipboardUnverified',
  'targetMissing',
  'targetStale',
  'elevatedSucceeded',
  'elevatedFailed',
  'elevationDisabled',
]

const captureCounterKeys = [
  'stableExternal',
  'eventDelivered',
  'eventFailed',
  'internalWriteConsumed',
  'duplicateSuppressed',
  'paused',
  'excluded',
  'unsupported',
  'retryExhausted',
]

function zeroCounters(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]))
}

function validMetrics(overrides = {}) {
  return {
    formatVersion: 1,
    updatedAt: '2026-07-20T08:09:10.123Z',
    quickPanelFirstFrameAckMs: [10, 20, 30],
    pasteCounters: zeroCounters(pasteCounterKeys),
    captureCounters: zeroCounters(captureCounterKeys),
    ...overrides,
  }
}

function finalizedResult(scenario, resultOverrides) {
  const value = createPendingResult({
    scenario,
    runId: 'qpa-20260720T080910Z-deadbeef',
    startedAtUtc: '2026-07-20T08:09:10.123Z',
  })
  value.evidenceClass = 'real-machine'
  value.completedAtUtc = '2026-07-20T09:09:10.123Z'
  value.candidate = {
    version: '0.6.0',
    commit: 'a'.repeat(40),
    executableSha256: 'b'.repeat(64),
  }
  value.profile.cleanupStatus = 'deleted'
  value.environment = {
    platform: 'windows',
    architecture: 'x86_64',
    windowsBuild: 26100,
    displayCount: 2,
    scaleFactors: [...DPI_SCALE_FACTORS],
  }
  Object.assign(value.result, resultOverrides)
  return value
}

test('scenario plans pin the approved sample sizes, real-machine thresholds, and DPI matrix', () => {
  assert.deepEqual(SCENARIO_PLANS['warm-first-frame'], {
    warmups: 50,
    samples: 500,
    thresholdMs: 120,
  })
  assert.deepEqual(SCENARIO_PLANS['paste-ordinary'], {
    attempts: 10_000,
    thresholdPercent: 99.5,
  })
  assert.deepEqual(SCENARIO_PLANS['capture-ledger'], {
    writes: 100_000,
    thresholdPercentExclusive: 0.1,
  })
  assert.deepEqual(DPI_SCALE_FACTORS, [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5])
})

test('preparing a run requires opt-in and creates only an isolated temporary profile', async (context) => {
  const temporaryBase = await mkdtemp(join(tmpdir(), 'quickpaste-acceptance-test-'))
  context.after(() => rm(temporaryBase, { recursive: true, force: true }))

  await assert.rejects(
    createAcceptanceRun({
      scenario: 'warm-first-frame',
      optIn: false,
      temporaryBase,
    }),
    /--opt-in/,
  )

  const prepared = await createAcceptanceRun({
    scenario: 'warm-first-frame',
    optIn: true,
    temporaryBase,
    now: new Date('2026-07-20T08:09:10.123Z'),
    nonce: 'deadbeef',
  })
  const runRelative = relative(resolve(temporaryBase), prepared.runRoot)
  assert.notEqual(runRelative, '')
  assert.equal(runRelative.startsWith(`..${sep}`), false)
  assert.equal(prepared.profileRoot, prepared.runRoot)
  assert.equal(prepared.profileAppData, join(prepared.runRoot, 'Roaming'))
  assert.equal(prepared.profileLocalAppData, join(prepared.runRoot, 'Local'))
  assert.equal(prepared.webView2UserDataDirectory, join(prepared.runRoot, 'WebView2'))
  assert.equal(prepared.acceptanceProfileMarkerPath, join(prepared.profileRoot, 'acceptance-profile-v1.json'))
  assert.equal(prepared.metricsRelativePath, 'acceptance/metrics-v1.json')
  assert.equal(prepared.metricsPath, join(prepared.profileRoot, 'acceptance', 'metrics-v1.json'))
  assert.deepEqual(
    (await readdir(prepared.runRoot)).sort(),
    ['Local', 'Roaming', 'WebView2', 'evidence', 'result.json'],
  )

  const result = JSON.parse(await readFile(prepared.resultPath, 'utf8'))
  assert.equal(result.status, 'pending')
  assert.equal(result.evidenceClass, 'pending-real-machine')
  assert.equal(result.profile.kind, 'temporary-test-profile')
  assert.equal(result.profile.liveProfileUsed, false)
  assert.equal(result.result.plannedWarmups, 50)
  assert.equal(result.result.plannedSamples, 500)
  assert.equal(result.result.thresholdMet, null)
})

test('the prepare CLI refuses to create a run without the explicit opt-in flag', () => {
  const attempt = spawnSync(process.execPath, [
    acceptanceScript,
    'prepare',
    '--scenario',
    'warm-first-frame',
  ], { encoding: 'utf8' })

  assert.notEqual(attempt.status, 0)
  assert.match(attempt.stderr, /--opt-in/)
})

test('metrics validation enforces the fixed content-free whitelist and bounded samples', () => {
  assert.deepEqual(validateMetricsSnapshot(validMetrics()), [])

  const withText = validMetrics({ clipboardText: 'not allowed' })
  assert.match(validateMetricsSnapshot(withText).join('\n'), /clipboardText.*unexpected field/)

  const withNestedString = validMetrics()
  withNestedString.pasteCounters.error = 'not allowed'
  assert.match(validateMetricsSnapshot(withNestedString).join('\n'), /pasteCounters\.error.*unexpected field/)

  const oversized = validMetrics({ quickPanelFirstFrameAckMs: Array.from({ length: 501 }, () => 1) })
  assert.match(validateMetricsSnapshot(oversized).join('\n'), /at most 500/)

  const nonFinite = validMetrics({ quickPanelFirstFrameAckMs: [Number.POSITIVE_INFINITY] })
  assert.match(validateMetricsSnapshot(nonFinite).join('\n'), /finite nonnegative number/)
})

test('nearest-rank warm p95 treats the 120ms boundary as inclusive', () => {
  const samples = Array.from({ length: 500 }, (_, index) => index < 475 ? 120 : 121)
  assert.equal(nearestRank(samples, 0.95), 120)

  const passing = finalizedResult('warm-first-frame', {
    completedWarmups: 50,
    recordedSamples: 500,
    p95Ms: 120,
    thresholdMet: true,
    metricsSnapshotSha256: 'c'.repeat(64),
  })
  passing.status = 'pass'
  assert.deepEqual(validateAcceptanceResult(passing), [])

  const failing = structuredClone(passing)
  failing.status = 'fail'
  failing.result.p95Ms = 120.001
  failing.result.thresholdMet = false
  assert.deepEqual(validateAcceptanceResult(failing), [])
})

test('ordinary-target paste requires 9950 of 10000 independent successes', () => {
  const passing = finalizedResult('paste-ordinary', {
    completedAttempts: 10_000,
    independentlyVerifiedSucceeded: 9_950,
    independentlyVerifiedFailed: 50,
    successRatePercent: 99.5,
    thresholdMet: true,
    ledgerSha256: 'c'.repeat(64),
  })
  passing.status = 'pass'
  assert.deepEqual(validateAcceptanceResult(passing), [])

  const failing = structuredClone(passing)
  failing.status = 'fail'
  failing.result.independentlyVerifiedSucceeded = 9_949
  failing.result.independentlyVerifiedFailed = 51
  failing.result.successRatePercent = 99.49
  failing.result.thresholdMet = false
  assert.deepEqual(validateAcceptanceResult(failing), [])
})

test('capture discrepancy is strictly below 0.1 percent: 99 passes and 100 fails', () => {
  const passing = finalizedResult('capture-ledger', {
    completedWrites: 100_000,
    databaseMatched: 99_901,
    eventDelivered: 100_000,
    eventFailed: 0,
    missingWrites: 99,
    unexpectedRecords: 0,
    duplicateRecords: 0,
    internalWritesRecorded: 0,
    discrepancyCount: 99,
    discrepancyRatePercent: 0.099,
    thresholdMet: true,
    writerLedgerSha256: 'c'.repeat(64),
    databaseEvidenceSha256: 'd'.repeat(64),
    metricsSnapshotSha256: 'e'.repeat(64),
  })
  passing.status = 'pass'
  assert.deepEqual(validateAcceptanceResult(passing), [])

  const failing = structuredClone(passing)
  failing.status = 'fail'
  failing.result.databaseMatched = 99_900
  failing.result.missingWrites = 100
  failing.result.discrepancyCount = 100
  failing.result.discrepancyRatePercent = 0.1
  failing.result.thresholdMet = false
  assert.deepEqual(validateAcceptanceResult(failing), [])
})

test('pending templates cannot claim an unmeasured threshold or real-machine success', () => {
  const pending = createPendingResult({
    scenario: 'paste-ordinary',
    runId: 'qpa-20260720T080910Z-deadbeef',
    startedAtUtc: '2026-07-20T08:09:10.123Z',
  })
  pending.result.thresholdMet = true
  pending.status = 'pass'

  const issues = validateAcceptanceResult(pending).join('\n')
  assert.match(issues, /pending-real-machine.*status pending/)
  assert.match(issues, /pending result cannot claim thresholdMet/)
})

test('an aborted real-machine run cannot claim a threshold result', () => {
  const aborted = finalizedResult('warm-first-frame', {
    completedWarmups: 12,
    recordedSamples: 0,
    thresholdMet: true,
  })
  aborted.status = 'aborted'

  assert.match(validateAcceptanceResult(aborted).join('\n'), /aborted result cannot claim thresholdMet/)
})

test('a DPI pass or fail requires the complete seven-scale, four-edge real-machine matrix', () => {
  const incomplete = finalizedResult('dpi-mixed', {
    thresholdMet: false,
  })
  incomplete.status = 'fail'
  assert.match(validateAcceptanceResult(incomplete).join('\n'), /requires the complete DPI matrix/)

  const complete = finalizedResult('dpi-mixed', {
    mixedScaling: true,
    negativeCoordinateMonitor: true,
    checkedTaskbarEdges: ['left', 'right', 'top', 'bottom'],
    checks: DPI_SCALE_FACTORS.map((scaleFactor, index) => ({
      scaleFactor,
      monitorPlacement: index === 0 ? 'primary' : index % 2 === 0 ? 'secondary-negative' : 'secondary-positive',
      taskbarEdge: ['left', 'right', 'top', 'bottom'][index % 4],
      allCornersWithinWorkArea: true,
      anchorUsesSelectedMonitor: true,
      outcome: 'pass',
    })),
    thresholdMet: true,
  })
  complete.status = 'pass'
  assert.deepEqual(validateAcceptanceResult(complete), [])
})

test('tracked JSON schemas parse and PowerShell acceptance scripts have valid syntax', async (context) => {
  const resultSchema = JSON.parse(await readFile(join(scriptDirectory, 'acceptance-result.schema.json'), 'utf8'))
  const metricsSchema = JSON.parse(await readFile(join(scriptDirectory, 'metrics-v1.schema.json'), 'utf8'))
  assert.equal(resultSchema.$schema, 'http://json-schema.org/draft-07/schema#')
  assert.equal(metricsSchema.$schema, 'http://json-schema.org/draft-07/schema#')
  assert.equal(resultSchema.additionalProperties, false)
  assert.equal(metricsSchema.additionalProperties, false)
  assert.deepEqual(metricsSchema.definitions.pasteCounters.required, pasteCounterKeys)
  assert.deepEqual(Object.keys(metricsSchema.definitions.pasteCounters.properties), pasteCounterKeys)

  const powershellScripts = (await readdir(scriptDirectory))
    .filter((file) => file.endsWith('.ps1'))
    .sort()
  assert.deepEqual(powershellScripts, ['Invoke-Acceptance.ps1'])
  const launcher = await readFile(join(scriptDirectory, 'Invoke-Acceptance.ps1'), 'utf8')
  assert.match(launcher, /QUICKPASTE_ACCEPTANCE_PROFILE/u)
  assert.match(launcher, /WEBVIEW2_USER_DATA_FOLDER/u)
  assert.match(launcher, /acceptance-profile-v1\.json/u)
  assert.match(launcher, /--acceptance-metrics/u)
  assert.match(launcher, /SetEnvironmentVariable\('QUICKPASTE_ACCEPTANCE_RUN_ROOT', \$prepared\.runRoot/u)
  assert.match(launcher, /SetEnvironmentVariable\('QUICKPASTE_ACCEPTANCE_PROFILE', \$prepared\.profileRoot/u)
  assert.match(launcher, /SetEnvironmentVariable\('WEBVIEW2_USER_DATA_FOLDER', \$prepared\.webView2UserDataDirectory/u)
  assert.match(launcher, /RunRoot = \$prepared\.runRoot/u)
  assert.match(launcher, /ProfileRoot = \$prepared\.profileRoot/u)
  assert.match(launcher, /@\(\(Compare-Object \$markerKeys/u)
  assert.match(launcher, /\[System\.Text\.Json\.JsonDocument\]::Parse/u)

  const contractValidationIndex = launcher.indexOf('$candidateBytes = [IO.File]::ReadAllBytes')
  const runningProcessGuardIndex = launcher.indexOf("$runningQuickPaste = Get-Process -Name 'quickpaste'")
  assert.notEqual(contractValidationIndex, -1)
  assert.notEqual(runningProcessGuardIndex, -1)
  assert.ok(
    contractValidationIndex < runningProcessGuardIndex,
    '候选契约校验必须先于环境相关的运行进程检查，确保拒绝原因确定且 fail closed',
  )

  const syntaxCheck = join(await mkdtemp(join(tmpdir(), 'quickpaste-ps-syntax-')), 'check.ps1')
  context.after(() => rm(dirname(syntaxCheck), { recursive: true, force: true }))
  await writeFile(syntaxCheck, [
    '$ErrorActionPreference = "Stop"',
    '$failed = $false',
    `@(${powershellScripts.map((file) => `'${join(scriptDirectory, file).replaceAll("'", "''")}'`).join(',')}) | ForEach-Object {`,
    '  $tokens = $null',
    '  $errors = $null',
    '  [System.Management.Automation.Language.Parser]::ParseFile($_, [ref]$tokens, [ref]$errors) > $null',
    '  if ($errors.Count -gt 0) { $failed = $true; $errors | ForEach-Object { Write-Error $_ } }',
    '}',
    'if ($failed) { exit 1 }',
  ].join('\n'))
  const parsed = spawnSync('pwsh', ['-NoProfile', '-File', syntaxCheck], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, `${parsed.stdout}\n${parsed.stderr}`)

  const unsupportedCandidate = join(dirname(syntaxCheck), 'unsupported.exe')
  await writeFile(unsupportedCandidate, Buffer.from('not a QuickPaste candidate'))
  const refused = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    join(scriptDirectory, 'Invoke-Acceptance.ps1'),
    '-Scenario',
    'warm-first-frame',
    '-CandidateExecutable',
    unsupportedCandidate,
    '-OptIn',
  ], { encoding: 'utf8' })
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stdout}\n${refused.stderr}`, /不含验收 profile 契约/u)

  const schemaFixtureDirectory = await mkdtemp(join(tmpdir(), 'quickpaste-schema-'))
  context.after(() => rm(schemaFixtureDirectory, { recursive: true, force: true }))
  const validResultPath = join(schemaFixtureDirectory, 'valid-result.json')
  const invalidResultPath = join(schemaFixtureDirectory, 'invalid-result.json')
  const validMetricsPath = join(schemaFixtureDirectory, 'valid-metrics.json')
  const validResult = createPendingResult({
    scenario: 'capture-ledger',
    runId: 'qpa-20260720T080910Z-deadbeef',
    startedAtUtc: '2026-07-20T08:09:10.123Z',
  })
  await Promise.all([
    writeFile(validResultPath, JSON.stringify(validResult)),
    writeFile(invalidResultPath, JSON.stringify({ ...validResult, unexpected: true })),
    writeFile(validMetricsPath, JSON.stringify(validMetrics())),
  ])
  const quote = (path) => `'${path.replaceAll("'", "''")}'`
  const schemaCheck = spawnSync('pwsh', ['-NoProfile', '-Command', [
    `$validResult = Test-Json -LiteralPath ${quote(validResultPath)} -SchemaFile ${quote(join(scriptDirectory, 'acceptance-result.schema.json'))}`,
    `$invalidResult = Test-Json -LiteralPath ${quote(invalidResultPath)} -SchemaFile ${quote(join(scriptDirectory, 'acceptance-result.schema.json'))} -ErrorAction SilentlyContinue`,
    `$validMetrics = Test-Json -LiteralPath ${quote(validMetricsPath)} -SchemaFile ${quote(join(scriptDirectory, 'metrics-v1.schema.json'))}`,
    'if (-not $validResult -or $invalidResult -or -not $validMetrics) { exit 1 }',
  ].join('\n')], { encoding: 'utf8' })
  assert.equal(schemaCheck.status, 0, `${schemaCheck.stdout}\n${schemaCheck.stderr}`)
})

test('acceptance documentation keeps automated, synthetic, and real-machine evidence distinct', async () => {
  const repositoryRoot = resolve(scriptDirectory, '..', '..')
  const harnessReadme = await readFile(join(scriptDirectory, 'README.md'), 'utf8')
  const testingGuide = await readFile(join(repositoryRoot, 'docs', 'testing.md'), 'utf8')
  const releaseGuide = await readFile(join(repositoryRoot, 'docs', 'release.md'), 'utf8')

  for (const document of [harnessReadme, testingGuide, releaseGuide]) {
    assert.match(document, /automated proof/u)
    assert.match(document, /synthetic benchmark/u)
    assert.match(document, /pending real-machine/u)
  }
  assert.match(harnessReadme, /50[^\n]+500/u)
  assert.match(harnessReadme, /10,000/u)
  assert.match(harnessReadme, /100,000/u)
  assert.match(harnessReadme, /1\.0[^\n]+2\.5/u)
  assert.match(harnessReadme, /external ordinary-integrity target/u)
  assert.match(harnessReadme, /independent writer\/expected-ID ledger/u)
  assert.match(harnessReadme, /never uses the live user database/u)
  assert.match(harnessReadme, /clipboardWriteFailed/u)
  assert.match(testingGuide, /acceptance\/metrics-v1\.json/u)
  assert.match(releaseGuide, /validate-result/u)
})
