import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DPI_SCALE_FACTORS = Object.freeze([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5])

export const SCENARIO_PLANS = Object.freeze({
  'warm-first-frame': Object.freeze({ warmups: 50, samples: 500, thresholdMs: 120 }),
  'paste-ordinary': Object.freeze({ attempts: 10_000, thresholdPercent: 99.5 }),
  'capture-ledger': Object.freeze({ writes: 100_000, thresholdPercentExclusive: 0.1 }),
  'dpi-mixed': Object.freeze({ scaleFactors: DPI_SCALE_FACTORS }),
})

const METRICS_RELATIVE_PATH = 'acceptance/metrics-v1.json'
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const RUN_ID = /^qpa-\d{8}T\d{6}Z-[a-f\d]{8}$/u
const SHA256 = /^[a-f\d]{64}$/u
const GIT_COMMIT = /^[a-f\d]{7,64}$/u

const PASTE_COUNTER_KEYS = [
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

const CAPTURE_COUNTER_KEYS = [
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function addExactKeyIssues(value, expectedKeys, path, issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected object`)
    return false
  }
  const expected = new Set(expectedKeys)
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) issues.push(`${path}.${key}: unexpected field`)
  }
  for (const key of expectedKeys) {
    if (!(key in value)) issues.push(`${path}.${key}: missing field`)
  }
  return true
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isNonnegativeFiniteNumber(value) {
  return Number.isFinite(value) && value >= 0
}

function addNonnegativeIntegerIssue(value, path, issues) {
  if (!isNonnegativeSafeInteger(value)) issues.push(`${path}: expected nonnegative safe integer`)
}

function addNullableHashIssue(value, path, issues) {
  if (value !== null && (typeof value !== 'string' || !SHA256.test(value))) {
    issues.push(`${path}: expected null or lowercase SHA-256`)
  }
}

function almostEqual(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9
}

function scenarioResult(scenario) {
  switch (scenario) {
    case 'warm-first-frame':
      return {
        plannedWarmups: 50,
        completedWarmups: 0,
        plannedSamples: 500,
        recordedSamples: 0,
        measurement: 'frontend-first-frame-acknowledgement',
        percentileMethod: 'nearest-rank',
        p95Ms: null,
        thresholdMs: 120,
        thresholdMet: null,
        metricsSnapshotSha256: null,
      }
    case 'paste-ordinary':
      return {
        plannedAttempts: 10_000,
        completedAttempts: 0,
        independentlyVerifiedSucceeded: 0,
        independentlyVerifiedFailed: 0,
        successRatePercent: null,
        thresholdPercent: 99.5,
        thresholdMet: null,
        verifier: 'external-ordinary-integrity-target',
        ledgerSha256: null,
      }
    case 'capture-ledger':
      return {
        plannedWrites: 100_000,
        completedWrites: 0,
        databaseMatched: 0,
        eventDelivered: 0,
        eventFailed: 0,
        missingWrites: 0,
        unexpectedRecords: 0,
        duplicateRecords: 0,
        internalWritesRecorded: 0,
        discrepancyCount: null,
        discrepancyRatePercent: null,
        thresholdPercent: 0.1,
        thresholdMet: null,
        writer: 'external-numbered-clipboard-writer',
        writerLedgerSha256: null,
        databaseEvidenceSha256: null,
        metricsSnapshotSha256: null,
      }
    case 'dpi-mixed':
      return {
        requiredScaleFactors: [...DPI_SCALE_FACTORS],
        mixedScaling: false,
        negativeCoordinateMonitor: false,
        checkedTaskbarEdges: [],
        checks: [],
        thresholdMet: null,
        verifier: 'manual-windows-display-matrix',
      }
    default:
      throw new Error(`unknown acceptance scenario: ${scenario}`)
  }
}

export function createPendingResult({ scenario, runId, startedAtUtc }) {
  if (!(scenario in SCENARIO_PLANS)) throw new Error(`unknown acceptance scenario: ${scenario}`)
  return {
    formatVersion: 1,
    runId,
    scenario,
    evidenceClass: 'pending-real-machine',
    status: 'pending',
    startedAtUtc,
    completedAtUtc: null,
    candidate: {
      version: null,
      commit: null,
      executableSha256: null,
    },
    profile: {
      kind: 'temporary-test-profile',
      liveProfileUsed: false,
      cleanupStatus: 'pending',
    },
    environment: {
      platform: 'windows',
      architecture: 'x86_64',
      windowsBuild: null,
      displayCount: null,
      scaleFactors: [],
    },
    result: scenarioResult(scenario),
  }
}

function isPathWithin(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child))
  return childRelative !== '' && childRelative !== '..' && !childRelative.startsWith(`..${sep}`)
}

function generatedRunId(now, nonce) {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/u, 'Z').replaceAll('-', '').replaceAll(':', '')
  return `qpa-${timestamp}-${nonce}`
}

export async function createAcceptanceRun({
  scenario,
  optIn,
  temporaryBase = join(tmpdir(), 'QuickPasteAcceptance'),
  now = new Date(),
  nonce = randomBytes(4).toString('hex'),
} = {}) {
  if (optIn !== true) {
    throw new Error('acceptance preparation requires the explicit --opt-in flag')
  }
  if (!(scenario in SCENARIO_PLANS)) throw new Error(`unknown acceptance scenario: ${scenario}`)
  const resolvedSystemTemp = resolve(tmpdir())
  const resolvedBase = resolve(temporaryBase)
  if (resolvedBase !== resolvedSystemTemp && !isPathWithin(resolvedSystemTemp, resolvedBase)) {
    throw new Error('acceptance runs must remain below the operating-system temporary directory')
  }
  if (!/^[a-f\d]{8}$/u.test(nonce)) throw new Error('acceptance nonce must be eight lowercase hex characters')

  const runId = generatedRunId(now, nonce)
  const runRoot = join(resolvedBase, runId)
  const profileRoot = runRoot
  const profileAppData = join(runRoot, 'Roaming')
  const profileLocalAppData = join(runRoot, 'Local')
  const webView2UserDataDirectory = join(runRoot, 'WebView2')
  const acceptanceProfileMarkerPath = join(profileRoot, 'acceptance-profile-v1.json')
  const metricsPath = join(profileRoot, ...METRICS_RELATIVE_PATH.split('/'))
  const evidenceDirectory = join(runRoot, 'evidence')
  const resultPath = join(runRoot, 'result.json')

  await mkdir(resolvedBase, { recursive: true })
  await mkdir(runRoot)
  await Promise.all([
    mkdir(profileAppData, { recursive: true }),
    mkdir(profileLocalAppData, { recursive: true }),
    mkdir(webView2UserDataDirectory, { recursive: true }),
    mkdir(evidenceDirectory, { recursive: true }),
  ])

  const result = createPendingResult({
    scenario,
    runId,
    startedAtUtc: now.toISOString(),
  })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })

  return {
    runId,
    scenario,
    runRoot,
    resultPath,
    evidenceDirectory,
    profileRoot,
    profileAppData,
    profileLocalAppData,
    webView2UserDataDirectory,
    acceptanceProfileMarkerPath,
    metricsRelativePath: METRICS_RELATIVE_PATH,
    metricsPath,
  }
}

export function nearestRank(samples, percentile) {
  if (!Array.isArray(samples) || samples.length === 0) return null
  if (!(percentile > 0 && percentile <= 1)) throw new RangeError('percentile must be in (0, 1]')
  if (!samples.every(isNonnegativeFiniteNumber)) {
    throw new TypeError('samples must contain only finite nonnegative numbers')
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(percentile * sorted.length) - 1]
}

export function validateMetricsSnapshot(value) {
  const issues = []
  if (!addExactKeyIssues(value, [
    'formatVersion',
    'updatedAt',
    'quickPanelFirstFrameAckMs',
    'pasteCounters',
    'captureCounters',
  ], 'metrics', issues)) return issues

  if (value.formatVersion !== 1) issues.push('metrics.formatVersion: expected 1')
  if (typeof value.updatedAt !== 'string' || !RFC3339_MILLIS.test(value.updatedAt)) {
    issues.push('metrics.updatedAt: expected UTC RFC3339 timestamp with milliseconds')
  }
  if (!Array.isArray(value.quickPanelFirstFrameAckMs)) {
    issues.push('metrics.quickPanelFirstFrameAckMs: expected array')
  } else {
    if (value.quickPanelFirstFrameAckMs.length > 500) {
      issues.push('metrics.quickPanelFirstFrameAckMs: expected at most 500 samples')
    }
    value.quickPanelFirstFrameAckMs.forEach((sample, index) => {
      if (!isNonnegativeFiniteNumber(sample)) {
        issues.push(`metrics.quickPanelFirstFrameAckMs[${index}]: expected finite nonnegative number`)
      }
    })
  }

  for (const [field, keys] of [
    ['pasteCounters', PASTE_COUNTER_KEYS],
    ['captureCounters', CAPTURE_COUNTER_KEYS],
  ]) {
    if (!addExactKeyIssues(value[field], keys, `metrics.${field}`, issues)) continue
    for (const key of keys) addNonnegativeIntegerIssue(value[field][key], `metrics.${field}.${key}`, issues)
  }
  return issues
}

function validateCommonResult(value, issues) {
  if (!addExactKeyIssues(value, [
    'formatVersion',
    'runId',
    'scenario',
    'evidenceClass',
    'status',
    'startedAtUtc',
    'completedAtUtc',
    'candidate',
    'profile',
    'environment',
    'result',
  ], 'result', issues)) return false

  if (value.formatVersion !== 1) issues.push('result.formatVersion: expected 1')
  if (typeof value.runId !== 'string' || !RUN_ID.test(value.runId)) issues.push('result.runId: invalid run id')
  if (!(value.scenario in SCENARIO_PLANS)) issues.push('result.scenario: unknown scenario')
  if (!['pending-real-machine', 'real-machine'].includes(value.evidenceClass)) {
    issues.push('result.evidenceClass: invalid evidence class')
  }
  if (!['pending', 'pass', 'fail', 'aborted'].includes(value.status)) issues.push('result.status: invalid status')
  if (typeof value.startedAtUtc !== 'string' || !RFC3339_MILLIS.test(value.startedAtUtc)) {
    issues.push('result.startedAtUtc: expected UTC RFC3339 timestamp with milliseconds')
  }
  if (value.completedAtUtc !== null
    && (typeof value.completedAtUtc !== 'string' || !RFC3339_MILLIS.test(value.completedAtUtc))) {
    issues.push('result.completedAtUtc: expected null or UTC RFC3339 timestamp with milliseconds')
  }

  if (addExactKeyIssues(value.candidate, ['version', 'commit', 'executableSha256'], 'result.candidate', issues)) {
    if (value.candidate.version !== null
      && (typeof value.candidate.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-z\d.-]+)?$/iu.test(value.candidate.version))) {
      issues.push('result.candidate.version: expected null or semantic version')
    }
    if (value.candidate.commit !== null
      && (typeof value.candidate.commit !== 'string' || !GIT_COMMIT.test(value.candidate.commit))) {
      issues.push('result.candidate.commit: expected null or hexadecimal commit id')
    }
    addNullableHashIssue(value.candidate.executableSha256, 'result.candidate.executableSha256', issues)
  }

  if (addExactKeyIssues(value.profile, ['kind', 'liveProfileUsed', 'cleanupStatus'], 'result.profile', issues)) {
    if (value.profile.kind !== 'temporary-test-profile') issues.push('result.profile.kind: expected temporary-test-profile')
    if (value.profile.liveProfileUsed !== false) issues.push('result.profile.liveProfileUsed: live profile is forbidden')
    if (!['pending', 'deleted', 'preserved-for-debug'].includes(value.profile.cleanupStatus)) {
      issues.push('result.profile.cleanupStatus: invalid cleanup status')
    }
  }

  if (addExactKeyIssues(value.environment, [
    'platform',
    'architecture',
    'windowsBuild',
    'displayCount',
    'scaleFactors',
  ], 'result.environment', issues)) {
    if (value.environment.platform !== 'windows') issues.push('result.environment.platform: expected windows')
    if (value.environment.architecture !== 'x86_64') issues.push('result.environment.architecture: expected x86_64')
    if (value.environment.windowsBuild !== null && !isNonnegativeSafeInteger(value.environment.windowsBuild)) {
      issues.push('result.environment.windowsBuild: expected null or nonnegative safe integer')
    }
    if (value.environment.displayCount !== null
      && (!Number.isSafeInteger(value.environment.displayCount) || value.environment.displayCount < 1)) {
      issues.push('result.environment.displayCount: expected null or positive safe integer')
    }
    if (!Array.isArray(value.environment.scaleFactors)
      || !value.environment.scaleFactors.every((scale) => DPI_SCALE_FACTORS.includes(scale))) {
      issues.push('result.environment.scaleFactors: expected approved DPI scale factors')
    }
  }

  if (value.evidenceClass === 'pending-real-machine' && value.status !== 'pending') {
    issues.push('result.evidenceClass pending-real-machine requires status pending')
  }
  if (value.evidenceClass === 'pending-real-machine'
    && isRecord(value.result)
    && value.result.thresholdMet !== null) {
    issues.push('pending result cannot claim thresholdMet')
  }
  if (value.status === 'pending') {
    if (value.evidenceClass !== 'pending-real-machine') {
      issues.push('result.status pending requires evidenceClass pending-real-machine')
    }
    if (value.completedAtUtc !== null) issues.push('pending result cannot set completedAtUtc')
  } else {
    if (value.evidenceClass !== 'real-machine') issues.push('completed result requires real-machine evidence')
    if (value.completedAtUtc === null) issues.push('completed result requires completedAtUtc')
    if (value.candidate?.version === null || value.candidate?.commit === null
      || value.candidate?.executableSha256 === null) {
      issues.push('completed result requires candidate version, commit, and executable hash')
    }
  }
  if (value.status === 'aborted' && isRecord(value.result) && value.result.thresholdMet !== null) {
    issues.push('aborted result cannot claim thresholdMet')
  }
  return true
}

function validateWarmResult(value, status, issues) {
  const keys = [
    'plannedWarmups', 'completedWarmups', 'plannedSamples', 'recordedSamples', 'measurement',
    'percentileMethod', 'p95Ms', 'thresholdMs', 'thresholdMet', 'metricsSnapshotSha256',
  ]
  if (!addExactKeyIssues(value, keys, 'result.result', issues)) return
  if (value.plannedWarmups !== 50) issues.push('result.result.plannedWarmups: expected 50')
  if (value.plannedSamples !== 500) issues.push('result.result.plannedSamples: expected 500')
  addNonnegativeIntegerIssue(value.completedWarmups, 'result.result.completedWarmups', issues)
  addNonnegativeIntegerIssue(value.recordedSamples, 'result.result.recordedSamples', issues)
  if (value.completedWarmups > 50) issues.push('result.result.completedWarmups: exceeds plan')
  if (value.recordedSamples > 500) issues.push('result.result.recordedSamples: exceeds plan')
  if (value.measurement !== 'frontend-first-frame-acknowledgement') {
    issues.push('result.result.measurement: invalid metric')
  }
  if (value.percentileMethod !== 'nearest-rank') issues.push('result.result.percentileMethod: expected nearest-rank')
  if (value.thresholdMs !== 120) issues.push('result.result.thresholdMs: expected 120')
  if (value.p95Ms !== null && !isNonnegativeFiniteNumber(value.p95Ms)) {
    issues.push('result.result.p95Ms: expected null or finite nonnegative number')
  }
  addNullableHashIssue(value.metricsSnapshotSha256, 'result.result.metricsSnapshotSha256', issues)

  if (status === 'pass' || status === 'fail') {
    if (value.completedWarmups !== 50 || value.recordedSamples !== 500) {
      issues.push('completed warm result requires 50 warmups and 500 recorded samples')
    }
    if (!isNonnegativeFiniteNumber(value.p95Ms)) {
      issues.push('completed warm result requires p95Ms')
      return
    }
    const expected = value.p95Ms <= 120
    if (value.thresholdMet !== expected) issues.push('result.result.thresholdMet: inconsistent with inclusive 120ms threshold')
    if (status !== (expected ? 'pass' : 'fail')) issues.push('result.status: inconsistent with warm threshold')
    if (value.metricsSnapshotSha256 === null) issues.push('completed warm result requires metrics snapshot hash')
  }
}

function validatePasteResult(value, status, issues) {
  const keys = [
    'plannedAttempts', 'completedAttempts', 'independentlyVerifiedSucceeded',
    'independentlyVerifiedFailed', 'successRatePercent', 'thresholdPercent', 'thresholdMet',
    'verifier', 'ledgerSha256',
  ]
  if (!addExactKeyIssues(value, keys, 'result.result', issues)) return
  if (value.plannedAttempts !== 10_000) issues.push('result.result.plannedAttempts: expected 10000')
  for (const key of ['completedAttempts', 'independentlyVerifiedSucceeded', 'independentlyVerifiedFailed']) {
    addNonnegativeIntegerIssue(value[key], `result.result.${key}`, issues)
  }
  if (value.completedAttempts > 10_000) issues.push('result.result.completedAttempts: exceeds plan')
  if (value.successRatePercent !== null
    && (!isNonnegativeFiniteNumber(value.successRatePercent) || value.successRatePercent > 100)) {
    issues.push('result.result.successRatePercent: expected null or percentage')
  }
  if (value.thresholdPercent !== 99.5) issues.push('result.result.thresholdPercent: expected 99.5')
  if (value.verifier !== 'external-ordinary-integrity-target') issues.push('result.result.verifier: invalid verifier')
  addNullableHashIssue(value.ledgerSha256, 'result.result.ledgerSha256', issues)

  if (status === 'pass' || status === 'fail') {
    if (value.completedAttempts !== 10_000) issues.push('completed paste result requires 10000 attempts')
    if (value.independentlyVerifiedSucceeded + value.independentlyVerifiedFailed !== value.completedAttempts) {
      issues.push('paste successes and failures must equal completed attempts')
    }
    const expectedRate = value.completedAttempts === 0
      ? 0
      : value.independentlyVerifiedSucceeded / value.completedAttempts * 100
    if (!almostEqual(value.successRatePercent, expectedRate)) {
      issues.push('result.result.successRatePercent: inconsistent with independent ledger')
    }
    const expected = expectedRate >= 99.5
    if (value.thresholdMet !== expected) issues.push('result.result.thresholdMet: inconsistent with inclusive 99.5% threshold')
    if (status !== (expected ? 'pass' : 'fail')) issues.push('result.status: inconsistent with paste threshold')
    if (value.ledgerSha256 === null) issues.push('completed paste result requires independent ledger hash')
  }
}

function validateCaptureResult(value, status, issues) {
  const keys = [
    'plannedWrites', 'completedWrites', 'databaseMatched', 'eventDelivered', 'eventFailed',
    'missingWrites', 'unexpectedRecords', 'duplicateRecords', 'internalWritesRecorded',
    'discrepancyCount', 'discrepancyRatePercent', 'thresholdPercent', 'thresholdMet', 'writer',
    'writerLedgerSha256', 'databaseEvidenceSha256', 'metricsSnapshotSha256',
  ]
  if (!addExactKeyIssues(value, keys, 'result.result', issues)) return
  if (value.plannedWrites !== 100_000) issues.push('result.result.plannedWrites: expected 100000')
  for (const key of [
    'completedWrites', 'databaseMatched', 'eventDelivered', 'eventFailed', 'missingWrites',
    'unexpectedRecords', 'duplicateRecords', 'internalWritesRecorded',
  ]) addNonnegativeIntegerIssue(value[key], `result.result.${key}`, issues)
  if (value.completedWrites > 100_000) issues.push('result.result.completedWrites: exceeds plan')
  if (value.discrepancyCount !== null) addNonnegativeIntegerIssue(value.discrepancyCount, 'result.result.discrepancyCount', issues)
  if (value.discrepancyRatePercent !== null
    && (!isNonnegativeFiniteNumber(value.discrepancyRatePercent) || value.discrepancyRatePercent > 100)) {
    issues.push('result.result.discrepancyRatePercent: expected null or percentage')
  }
  if (value.thresholdPercent !== 0.1) issues.push('result.result.thresholdPercent: expected 0.1')
  if (value.writer !== 'external-numbered-clipboard-writer') issues.push('result.result.writer: invalid writer')
  for (const key of ['writerLedgerSha256', 'databaseEvidenceSha256', 'metricsSnapshotSha256']) {
    addNullableHashIssue(value[key], `result.result.${key}`, issues)
  }

  if (status === 'pass' || status === 'fail') {
    if (value.completedWrites !== 100_000) issues.push('completed capture result requires 100000 writes')
    if (value.databaseMatched + value.missingWrites !== value.completedWrites) {
      issues.push('database matches and missing writes must equal completed writes')
    }
    if (value.eventDelivered + value.eventFailed !== value.completedWrites) {
      issues.push('delivered and failed events must equal completed writes')
    }
    const expectedDiscrepancy = value.missingWrites + value.unexpectedRecords
      + value.duplicateRecords + value.internalWritesRecorded
    if (value.discrepancyCount !== expectedDiscrepancy) {
      issues.push('result.result.discrepancyCount: inconsistent with ledger reconciliation')
    }
    const expectedRate = expectedDiscrepancy / value.completedWrites * 100
    if (!almostEqual(value.discrepancyRatePercent, expectedRate)) {
      issues.push('result.result.discrepancyRatePercent: inconsistent with ledger reconciliation')
    }
    const expected = expectedRate < 0.1
    if (value.thresholdMet !== expected) issues.push('result.result.thresholdMet: inconsistent with exclusive 0.1% threshold')
    if (status !== (expected ? 'pass' : 'fail')) issues.push('result.status: inconsistent with capture threshold')
    for (const key of ['writerLedgerSha256', 'databaseEvidenceSha256', 'metricsSnapshotSha256']) {
      if (value[key] === null) issues.push(`completed capture result requires ${key}`)
    }
  }
}

function validateDpiResult(value, status, issues) {
  const keys = [
    'requiredScaleFactors', 'mixedScaling', 'negativeCoordinateMonitor', 'checkedTaskbarEdges',
    'checks', 'thresholdMet', 'verifier',
  ]
  if (!addExactKeyIssues(value, keys, 'result.result', issues)) return
  if (JSON.stringify(value.requiredScaleFactors) !== JSON.stringify(DPI_SCALE_FACTORS)) {
    issues.push('result.result.requiredScaleFactors: expected the seven approved factors in order')
  }
  if (typeof value.mixedScaling !== 'boolean') issues.push('result.result.mixedScaling: expected boolean')
  if (typeof value.negativeCoordinateMonitor !== 'boolean') {
    issues.push('result.result.negativeCoordinateMonitor: expected boolean')
  }
  const taskbarEdges = ['left', 'right', 'top', 'bottom']
  if (!Array.isArray(value.checkedTaskbarEdges)
    || !value.checkedTaskbarEdges.every((edge) => taskbarEdges.includes(edge))) {
    issues.push('result.result.checkedTaskbarEdges: expected taskbar edge enums')
  }
  if (!Array.isArray(value.checks)) {
    issues.push('result.result.checks: expected array')
  } else {
    value.checks.forEach((check, index) => {
      const path = `result.result.checks[${index}]`
      if (!addExactKeyIssues(check, [
        'scaleFactor', 'monitorPlacement', 'taskbarEdge', 'allCornersWithinWorkArea',
        'anchorUsesSelectedMonitor', 'outcome',
      ], path, issues)) return
      if (!DPI_SCALE_FACTORS.includes(check.scaleFactor)) issues.push(`${path}.scaleFactor: invalid scale factor`)
      if (!['primary', 'secondary-negative', 'secondary-positive'].includes(check.monitorPlacement)) {
        issues.push(`${path}.monitorPlacement: invalid monitor placement`)
      }
      if (!taskbarEdges.includes(check.taskbarEdge)) issues.push(`${path}.taskbarEdge: invalid taskbar edge`)
      if (check.allCornersWithinWorkArea !== null && typeof check.allCornersWithinWorkArea !== 'boolean') {
        issues.push(`${path}.allCornersWithinWorkArea: expected null or boolean`)
      }
      if (check.anchorUsesSelectedMonitor !== null && typeof check.anchorUsesSelectedMonitor !== 'boolean') {
        issues.push(`${path}.anchorUsesSelectedMonitor: expected null or boolean`)
      }
      if (!['pass', 'fail', 'not-run'].includes(check.outcome)) issues.push(`${path}.outcome: invalid outcome`)
    })
  }
  if (value.verifier !== 'manual-windows-display-matrix') issues.push('result.result.verifier: invalid verifier')

  if (status === 'pass' || status === 'fail') {
    const checks = Array.isArray(value.checks) ? value.checks : []
    const scales = new Set(checks.map((check) => check.scaleFactor))
    const placements = new Set(checks.map((check) => check.monitorPlacement))
    const checkedEdges = new Set(checks.map((check) => check.taskbarEdge))
    const edges = new Set(Array.isArray(value.checkedTaskbarEdges) ? value.checkedTaskbarEdges : [])
    const completeMatrix = DPI_SCALE_FACTORS.every((scale) => scales.has(scale))
      && taskbarEdges.every((edge) => edges.has(edge))
      && taskbarEdges.every((edge) => checkedEdges.has(edge))
      && placements.has('secondary-negative')
      && (placements.has('primary') || placements.has('secondary-positive'))
      && value.mixedScaling
      && value.negativeCoordinateMonitor
      && checks.every((check) => check.outcome !== 'not-run'
        && typeof check.allCornersWithinWorkArea === 'boolean'
        && typeof check.anchorUsesSelectedMonitor === 'boolean')
    if (!completeMatrix) issues.push('completed DPI result requires the complete DPI matrix')
    const allChecksPass = completeMatrix
      && checks.every((check) => check.outcome === 'pass'
        && check.allCornersWithinWorkArea === true
        && check.anchorUsesSelectedMonitor === true)
    if (value.thresholdMet !== allChecksPass) issues.push('result.result.thresholdMet: inconsistent with DPI matrix')
    if (status !== (allChecksPass ? 'pass' : 'fail')) issues.push('result.status: inconsistent with DPI matrix')
  }
}

export function validateAcceptanceResult(value) {
  const issues = []
  if (!validateCommonResult(value, issues) || !(value.scenario in SCENARIO_PLANS)) return issues
  switch (value.scenario) {
    case 'warm-first-frame':
      validateWarmResult(value.result, value.status, issues)
      break
    case 'paste-ordinary':
      validatePasteResult(value.result, value.status, issues)
      break
    case 'capture-ledger':
      validateCaptureResult(value.result, value.status, issues)
      break
    case 'dpi-mixed':
      validateDpiResult(value.result, value.status, issues)
      break
  }
  return issues
}

function parseArguments(args) {
  const [command, ...tokens] = args
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const key = token.slice(2)
    if (key === 'opt-in') {
      options.optIn = true
      continue
    }
    const value = tokens[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    options[key] = value
    index += 1
  }
  return { command, options }
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2))
  if (command === 'prepare') {
    const prepared = await createAcceptanceRun({
      scenario: options.scenario,
      optIn: options.optIn === true,
    })
    process.stdout.write(`${JSON.stringify(prepared)}\n`)
    return
  }
  if (command === 'validate-result') {
    if (!options.file) throw new Error('validate-result requires --file')
    const issues = validateAcceptanceResult(await readJson(options.file))
    if (issues.length > 0) throw new Error(issues.join('\n'))
    process.stdout.write('acceptance result is valid\n')
    return
  }
  if (command === 'validate-metrics') {
    if (!options.file) throw new Error('validate-metrics requires --file')
    const metrics = await readJson(options.file)
    const issues = validateMetricsSnapshot(metrics)
    if (issues.length > 0) throw new Error(issues.join('\n'))
    const samples = metrics.quickPanelFirstFrameAckMs
    process.stdout.write(`${JSON.stringify({
      valid: true,
      sampleCount: samples.length,
      p95Ms: nearestRank(samples, 0.95),
      thresholdMet: samples.length === 500 ? nearestRank(samples, 0.95) <= 120 : null,
    })}\n`)
    return
  }
  throw new Error('usage: acceptance.mjs <prepare|validate-result|validate-metrics> [options]')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
