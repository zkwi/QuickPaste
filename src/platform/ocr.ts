import {
  isCanonicalOcrText,
  isValidClipboardItemId,
  isValidImageHash,
  type ClipboardItem,
} from '../domain/clipboard'
import { isValidHistoryCursor } from '../domain/historyQuery'
import type { ExternalOcrPatch } from './history'
import { isTauriRuntime } from './desktop'

export type NativeOcrInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

export type NativeOcrResult =
  | ({ status: 'applied' } & ExternalOcrPatch)
  | { status: 'stale' }
  | {
      status: 'error'
      reason: 'busy' | 'database' | 'queueFull' | 'unknown'
    }

export type OcrEnqueueOutcome = 'queued' | 'deduplicated' | 'queueFull' | 'disabled' | 'invalid' | 'shutdown'

export interface PendingOcrCandidate {
  id: string
  imageHash: string
}

export interface PendingOcrPage {
  items: PendingOcrCandidate[]
  nextCursor?: string
}

export interface OcrCoordinatorOptions {
  enabled: () => boolean
  getItem: (id: string) => ClipboardItem | undefined
  recognize: (id: string, imageHash: string) => Promise<NativeOcrResult | null>
  fail: (id: string, imageHash: string) => Promise<NativeOcrResult | null>
  acknowledge: (id: string, imageHash: string, patch: ExternalOcrPatch) => boolean
  apply: (id: string, imageHash: string, patch: ExternalOcrPatch) => void
}

export interface OcrCoordinator {
  enqueue: (item: ClipboardItem) => Promise<OcrEnqueueOutcome>
  enqueueStored: (candidate: PendingOcrCandidate) => Promise<OcrEnqueueOutcome>
  resume: (items: readonly ClipboardItem[]) => Promise<void>
  invalidate: () => void
  shutdown: () => void
  whenIdle: () => Promise<void>
  isBusy: () => boolean
  size: () => number
}

const MAX_OCR_JOBS = 8
const ERROR_REASONS = new Set(['busy', 'database', 'queueFull', 'unknown'])

async function invokeThroughTauri(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function parseNativeOcrResult(value: unknown): NativeOcrResult | null {
  if (!isRecord(value) || typeof value.status !== 'string') return null
  if (value.status === 'stale') {
    return hasExactKeys(value, ['status']) ? { status: 'stale' } : null
  }
  if (value.status === 'error') {
    if (!hasExactKeys(value, ['status', 'reason'])
      || typeof value.reason !== 'string'
      || !ERROR_REASONS.has(value.reason)) return null
    return {
      status: 'error',
      reason: value.reason as Extract<NativeOcrResult, { status: 'error' }>['reason'],
    }
  }
  if (value.status !== 'applied' || typeof value.ocrStatus !== 'string') return null
  if (value.ocrStatus === 'completed') {
    return hasExactKeys(value, ['status', 'ocrStatus', 'ocrText']) && isCanonicalOcrText(value.ocrText)
      ? { status: 'applied', ocrStatus: 'completed', ocrText: value.ocrText }
      : null
  }
  if ((value.ocrStatus === 'unavailable'
      || value.ocrStatus === 'failed'
      || value.ocrStatus === 'oversized')
    && hasExactKeys(value, ['status', 'ocrStatus'])) {
    return { status: 'applied', ocrStatus: value.ocrStatus }
  }
  return null
}

async function invokeNativeOcrCommand(
  command: 'recognize_clip_image' | 'mark_clip_ocr_failed',
  id: string,
  imageHash: string,
  invokeAdapter?: NativeOcrInvoke,
): Promise<NativeOcrResult | null> {
  if (!isValidClipboardItemId(id)
    || !isValidImageHash(imageHash)
    || !invokeAdapter && !isTauriRuntime()) return null
  try {
    return parseNativeOcrResult(await (invokeAdapter ?? invokeThroughTauri)(
      command,
      { id, imageHash },
    ))
  } catch {
    return null
  }
}

export function recognizeNativeClipImage(
  id: string,
  imageHash: string,
  invokeAdapter?: NativeOcrInvoke,
): Promise<NativeOcrResult | null> {
  return invokeNativeOcrCommand('recognize_clip_image', id, imageHash, invokeAdapter)
}

export function markNativeClipOcrFailed(
  id: string,
  imageHash: string,
  invokeAdapter?: NativeOcrInvoke,
): Promise<NativeOcrResult | null> {
  return invokeNativeOcrCommand('mark_clip_ocr_failed', id, imageHash, invokeAdapter)
}

export async function setNativeClipboardOcrEnabled(
  enabled: boolean,
  invokeAdapter?: NativeOcrInvoke,
): Promise<boolean> {
  if (typeof enabled !== 'boolean' || !invokeAdapter && !isTauriRuntime()) return false
  try {
    const applied = await (invokeAdapter ?? invokeThroughTauri)(
      'set_clipboard_ocr_enabled',
      { enabled },
    )
    return applied === enabled
  } catch {
    return false
  }
}

export async function invalidateNativeClipboardOcr(
  invokeAdapter?: NativeOcrInvoke,
): Promise<boolean> {
  if (!invokeAdapter && !isTauriRuntime()) return false
  try {
    return await (invokeAdapter ?? invokeThroughTauri)('invalidate_clipboard_ocr', {}) === true
  } catch {
    return false
  }
}

function parsePendingOcrPage(value: unknown): PendingOcrPage | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== 'items' && key !== 'nextCursor')
    || !Array.isArray(value.items)
    || value.items.length > MAX_OCR_JOBS
    || (value.nextCursor !== undefined && !isValidHistoryCursor(value.nextCursor))) return null
  const items: PendingOcrCandidate[] = []
  const ids = new Set<string>()
  for (const candidate of value.items) {
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, ['id', 'imageHash'])
      || !isValidClipboardItemId(candidate.id)
      || !isValidImageHash(candidate.imageHash)
      || ids.has(candidate.id)) return null
    ids.add(candidate.id)
    items.push({ id: candidate.id, imageHash: candidate.imageHash })
  }
  if (value.nextCursor !== undefined && items.length === 0) return null
  return {
    items,
    ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}),
  }
}

