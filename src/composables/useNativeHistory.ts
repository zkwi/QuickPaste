import { nextTick, ref, type Ref } from 'vue'
import type { ClipboardItem, LoadedClipboardItem } from '../domain/clipboard'
import { historyQueryKey, type HistoryPage, type HistoryQuery } from '../domain/historyQuery'
import { loadNativeClipPayload, queryNativeHistory } from '../platform/history'

export interface NativeQueryDescriptor {
  query: HistoryQuery
  impossible: boolean
}

interface UseNativeHistoryOptions {
  nativeRuntime: boolean
  nativeSettingsReady: Ref<boolean>
  historyState: Ref<'loading' | 'ready' | 'error'>
  items: Ref<ClipboardItem[]>
  currentDescriptor: (cursor?: string) => NativeQueryDescriptor | null
  isFrozen: () => boolean
  flush: () => Promise<boolean>
  isUnmounted: () => boolean
  deferRefresh: (force: boolean) => void
  prepareRefresh: (force: boolean) => boolean | null
  onPayloadsInvalidated: () => void
  onQueryStarted: () => void
  applyPage: (
    page: HistoryPage,
    append: boolean,
    generation: number,
    queryKey: string,
    resolvedUpsertIds: string[],
  ) => Promise<boolean>
}

const HISTORY_RETRY_ATTEMPTS = 3
const HISTORY_RETRY_DELAY_MS = 200
const HISTORY_LOAD_TIMEOUT_MS = 1_400
const NATIVE_SEARCH_DEBOUNCE_MS = 120

export function useNativeHistory(options: UseNativeHistoryOptions) {
  const nextCursor = ref<string | undefined>(undefined)
  const totalCount = ref(options.items.value.length)
  const pageLoading = ref(false)
  const refreshGeneration = ref<number | null>(null)
  const pendingUpserts = new Map<string, ClipboardItem>()
  const hydratedPayloads = new Map<string, { generation: number; item: LoadedClipboardItem }>()
  const pendingPayloadLoads = new Map<string, { generation: number; promise: Promise<LoadedClipboardItem | null> }>()
  let generation = 0
  let appliedQueryKey = ''
  let refreshQueued = false
  let refreshForced = false
  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined

  function invalidatePayloads() {
    options.onPayloadsInvalidated()
    hydratedPayloads.clear()
    pendingPayloadLoads.clear()
  }

  function invalidateQuery() {
    generation += 1
    invalidatePayloads()
    return generation
  }

  function isCurrentGeneration(candidate: number) {
    return candidate === generation
  }

  function cachedPayload(clip: ClipboardItem): LoadedClipboardItem | null {
    if (clip.payloadLoaded !== false) return clip
    if (!options.nativeRuntime) return null
    const cached = hydratedPayloads.get(clip.id)
    return cached?.generation === generation ? cached.item : null
  }

  async function resolvePayload(clip: ClipboardItem): Promise<LoadedClipboardItem | null> {
    const available = cachedPayload(clip)
    if (available) return available

    const requestGeneration = generation
    const pending = pendingPayloadLoads.get(clip.id)
    if (pending?.generation === requestGeneration) return pending.promise
    const promise = (async () => {
      const result = await loadNativeClipPayload(clip.id)
      if (options.isUnmounted()
        || requestGeneration !== generation
        || !options.items.value.some((candidate) => candidate.id === clip.id)) return null
      if (result.status !== 'loaded') return null
      hydratedPayloads.set(clip.id, { generation: requestGeneration, item: result.item })
      return result.item
    })()
    pendingPayloadLoads.set(clip.id, { generation: requestGeneration, promise })
    try {
      return await promise
    } finally {
      const current = pendingPayloadLoads.get(clip.id)
      if (current?.promise === promise) pendingPayloadLoads.delete(clip.id)
    }
  }

  async function queryWithRetry(nativeQuery: HistoryQuery): Promise<HistoryPage | null> {
    for (let attempt = 0; attempt < HISTORY_RETRY_ATTEMPTS; attempt += 1) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), HISTORY_LOAD_TIMEOUT_MS)
      })
      const loaded = await Promise.race([queryNativeHistory(nativeQuery), timedOut])
      if (timeout) clearTimeout(timeout)
      if (loaded !== null) return loaded
      if (attempt < HISTORY_RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, HISTORY_RETRY_DELAY_MS))
      }
    }
    return null
  }

  function applyPageState(page: HistoryPage, queryKey: string) {
    nextCursor.value = page.nextCursor
    totalCount.value = page.totalCount
    appliedQueryKey = queryKey
  }

  async function runQuery(append = false, force = false): Promise<boolean> {
    if (options.isFrozen()) {
      options.deferRefresh(force)
      return false
    }
    const cursor = append ? nextCursor.value : undefined
    const descriptor = options.currentDescriptor(cursor)
    if (!descriptor || append && (!cursor || pageLoading.value)) return false

    const requestedKey = historyQueryKey(descriptor.query)
    if (!append && !force && options.historyState.value === 'ready' && requestedKey === appliedQueryKey) return true
    const requestGeneration = append ? generation : ++generation
    if (!append) {
      refreshGeneration.value = requestGeneration
      invalidatePayloads()
      options.onQueryStarted()
      nextCursor.value = undefined
    } else {
      pageLoading.value = true
    }

    try {
      const flushed = await options.flush()
      if (options.isUnmounted() || requestGeneration !== generation) return false
      const latestDescriptor = options.currentDescriptor()
      if (!latestDescriptor || historyQueryKey(latestDescriptor.query) !== requestedKey || !flushed) return false
      const resolvedUpsertIds = [...pendingUpserts.keys()]
      if (descriptor.impossible) {
        return options.applyPage({ items: [], totalCount: 0 }, false, requestGeneration, requestedKey, resolvedUpsertIds)
      }
      const page = await queryWithRetry(descriptor.query)
      if (options.isUnmounted() || requestGeneration !== generation) return false
      const currentDescriptor = options.currentDescriptor()
      if (!currentDescriptor || historyQueryKey(currentDescriptor.query) !== requestedKey) return false
      if (!page) {
        options.historyState.value = 'error'
        return false
      }
      return options.applyPage(page, append, requestGeneration, requestedKey, resolvedUpsertIds)
    } finally {
      if (append || requestGeneration === generation) pageLoading.value = false
      if (!append && refreshGeneration.value === requestGeneration) refreshGeneration.value = null
    }
  }

  function cancelSearchRefresh() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
    searchDebounceTimer = undefined
  }

  function scheduleSearchRefresh() {
    cancelSearchRefresh()
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = undefined
      queueRefresh()
    }, NATIVE_SEARCH_DEBOUNCE_MS)
  }

  function queueRefresh(force = false) {
    cancelSearchRefresh()
    if (!options.nativeRuntime || !options.nativeSettingsReady.value || options.historyState.value === 'error') return
    const preparedForce = options.prepareRefresh(force)
    if (preparedForce === null) return
    refreshForced ||= preparedForce
    if (refreshQueued) return
    refreshQueued = true
    void nextTick(() => {
      refreshQueued = false
      const shouldForce = refreshForced
      refreshForced = false
      if (!options.isUnmounted()) void runQuery(false, shouldForce)
    })
  }

  return {
    nextCursor,
    totalCount,
    pageLoading,
    refreshGeneration,
    pendingUpserts,
    invalidateQuery,
    isCurrentGeneration,
    cachedPayload,
    resolvePayload,
    queryWithRetry,
    applyPageState,
    runQuery,
    cancelSearchRefresh,
    scheduleSearchRefresh,
    queueRefresh,
  }
}
