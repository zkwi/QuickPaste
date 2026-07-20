import { isSafeExternalUrl } from '../domain/externalLink'

export type SystemInvoker = (command: string, args: Record<string, unknown>) => Promise<unknown>
export type SaveClipboardImageResult = 'saved' | 'cancelled' | 'failed'

const MAX_WINDOWS_PATH_UTF16_UNITS = 32_000
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invokeSystem(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('/') || value.length > MAX_WINDOWS_PATH_UTF16_UNITS) return false
  const path = value
  if (path.startsWith('\\\\?\\')
    || path.startsWith('\\\\.\\')
    || path.startsWith('\\\\??\\')) return false
  if (/^[A-Za-z]:\\/.test(path)) return true
  if (!path.startsWith('\\\\')) return false

  const [server, share] = path.slice(2).split('\\')
  return Boolean(server && share && server !== '.' && server !== '?' && server !== '??')
}

async function runBooleanAction(
  command: string,
  args: Record<string, unknown>,
  invoker?: SystemInvoker,
): Promise<boolean> {
  if (!invoker && !isTauriRuntime()) return false
  try {
    return await (invoker ?? invokeSystem)(command, args) === true
  } catch {
    return false
  }
}

export async function openExternalLink(url: string, invoker?: SystemInvoker): Promise<boolean> {
  if (!isSafeExternalUrl(url)) return false
  return runBooleanAction('open_external_link', { url }, invoker)
}

export async function openFilePath(path: string, invoker?: SystemInvoker): Promise<boolean> {
  if (!isFullyQualifiedWindowsPath(path)) return false
  return runBooleanAction('open_file_path', { path }, invoker)
}

export async function revealFilePath(path: string, invoker?: SystemInvoker): Promise<boolean> {
  if (!isFullyQualifiedWindowsPath(path)) return false
  return runBooleanAction('reveal_file_path', { path }, invoker)
}

export async function saveClipboardImage(
  imageDataUrl: string,
  invoker?: SystemInvoker,
): Promise<SaveClipboardImageResult> {
  if (!imageDataUrl.startsWith(PNG_DATA_URL_PREFIX)) return 'failed'
  if (!invoker && !isTauriRuntime()) return 'failed'

  try {
    const result = await (invoker ?? invokeSystem)('save_clipboard_image', { imageDataUrl })
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return 'failed'
    const keys = Object.keys(result)
    if (keys.length !== 1 || keys[0] !== 'status') return 'failed'
    const status = (result as { status?: unknown }).status
    return status === 'saved' || status === 'cancelled' ? status : 'failed'
  } catch {
    return 'failed'
  }
}