export async function listNativePendingOcrImages(
  cursor?: string,
  invokeAdapter?: NativeOcrInvoke,
): Promise<PendingOcrPage | null> {
  if (cursor !== undefined && !isValidHistoryCursor(cursor)) return null
  if (!invokeAdapter && !isTauriRuntime()) return null
  try {
    return parsePendingOcrPage(await (invokeAdapter ?? invokeThroughTauri)(
      'list_pending_ocr_images',
      { query: { limit: MAX_OCR_JOBS, ...(cursor ? { cursor } : {}) } },
    ))
  } catch {
    return null
  }
}

interface OcrJob {
  imageHash: string
  latestId: string
  generation: number
  tracked: boolean
}

function pendingCandidate(item: ClipboardItem): { id: string; imageHash: string } | null {
  return item.kind === 'image'
    && item.ocrStatus === 'pending'
    && isValidClipboardItemId(item.id)
    && isValidImageHash(item.imageHash)
    ? { id: item.id, imageHash: item.imageHash }
    : null
}

export function createOcrCoordinator(options: OcrCoordinatorOptions): OcrCoordinator {
  const jobs = new Map<string, OcrJob>()
  const queue: OcrJob[] = []
  let runningJob: OcrJob | null = null
  let drainPromise: Promise<void> | null = null
  let generation = 0
  let stopped = false

  const stillEligible = (id: string, imageHash: string): boolean => {
    const current = options.getItem(id)
    return current?.kind === 'image'
      && current.imageHash === imageHash
      && current.ocrStatus === 'pending'
  }

  const applyResult = (
    tracked: boolean,
    id: string,
    imageHash: string,
    requestGeneration: number,
    result: NativeOcrResult | null,
  ) => {
    if (!tracked || !result
      || result.status !== 'applied'
      || stopped
      || requestGeneration !== generation
      || !options.enabled()
      || !stillEligible(id, imageHash)) return
    const patch: ExternalOcrPatch = result.ocrStatus === 'completed'
      ? { ocrStatus: 'completed', ocrText: result.ocrText }
      : { ocrStatus: result.ocrStatus }
    if (!options.acknowledge(id, imageHash, patch)) return
    options.apply(id, imageHash, patch)
  }

  const processJob = async (job: OcrJob) => {
    runningJob = job
    try {
      while (!stopped) {
        const id = job.latestId
        const requestGeneration = job.generation
        if (requestGeneration !== generation
          || !options.enabled()
          || job.tracked && !stillEligible(id, job.imageHash)) {
          break
        }
        let result: NativeOcrResult | null = null
        try {
          result = await options.recognize(id, job.imageHash)
        } catch {
          result = null
        }
        applyResult(job.tracked, id, job.imageHash, requestGeneration, result)
        if (job.latestId === id && job.generation === requestGeneration) break
      }
    } finally {
      if (jobs.get(job.imageHash) === job) jobs.delete(job.imageHash)
      if (runningJob === job) runningJob = null
    }
  }

  const ensureDrain = () => {
    if (drainPromise || stopped) return
    drainPromise = (async () => {
      while (!stopped && queue.length > 0) {
        const job = queue.shift()
        if (job) await processJob(job)
      }
    })().finally(() => {
      drainPromise = null
    })
  }

  const enqueue = async (item: ClipboardItem): Promise<OcrEnqueueOutcome> => {
    if (stopped) return 'shutdown'
    if (!options.enabled()) return 'disabled'
    const candidate = pendingCandidate(item)
    if (!candidate) return 'invalid'

    const existing = jobs.get(candidate.imageHash)
    if (existing) {
      existing.latestId = candidate.id
      existing.generation = generation
      existing.tracked = true
      return 'deduplicated'
    }

    if (jobs.size >= MAX_OCR_JOBS) {
      let result: NativeOcrResult | null = null
      try {
        result = await options.fail(candidate.id, candidate.imageHash)
      } catch {
        result = null
      }
      applyResult(true, candidate.id, candidate.imageHash, generation, result)
      return 'queueFull'
    }

    const job: OcrJob = {
      imageHash: candidate.imageHash,
      latestId: candidate.id,
      generation,
      tracked: true,
    }
    jobs.set(job.imageHash, job)
    queue.push(job)
    ensureDrain()
    return 'queued'
  }

  const enqueueStored = async (candidate: PendingOcrCandidate): Promise<OcrEnqueueOutcome> => {
    if (stopped) return 'shutdown'
    if (!options.enabled()) return 'disabled'
    if (!isValidClipboardItemId(candidate.id) || !isValidImageHash(candidate.imageHash)) return 'invalid'
    if (jobs.has(candidate.imageHash)) return 'deduplicated'
    if (jobs.size >= MAX_OCR_JOBS) return 'queueFull'
    const job: OcrJob = {
      imageHash: candidate.imageHash,
      latestId: candidate.id,
      generation,
      tracked: stillEligible(candidate.id, candidate.imageHash),
    }
    jobs.set(job.imageHash, job)
    queue.push(job)
    ensureDrain()
    return 'queued'
  }

  const invalidate = () => {
    generation += 1
    for (const job of queue.splice(0)) {
      if (jobs.get(job.imageHash) === job) jobs.delete(job.imageHash)
    }
  }

  return {
    enqueue,
    enqueueStored,
    async resume(items) {
      if (stopped || !options.enabled()) return
      for (const item of items) await enqueue(item)
    },
    invalidate,
    shutdown() {
      if (stopped) return
      stopped = true
      invalidate()
      if (runningJob && jobs.get(runningJob.imageHash) === runningJob) {
        jobs.delete(runningJob.imageHash)
      }
    },
    whenIdle: async () => {
      while (drainPromise) await drainPromise
    },
    isBusy: () => jobs.size > 0 || drainPromise !== null,
    size: () => jobs.size,
  }
}


export async function pumpStoredPendingOcr(
  coordinator: Pick<OcrCoordinator, 'enqueueStored' | 'whenIdle'>,
  options: {
    enabled: () => boolean
    current: () => boolean
    list: (cursor?: string) => Promise<PendingOcrPage | null>
  },
): Promise<void> {
  await coordinator.whenIdle()
  let cursor: string | undefined
  while (options.enabled() && options.current()) {
    const page = await options.list(cursor)
    if (!page || !options.enabled() || !options.current()) return
    for (const candidate of page.items) {
      while (options.enabled() && options.current()) {
        const outcome = await coordinator.enqueueStored(candidate)
        if (outcome !== 'queueFull') {
          await coordinator.whenIdle()
          break
        }
        await coordinator.whenIdle()
      }
    }
    if (!options.enabled() || !options.current() || !page.nextCursor) return
    cursor = page.nextCursor
  }
}
