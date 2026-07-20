import type { LoadedClipboardItem } from '../domain/clipboard'
import {
  createOcrCoordinator,
  invalidateNativeClipboardOcr,
  listNativePendingOcrImages,
  markNativeClipOcrFailed,
  pumpStoredPendingOcr,
  recognizeNativeClipImage,
  setNativeClipboardOcrEnabled,
  type NativeOcrInvoke,
  type NativeOcrResult,
} from './ocr'

const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)

function image(id: string, imageHash = hashA): LoadedClipboardItem {
  return {
    id,
    kind: 'image',
    title: id,
    content: 'clipboard image',
    sourceApp: 'SnippingTool',
    copiedAt: '2026-07-19T00:00:00.000Z',
    pinned: false,
    searchTerms: [],
    formats: ['image'],
    imageUrl: 'data:image/png;base64,AA==',
    imageHash,
    ocrStatus: 'pending',
  }
}

describe('native OCR command boundary', () => {
  it('strictly synchronizes the native OCR gate', async () => {
    const invoke = vi.fn<NativeOcrInvoke>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce('true')

    await expect(setNativeClipboardOcrEnabled(false, invoke)).resolves.toBe(true)
    await expect(setNativeClipboardOcrEnabled(true, invoke)).resolves.toBe(true)
    await expect(setNativeClipboardOcrEnabled(true, invoke)).resolves.toBe(false)
    expect(invoke.mock.calls).toEqual([
      ['set_clipboard_ocr_enabled', { enabled: false }],
      ['set_clipboard_ocr_enabled', { enabled: true }],
      ['set_clipboard_ocr_enabled', { enabled: true }],
    ])
  })

  it('strictly invalidates the native OCR lifecycle without changing its setting', async () => {
    const invoke = vi.fn<NativeOcrInvoke>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce('true')

    await expect(invalidateNativeClipboardOcr(invoke)).resolves.toBe(true)
    await expect(invalidateNativeClipboardOcr(invoke)).resolves.toBe(false)
    await expect(invalidateNativeClipboardOcr(invoke)).resolves.toBe(false)
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenCalledWith('invalidate_clipboard_ocr', {})
  })

  it('sends only id/hash and strictly parses applied, stale, and content-free error results', async () => {
    const invoke = vi.fn<NativeOcrInvoke>()
      .mockResolvedValueOnce({ status: 'applied', ocrStatus: 'completed', ocrText: 'line 1\r\nline 2' })
      .mockResolvedValueOnce({ status: 'stale' })
      .mockResolvedValueOnce({ status: 'error', reason: 'database' })

    await expect(recognizeNativeClipImage('image-1', hashA, invoke)).resolves.toEqual({
      status: 'applied', ocrStatus: 'completed', ocrText: 'line 1\r\nline 2',
    })
    await expect(recognizeNativeClipImage('image-1', hashA, invoke)).resolves.toEqual({ status: 'stale' })
    await expect(recognizeNativeClipImage('image-1', hashA, invoke)).resolves.toEqual({
      status: 'error', reason: 'database',
    })
    const failInvoke: NativeOcrInvoke = vi.fn().mockResolvedValue({
      status: 'applied', ocrStatus: 'failed',
    })
    await expect(markNativeClipOcrFailed('image-1', hashA, failInvoke)).resolves.toEqual({
      status: 'applied', ocrStatus: 'failed',
    })
    expect(failInvoke).toHaveBeenCalledWith('mark_clip_ocr_failed', {
      id: 'image-1', imageHash: hashA,
    })
    expect(invoke).toHaveBeenCalledWith('recognize_clip_image', { id: 'image-1', imageHash: hashA })
  })

  it('lists only a bounded id/hash pending page through a strict cursor contract', async () => {
    const cursor = btoa('1784426400000\npending-8')
    const nextCursor = btoa('1784426399000\npending-16')
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: `pending-${index}`,
      imageHash: index.toString(16).padStart(64, '0'),
    }))
    const invoke = vi.fn<NativeOcrInvoke>().mockResolvedValue({ items, nextCursor })

    await expect(listNativePendingOcrImages(cursor, invoke)).resolves.toEqual({ items, nextCursor })
    expect(invoke).toHaveBeenCalledWith('list_pending_ocr_images', {
      query: { limit: 8, cursor },
    })

    for (const malformed of [
      { items: [{ ...items[0], imageUrl: 'data:image/png;base64,SECRET' }] },
      { items: [...items, { id: 'overflow', imageHash: 'f'.repeat(64) }] },
      { items: [items[0], items[0]] },
      { items: [], nextCursor },
      { items, nextCursor: 'opaque' },
      { items, unexpected: true },
    ]) {
      const malformedInvoke: NativeOcrInvoke = vi.fn().mockResolvedValue(malformed)
      await expect(listNativePendingOcrImages(undefined, malformedInvoke)).resolves.toBeNull()
    }
  })

  it.each([
    { status: 'applied', ocrStatus: 'pending' },
    { status: 'applied', ocrStatus: 'completed' },
    { status: 'applied', ocrStatus: 'failed', ocrText: 'must not leak' },
    { status: 'stale', reason: 'extra' },
    { status: 'error', reason: 'private sqlite detail' },
    { status: 'error', reason: 'decode' },
    { status: 'error', reason: 'winrt' },
    { status: 'error', reason: 'database', detail: 'private' },
  ])('rejects malformed native OCR response %#', async (result) => {
    const invoke: NativeOcrInvoke = vi.fn().mockResolvedValue(result)
    await expect(recognizeNativeClipImage('image-1', hashA, invoke)).resolves.toBeNull()
  })

  it('fast-fails malformed ids and hashes without invoking native code', async () => {
    const invoke: NativeOcrInvoke = vi.fn()
    await expect(recognizeNativeClipImage('bad\nid', hashA, invoke)).resolves.toBeNull()
    await expect(recognizeNativeClipImage('image-1', 'A'.repeat(64), invoke)).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('bounded OCR coordinator', () => {
  it('does no work while disabled', async () => {
    const recognize = vi.fn()
    const fail = vi.fn()
    const coordinator = createOcrCoordinator({
      enabled: () => false,
      getItem: () => image('image-1'),
      recognize,
      fail,
      acknowledge: vi.fn(),
      apply: vi.fn(),
    })

    await expect(coordinator.enqueue(image('image-1'))).resolves.toBe('disabled')
    await coordinator.whenIdle()
    expect(recognize).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('runs one recognition at a time, bounds eight unique jobs, and conditionally fails overflow', async () => {
    const candidates = new Map<string, LoadedClipboardItem>()
    const resolvers: Array<(value: NativeOcrResult) => void> = []
    const recognize = vi.fn((id: string) => new Promise<NativeOcrResult>((resolve) => {
      expect(candidates.has(id)).toBe(true)
      resolvers.push(resolve)
    }))
    const fail = vi.fn().mockResolvedValue({ status: 'applied', ocrStatus: 'failed' })
    const coordinator = createOcrCoordinator({
      enabled: () => true,
      getItem: (id) => candidates.get(id),
      recognize,
      fail,
      acknowledge: vi.fn().mockReturnValue(true),
      apply: vi.fn(),
    })

    for (let index = 0; index < 9; index += 1) {
      const candidate = image(`image-${index}`, index.toString(16).padStart(64, '0'))
      candidates.set(candidate.id, candidate)
      const outcome = await coordinator.enqueue(candidate)
      expect(outcome).toBe(index < 8 ? 'queued' : 'queueFull')
    }
    expect(recognize).toHaveBeenCalledTimes(1)
    expect(fail).toHaveBeenCalledWith('image-8', '0'.repeat(63) + '8')

    while (resolvers.length > 0 || coordinator.isBusy()) {
      const resolve = resolvers.shift()
      resolve?.({ status: 'stale' })
      await Promise.resolve()
    }
    await coordinator.whenIdle()
    expect(recognize).toHaveBeenCalledTimes(8)
    expect(coordinator.size()).toBe(0)
  })

  it('serializes overflow failure patches while replaying more than sixteen persisted images', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => (
      image(`replayed-${index}`, index.toString(16).padStart(64, '0'))
    ))
    const items = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    let releaseRecognition: ((value: NativeOcrResult) => void) | undefined
    const recognize = vi.fn(() => new Promise<NativeOcrResult>((resolve) => {
      releaseRecognition = resolve
    }))
    let activeFailures = 0
    let maximumActiveFailures = 0
    const fail = vi.fn(async () => {
      activeFailures += 1
      maximumActiveFailures = Math.max(maximumActiveFailures, activeFailures)
      await Promise.resolve()
      activeFailures -= 1
      return { status: 'applied', ocrStatus: 'failed' } as const
    })
    const coordinator = createOcrCoordinator({
      enabled: () => true,
      getItem: (id) => items.get(id),
      recognize,
      fail,
      acknowledge: vi.fn().mockReturnValue(true),
      apply: vi.fn(),
    })

    await coordinator.resume(candidates)
    expect(recognize).toHaveBeenCalledOnce()
    expect(fail).toHaveBeenCalledTimes(12)
    expect(maximumActiveFailures).toBe(1)

    coordinator.shutdown()
    releaseRecognition?.({ status: 'stale' })
    await coordinator.whenIdle()
  })

  it('coalesces a running same-hash job to the latest eligible id', async () => {
    const items = new Map<string, LoadedClipboardItem>()
    const first = image('old-id')
    const latest = image('latest-id')
    items.set(first.id, first)
    items.set(latest.id, latest)
    let resolveFirst: ((value: NativeOcrResult) => void) | undefined
    const recognize = vi.fn()
      .mockImplementationOnce(() => new Promise<NativeOcrResult>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ status: 'applied', ocrStatus: 'completed', ocrText: 'latest text' })
    const acknowledge = vi.fn().mockReturnValue(true)
    const apply = vi.fn()
    const coordinator = createOcrCoordinator({
      enabled: () => true,
      getItem: (id) => items.get(id),
      recognize,
      fail: vi.fn(),
      acknowledge,
      apply,
    })

    await expect(coordinator.enqueue(first)).resolves.toBe('queued')
    await expect(coordinator.enqueue(latest)).resolves.toBe('deduplicated')
    items.delete(first.id)
    resolveFirst?.({ status: 'stale' })
    await coordinator.whenIdle()

    expect(recognize.mock.calls).toEqual([
      ['old-id', hashA],
      ['latest-id', hashA],
    ])
    expect(acknowledge).toHaveBeenCalledWith('latest-id', hashA, {
      ocrStatus: 'completed', ocrText: 'latest text',
    })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('acknowledges before applying and drops deleted, disabled, or invalidated results', async () => {
    const items = new Map<string, LoadedClipboardItem>()
    const candidate = image('image-1', hashB)
    items.set(candidate.id, candidate)
    let enabled = true
    let resolve: ((value: NativeOcrResult) => void) | undefined
    const recognize = vi.fn(() => new Promise<NativeOcrResult>((done) => { resolve = done }))
    const order: string[] = []
    const coordinator = createOcrCoordinator({
      enabled: () => enabled,
      getItem: (id) => items.get(id),
      recognize,
      fail: vi.fn(),
      acknowledge: () => { order.push('acknowledge'); return true },
      apply: () => { order.push('apply') },
    })

    await coordinator.enqueue(candidate)
    resolve?.({ status: 'applied', ocrStatus: 'completed', ocrText: '' })
    await coordinator.whenIdle()
    expect(order).toEqual(['acknowledge', 'apply'])

    order.length = 0
    items.set(candidate.id, candidate)
    await coordinator.enqueue(candidate)
    enabled = false
    coordinator.invalidate()
    resolve?.({ status: 'applied', ocrStatus: 'completed', ocrText: 'stale' })
    await coordinator.whenIdle()
    expect(order).toEqual([])
  })

  it('resumes only valid pending images and shutdown prevents late application', async () => {
    const pending = image('pending')
    const completed = { ...image('completed', hashB), ocrStatus: 'completed' as const, ocrText: 'done' }
    const text: LoadedClipboardItem = {
      ...pending, id: 'text', kind: 'text', formats: ['text'], imageHash: undefined, ocrStatus: undefined,
    }
    const items = new Map([pending, completed, text].map((item) => [item.id, item]))
    let resolve: ((value: NativeOcrResult) => void) | undefined
    const recognize = vi.fn(() => new Promise<NativeOcrResult>((done) => { resolve = done }))
    const apply = vi.fn()
    const coordinator = createOcrCoordinator({
      enabled: () => true,
      getItem: (id) => items.get(id),
      recognize,
      fail: vi.fn(),
      acknowledge: vi.fn().mockReturnValue(true),
      apply,
    })

    await coordinator.resume([pending, completed, text])
    expect(recognize).toHaveBeenCalledOnce()
    coordinator.shutdown()
    resolve?.({ status: 'applied', ocrStatus: 'completed', ocrText: 'late' })
    await coordinator.whenIdle()
    expect(apply).not.toHaveBeenCalled()
    await expect(coordinator.enqueue(pending)).resolves.toBe('shutdown')
  })

  it('pumps more than one pending page to the tail without exposing payloads or exceeding one recognition', async () => {
    const candidates = Array.from({ length: 19 }, (_, index) => ({
      id: `stored-${index}`,
      imageHash: index.toString(16).padStart(64, '0'),
    }))
    const cursors = [btoa('1784426400000\nstored-7'), btoa('1784426399000\nstored-15')]
    const pages = [
      { items: candidates.slice(0, 8), nextCursor: cursors[0] },
      { items: candidates.slice(8, 16), nextCursor: cursors[1] },
      { items: candidates.slice(16) },
    ]
    let active = 0
    let maximumActive = 0
    const recognize = vi.fn(async (_id: string, _imageHash: string) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { status: 'applied', ocrStatus: 'completed', ocrText: '' } as const
    })
    const acknowledge = vi.fn()
    const apply = vi.fn()
    const coordinator = createOcrCoordinator({
      enabled: () => true,
      getItem: () => undefined,
      recognize,
      fail: vi.fn(),
      acknowledge,
      apply,
    })
    const list = vi.fn(async (cursor?: string) => (
      cursor === undefined ? pages[0] : cursor === cursors[0] ? pages[1] : pages[2]
    ))

    await pumpStoredPendingOcr(coordinator, {
      enabled: () => true,
      current: () => true,
      list,
    })

    expect(recognize.mock.calls.map(([id, hash]) => ({ id, imageHash: hash }))).toEqual(candidates)
    expect(maximumActive).toBe(1)
    expect(list.mock.calls).toEqual([[undefined], [cursors[0]], [cursors[1]]])
    expect(acknowledge).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(coordinator.size()).toBe(0)
  })
})
