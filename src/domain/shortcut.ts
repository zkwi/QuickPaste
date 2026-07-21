export const DEFAULT_GLOBAL_SHORTCUT = 'Ctrl+Shift+V'

export type ShortcutConflict = 'plainTextPaste' | 'pasteSpecial'

const FAMILIAR_SHORTCUT_CONFLICTS: Readonly<Record<string, ShortcutConflict>> = {
  'Ctrl+Alt+V': 'pasteSpecial',
  'Ctrl+Shift+V': 'plainTextPaste',
}

const MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
])

const NAMED_CODES = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backquote',
  'Backslash',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Delete',
  'End',
  'Equal',
  'Home',
  'Insert',
  'Minus',
  'PageDown',
  'PageUp',
  'Period',
  'Quote',
  'Semicolon',
  'Slash',
  'Space',
  'Tab',
])

const RESERVED_SHORTCUTS = new Set([
  'Alt+Escape',
  'Alt+F4',
  'Alt+Space',
  'Alt+Tab',
  'Ctrl+Alt+Delete',
  'Ctrl+Escape',
  'Ctrl+Shift+Escape',
])

function keyFromCode(code: string): string | null {
  if (MODIFIER_CODES.has(code)) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code
  return NAMED_CODES.has(code) ? code : null
}

export function captureShortcut(event: Pick<KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>): string | null {
  if (event.metaKey) return null
  if (!event.ctrlKey && !event.altKey) return null
  const modifierCount = Number(event.ctrlKey) + Number(event.altKey) + Number(event.shiftKey)
  if (modifierCount < 2) return null

  const key = keyFromCode(event.code)
  if (!key) return null

  const parts = [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    key,
  ].filter(Boolean)
  const shortcut = parts.join('+')
  return RESERVED_SHORTCUTS.has(shortcut) ? null : shortcut
}

export function displayShortcut(shortcut: string): string {
  return shortcut.split('+').join(' + ')
}

export function shortcutConflict(shortcut: string): ShortcutConflict | null {
  return FAMILIAR_SHORTCUT_CONFLICTS[shortcut] ?? null
}
