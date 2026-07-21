import { captureShortcut, displayShortcut, shortcutConflict } from './shortcut'

function keyboardInput(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    code: '',
    ctrlKey: false,
    key: '',
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent
}

describe('global shortcut recording', () => {
  it('records a stable Windows shortcut in modifier order', () => {
    expect(captureShortcut(keyboardInput({
      ctrlKey: true,
      shiftKey: true,
      code: 'KeyK',
      key: 'k',
    }))).toBe('Ctrl+Shift+K')
  })

  it('formats accepted shortcuts for compact UI', () => {
    const shortcut = captureShortcut(keyboardInput({ altKey: true, ctrlKey: true, code: 'KeyK', key: 'k' }))

    expect(shortcut).toBe('Ctrl+Alt+K')
    expect(displayShortcut(shortcut ?? '')).toBe('Ctrl + Alt + K')
  })

  it('rejects modifier-only, unmodified and Windows-reserved combinations', () => {
    expect(captureShortcut(keyboardInput({ ctrlKey: true, code: 'ControlLeft', key: 'Control' }))).toBeNull()
    expect(captureShortcut(keyboardInput({ shiftKey: true, code: 'KeyV', key: 'V' }))).toBeNull()
    expect(captureShortcut(keyboardInput({ altKey: true, code: 'F4', key: 'F4' }))).toBeNull()
  })

  it('does not allow a global shortcut to hijack common one-modifier editing keys', () => {
    expect(captureShortcut(keyboardInput({ ctrlKey: true, code: 'KeyC', key: 'c' }))).toBeNull()
    expect(captureShortcut(keyboardInput({ ctrlKey: true, code: 'KeyV', key: 'v' }))).toBeNull()
    expect(captureShortcut(keyboardInput({ altKey: true, code: 'KeyV', key: 'v' }))).toBeNull()
    expect(captureShortcut(keyboardInput({ ctrlKey: true, shiftKey: true, code: 'KeyC', key: 'c' }))).toBe('Ctrl+Shift+C')
  })

  it.each([
    { altKey: true, code: 'Space' },
    { altKey: true, code: 'Tab' },
    { altKey: true, code: 'Escape' },
    { ctrlKey: true, code: 'Escape' },
    { ctrlKey: true, shiftKey: true, code: 'Escape' },
  ])('rejects Windows shell shortcut $code', (input) => {
    expect(captureShortcut(keyboardInput(input))).toBeNull()
  })

  it('identifies familiar Windows and Office paste shortcut conflicts', () => {
    expect(shortcutConflict('Ctrl+Shift+V')).toBe('plainTextPaste')
    expect(shortcutConflict('Ctrl+Alt+V')).toBe('pasteSpecial')
    expect(shortcutConflict('Ctrl+Shift+K')).toBeNull()
  })
})
