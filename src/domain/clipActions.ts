import type { ClipboardItem, ClipboardFormat } from './clipboard'
import { isSafeExternalUrl } from './externalLink'

export type ClipSurface = 'quick' | 'manager'
export type PasteMode = 'preserve' | 'plain' | 'files' | 'image'
export type ClipActionId = 'paste' | 'paste-preserve' | 'paste-plain' | 'copy' | 'open-link' | 'open-file' | 'reveal-file' | 'save-image'

export interface ClipAction {
  id: ClipActionId
  pasteMode?: PasteMode
  disabled?: boolean
}

function availableFormats(clip: ClipboardItem): ClipboardFormat[] {
  if (clip.formats) return clip.formats
  return clip.kind === 'image' ? ['image'] : clip.kind === 'file' ? ['files'] : ['text']
}

export function defaultPasteMode(clip: ClipboardItem): PasteMode {
  const formats = availableFormats(clip)
  if (clip.kind === 'file' && formats.includes('files')) return 'files'
  if (clip.kind === 'image' && formats.includes('image')) return 'image'
  return formats.includes('html') || formats.includes('rtf') ? 'preserve' : 'plain'
}

function hasCompleteFileGroup(clip: ClipboardItem): boolean {
  return Boolean(clip.files?.length && clip.files.every((file) => file.exists))
}

function hasAvailableFile(clip: ClipboardItem): boolean {
  return Boolean(clip.files?.some((file) => file.exists))
}

export function getClipActions(clip: ClipboardItem, surface: ClipSurface): ClipAction[] {
  const mode = defaultPasteMode(clip)
  const actions: ClipAction[] = mode === 'preserve'
    ? [{ id: 'paste-preserve', pasteMode: 'preserve' }, { id: 'paste-plain', pasteMode: 'plain' }]
    : [{
        id: 'paste',
        pasteMode: mode,
        ...(mode === 'files' && !hasCompleteFileGroup(clip)
          || mode === 'image' && clip.payloadLoaded !== false && !clip.imageUrl
          ? { disabled: true }
          : {}),
      }]

  if (surface === 'quick') return actions

  actions.push({ id: 'copy' })
  if (clip.kind === 'link') actions.push({
    id: 'open-link',
    disabled: clip.payloadLoaded !== false && !isSafeExternalUrl(clip.content),
  })
  if (clip.kind === 'file') {
    const disabled = !hasAvailableFile(clip)
    actions.push({ id: 'open-file', disabled }, { id: 'reveal-file', disabled })
  }
  if (clip.kind === 'image') actions.push({
    id: 'save-image',
    disabled: clip.payloadLoaded !== false && !clip.imageUrl,
  })
  return actions
}
