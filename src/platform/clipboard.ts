import type { ClipboardFile } from '../domain/clipboard'

export type ClipboardWriter = (text: string) => Promise<void>
export type ImageWriter = (dataUrl: string) => Promise<void>
export interface PasteResult {
  copied: boolean
  pasted: boolean
  requiresElevation: boolean
  panelHidden?: boolean
  clipboardChanged?: boolean
}
export type PasteInvoker = (command: string, args: Record<string, unknown>) => Promise<PasteResult>

const FAILED_PASTE_RESULT: PasteResult = {
  copied: false,
  pasted: false,
  requiresElevation: false,
}
const MAX_CLIPBOARD_FILES = 256
const MAX_FILE_PATH_UTF16_UNITS = 32_766
const MAX_FILE_LIST_BYTES = 8 * 1024 * 1024
const DROPFILES_HEADER_BYTES = 20

function isFullyQualifiedWindowsPath(path: string): boolean {
  const normalized = path.replaceAll('/', '\\')
  if (normalized.startsWith('\\\\?\\')
    || normalized.startsWith('\\\\.\\')
    || normalized.startsWith('\\\\??\\')) return false
  if (/^[A-Za-z]:\\/.test(normalized)) return true
  if (!normalized.startsWith('\\\\')) return false

  const [server, share] = normalized.slice(2).split('\\')
  return Boolean(server && share && server !== '.' && server !== '?' && server !== '??')
}

async function writeTextThroughTauri(text: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('write_clipboard_text', { text })
}

export async function copyText(text: string, writer?: ClipboardWriter): Promise<boolean> {
  const resolvedWriter = writer
    ?? ('__TAURI_INTERNALS__' in window
      ? writeTextThroughTauri
      : navigator.clipboard?.writeText.bind(navigator.clipboard))
  if (!resolvedWriter) return false

  try {
    await resolvedWriter(text)
    return true
  } catch {
    return false
  }
}

async function writeImageThroughTauri(dataUrl: string): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('desktop runtime unavailable')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('write_clipboard_image', { dataUrl })
}

export async function copyImage(dataUrl: string, writer?: ImageWriter): Promise<boolean> {
  try {
    await (writer ?? writeImageThroughTauri)(dataUrl)
    return true
  } catch {
    return false
  }
}

async function invokePaste(command: string, args: Record<string, unknown>): Promise<PasteResult> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<PasteResult>(command, args)
}

export async function pasteText(text: string, invoker?: PasteInvoker): Promise<PasteResult> {
  if (!invoker && !('__TAURI_INTERNALS__' in window)) {
    return { copied: await copyText(text), pasted: false, requiresElevation: false }
  }

  try {
    return await (invoker ?? invokePaste)('paste_clipboard_text', { text })
  } catch {
    return FAILED_PASTE_RESULT
  }
}

export async function pasteFormats(
  plainText: string,
  html?: string,
  rtfBase64?: string,
  invoker?: PasteInvoker,
): Promise<PasteResult> {
  if (!invoker && !('__TAURI_INTERNALS__' in window)) {
    return { copied: await copyText(plainText), pasted: false, requiresElevation: false }
  }

  try {
    return await (invoker ?? invokePaste)('paste_clipboard_formats', {
      plainText,
      html,
      rtfBase64,
    })
  } catch {
    return FAILED_PASTE_RESULT
  }
}

function clipboardFilePaths(filesOrPaths: readonly (ClipboardFile | string)[]): string[] | null {
  const paths: string[] = []
  for (const file of filesOrPaths) {
    if (typeof file === 'string') {
      paths.push(file)
    } else if (file && typeof file.path === 'string') {
      paths.push(file.path)
    } else {
      return null
    }
  }
  if (paths.length === 0
    || paths.length > MAX_CLIPBOARD_FILES
    || paths.some((path) => path.trim().length === 0
      || path.includes('\0')
      || path.length > MAX_FILE_PATH_UTF16_UNITS
      || !isFullyQualifiedWindowsPath(path))) {
    return null
  }
  const fileListBytes = paths.reduce(
    (total, path) => total + ((path.length + 1) * 2),
    DROPFILES_HEADER_BYTES + 2,
  )
  if (!Number.isSafeInteger(fileListBytes) || fileListBytes > MAX_FILE_LIST_BYTES) {
    return null
  }
  return paths
}

export async function copyFiles(files: readonly ClipboardFile[]): Promise<'copied' | 'missing' | 'failed'> {
  if (!files.length || files.some((file) => !file.exists)) return 'missing'
  const paths = clipboardFilePaths(files)
  if (!paths || !('__TAURI_INTERNALS__' in window)) return 'failed'
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_clipboard_files', { paths })
    return 'copied'
  } catch (error) {
    return error === 'file_copy_source_missing' ? 'missing' : 'failed'
  }
}

export async function copyFormats(plainText: string, html?: string, rtfBase64?: string): Promise<boolean> {
  if (!('__TAURI_INTERNALS__' in window)) return copyText(plainText)
  try {
    await invokePaste('write_clipboard_formats', { plainText, html, rtfBase64 })
    return true
  } catch {
    return false
  }
}

export async function pasteFiles(
  filesOrPaths: readonly (ClipboardFile | string)[],
  invoker?: PasteInvoker,
): Promise<PasteResult> {
  const paths = clipboardFilePaths(filesOrPaths)
  if (!paths) return FAILED_PASTE_RESULT
  // 浏览器没有可移植的 CF_HDROP 写入能力，必须明确失败，不能伪造已复制。
  if (!invoker && !('__TAURI_INTERNALS__' in window)) return FAILED_PASTE_RESULT

  try {
    return await (invoker ?? invokePaste)('paste_clipboard_files', { paths })
  } catch {
    return FAILED_PASTE_RESULT
  }
}

export async function pasteImage(dataUrl: string, invoker?: PasteInvoker): Promise<PasteResult> {
  if (!invoker && !('__TAURI_INTERNALS__' in window)) {
    return { copied: await copyImage(dataUrl), pasted: false, requiresElevation: false }
  }

  try {
    return await (invoker ?? invokePaste)('paste_clipboard_image', { dataUrl })
  } catch {
    return FAILED_PASTE_RESULT
  }
}
