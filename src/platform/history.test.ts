import type { ClipboardItem } from '../domain/clipboard'
import { createHistoryPersistence, loadNativeHistory, saveNativeHistory, type HistoryInvoke } from './history'

const history: ClipboardItem[] = [{
  id: 'clip-1',
  kind: 'text',
  title: '本地历史',
  content: '持久化内容',
  sourceApp: 'Notepad',
  copiedAt: '2026-07-18T09:00:00.000Z',
  pinned: false,
  searchTerms: [],
}]

describe('native clipboard history storage', () => {
  it('loads history through the Tauri command boundary', async () => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(history)

    await expect(loadNativeHistory(invoke)).resolves.toEqual(history)
    expect(invoke).toHaveBeenCalledWith('load_clipboard_history', {})
  })

  it('distinguishes an empty native history from a load failure', async () => {
    const emptyInvoke: HistoryInvoke = vi.fn().mockResolvedValue([])
    const failingInvoke: HistoryInvoke = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const malformedInvoke: HistoryInvoke = vi.fn().mockResolvedValue({ unexpected: true })

    await expect(loadNativeHistory(emptyInvoke)).resolves.toEqual([])
    await expect(loadNativeHistory(failingInvoke)).resolves.toBeNull()
    await expect(loadNativeHistory(malformedInvoke)).resolves.toBeNull()
  })

  it('validates native records and migrates a missing legacy search-term list', async () => {
    const malformedInvoke: HistoryInvoke = vi.fn().mockResolvedValue([
      { ...history[0], searchTerms: ['valid', 42] },
    ])
    const [{ searchTerms: _searchTerms, ...legacyRecord }] = history
    const legacyInvoke: HistoryInvoke = vi.fn().mockResolvedValue([legacyRecord])

    await expect(loadNativeHistory(malformedInvoke)).resolves.toBeNull()
    await expect(loadNativeHistory(legacyInvoke)).resolves.toEqual([
      { ...legacyRecord, searchTerms: [] },
    ])
  })

  it('saves the full ordered history through the Tauri command boundary', async () => {
    const invoke: HistoryInvoke = vi.fn().mockResolvedValue(undefined)

    await expect(saveNativeHistory(history, invoke)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('save_clipboard_history', { items: history })
  })

  it('flushes a pending debounce immediately and retains dirty state after failure', async () => {
    vi.useFakeTimers()
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const onSaveFailed = vi.fn()
    const persistence = createHistoryPersistence(save, { delayMs: 180, onSaveFailed })
    persistence.schedule(history)

    await expect(persistence.flush()).resolves.toBe(false)
    expect(save).toHaveBeenCalledWith(history)
    expect(persistence.isDirty()).toBe(true)
    expect(onSaveFailed).toHaveBeenCalledOnce()

    await expect(persistence.flush()).resolves.toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect(persistence.isDirty()).toBe(false)
    vi.useRealTimers()
  })

  it('saves a newer mutation that arrives while an earlier flush is in flight', async () => {
    let finishFirst: ((saved: boolean) => void) | undefined
    const newerHistory = [{ ...history[0], pinned: true }]
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce(true)
    const persistence = createHistoryPersistence(save)
    persistence.schedule(history)
    const flushing = persistence.flush()
    persistence.schedule(newerHistory)
    finishFirst?.(true)

    await expect(flushing).resolves.toBe(true)
    expect(save.mock.calls).toEqual([[history], [newerHistory]])
  })
})
