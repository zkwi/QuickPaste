import { isValidClipboardItemId } from '../domain/clipboard'
import { isTauriRuntime } from './desktop'

const MAX_QR_RESULTS = 8
const MAX_QR_TEXT_BYTES = 16 * 1024

export type QrInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

async function invokeThroughTauri(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

function parseQrResults(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_QR_RESULTS) return null
  const seen = new Set<string>()
  const results: string[] = []
  for (const item of value) {
    if (typeof item !== 'string'
      || !item.trim()
      || item.includes('\0')
      || new TextEncoder().encode(item).length > MAX_QR_TEXT_BYTES
      || seen.has(item)) return null
    seen.add(item)
    results.push(item)
  }
  return results
}

export async function detectNativeClipQr(
  id: string,
  invokeAdapter?: QrInvoke,
): Promise<string[] | null> {
  if (!isValidClipboardItemId(id) || (!invokeAdapter && !isTauriRuntime())) return null
  try {
    return parseQrResults(await (invokeAdapter ?? invokeThroughTauri)('detect_clip_qr', { id }))
  } catch {
    return null
  }
}
