export type ClipboardWriter = (text: string) => Promise<void>
export type ImageWriter = (dataUrl: string) => Promise<void>
export interface PasteResult {
  copied: boolean
  pasted: boolean
  requiresElevation: boolean
}
export type PasteInvoker = (command: string, args: Record<string, unknown>) => Promise<PasteResult>

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
    return { copied: false, pasted: false, requiresElevation: false }
  }
}

export async function pasteImage(dataUrl: string, invoker?: PasteInvoker): Promise<PasteResult> {
  if (!invoker && !('__TAURI_INTERNALS__' in window)) {
    return { copied: await copyImage(dataUrl), pasted: false, requiresElevation: false }
  }

  try {
    return await (invoker ?? invokePaste)('paste_clipboard_image', { dataUrl })
  } catch {
    return { copied: false, pasted: false, requiresElevation: false }
  }
}
