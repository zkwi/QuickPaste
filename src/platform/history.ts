import { parseClipboardItems, type ClipboardItem } from '../domain/clipboard'
import { isTauriRuntime } from './desktop'

export type HistoryInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

async function invokeThroughTauri(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

export async function loadNativeHistory(invokeAdapter?: HistoryInvoke): Promise<ClipboardItem[] | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null

  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('load_clipboard_history', {})
    return parseClipboardItems(result)
  } catch {
    return null
  }
}

export async function saveNativeHistory(
  items: ClipboardItem[],
  invokeAdapter?: HistoryInvoke,
): Promise<boolean> {
  if (!invokeAdapter && !isTauriRuntime()) return false

  try {
    await (invokeAdapter ?? invokeThroughTauri)('save_clipboard_history', { items })
    return true
  } catch {
    return false
  }
}

export interface HistoryPersistence {
  schedule: (items: ClipboardItem[]) => void
  flush: () => Promise<boolean>
  isDirty: () => boolean
  cancel: () => void
}

export function createHistoryPersistence(
  save: (items: ClipboardItem[]) => Promise<boolean>,
  options: { delayMs?: number; onSaveFailed?: () => void } = {},
): HistoryPersistence {
  const delayMs = options.delayMs ?? 180
  let latestItems: ClipboardItem[] = []
  let dirty = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingFlush: Promise<boolean> | null = null

  const clearTimer = () => {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = undefined
  }

  const flush = async (): Promise<boolean> => {
    clearTimer()
    if (pendingFlush) return pendingFlush
    if (!dirty) return true

    pendingFlush = (async () => {
      while (dirty) {
        dirty = false
        const snapshot = [...latestItems]
        if (!await save(snapshot)) {
          dirty = true
          options.onSaveFailed?.()
          return false
        }
      }
      return true
    })()

    try {
      return await pendingFlush
    } finally {
      pendingFlush = null
    }
  }

  return {
    schedule(items) {
      latestItems = [...items]
      dirty = true
      clearTimer()
      saveTimer = setTimeout(() => { void flush() }, delayMs)
    },
    flush,
    isDirty: () => dirty,
    cancel: clearTimer,
  }
}
