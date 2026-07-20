import { copyImage, copyText, pasteFiles, pasteFormats, pasteImage, pasteText } from './clipboard'
import type { ClipboardFile } from '../domain/clipboard'

describe('platform clipboard adapter', () => {
  it('returns success after writing text through the platform boundary', async () => {
    let copied = ''
    const result = await copyText('QuickPaste', async (text) => {
      copied = text
    })

    expect(result).toBe(true)
    expect(copied).toBe('QuickPaste')
  })

  it('returns false when the platform refuses clipboard access', async () => {
    const result = await copyText('QuickPaste', async () => {
      throw new Error('denied')
    })

    expect(result).toBe(false)
  })

  it('writes captured image data through the desktop adapter', async () => {
    let copied = ''
    const result = await copyImage('data:image/png;base64,AA==', async (dataUrl) => {
      copied = dataUrl
    })

    expect(result).toBe(true)
    expect(copied).toBe('data:image/png;base64,AA==')
  })

  it('reports whether a desktop text activation was pasted back to the source app', async () => {
    const invoker = vi.fn().mockResolvedValue({ copied: true, pasted: true, requiresElevation: false })

    await expect(pasteText('高频剪贴板', invoker)).resolves.toEqual({ copied: true, pasted: true, requiresElevation: false })
    expect(invoker).toHaveBeenCalledWith('paste_clipboard_text', { text: '高频剪贴板' })
  })

  it('falls back to a copy result when image activation has no source window', async () => {
    const invoker = vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })

    await expect(pasteImage('data:image/png;base64,AA==', invoker)).resolves.toEqual({ copied: true, pasted: false, requiresElevation: false })
    expect(invoker).toHaveBeenCalledWith('paste_clipboard_image', { dataUrl: 'data:image/png;base64,AA==' })
  })

  it('preserves the native reason when an administrator target requires approval', async () => {
    const invoker = vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: true })

    await expect(pasteText('管理员窗口', invoker)).resolves.toEqual({
      copied: true,
      pasted: false,
      requiresElevation: true,
    })
  })

  it('sends rich formats through the preserve command while plain text keeps its existing command', async () => {
    const invoker = vi.fn().mockResolvedValue({ copied: true, pasted: true, requiresElevation: false })

    await pasteFormats('格式化文本', '<b>格式化文本</b>', 'e1xydGYxXGFuc2k=', invoker)
    await pasteText('纯文本', invoker)

    expect(invoker).toHaveBeenNthCalledWith(1, 'paste_clipboard_formats', {
      plainText: '格式化文本',
      html: '<b>格式化文本</b>',
      rtfBase64: 'e1xydGYxXGFuc2k=',
    })
    expect(invoker).toHaveBeenNthCalledWith(2, 'paste_clipboard_text', { text: '纯文本' })
  })

  it('passes only ordered paths to the native file command', async () => {
    const files: ClipboardFile[] = [
      { path: 'C:\\Fixtures\\first.txt', name: 'first.txt', size: 12, directory: false, exists: true },
      { path: 'C:\\Fixtures\\folder', name: 'folder', directory: true, exists: false },
    ]
    const invoker = vi.fn().mockResolvedValue({ copied: true, pasted: false, requiresElevation: false })

    await expect(pasteFiles(files, invoker)).resolves.toEqual({
      copied: true,
      pasted: false,
      requiresElevation: false,
    })
    expect(invoker).toHaveBeenCalledWith('paste_clipboard_files', {
      paths: ['C:\\Fixtures\\first.txt', 'C:\\Fixtures\\folder'],
    })
  })

  it('rejects empty, NUL-containing, and oversized file lists before invoking native code', async () => {
    const invoker = vi.fn()
    const tooMany = Array.from({ length: 257 }, (_, index) => `C:\\Fixtures\\${index}.txt`)
    const aggregate = Array.from({ length: 129 }, () => `C:\\${'a'.repeat(32_760)}`)

    for (const invalid of [
      [],
      ['   '],
      ['C:\\bad\0path'],
      ['relative\\file.txt'],
      ['C:drive-relative.txt'],
      ['\\root-relative.txt'],
      ['\\\\?\\C:\\device.txt'],
      [`C:\\${'a'.repeat(32_767)}`],
      tooMany,
      aggregate,
    ]) {
      await expect(pasteFiles(invalid, invoker)).resolves.toEqual({
        copied: false,
        pasted: false,
        requiresElevation: false,
      })
    }
    await expect(pasteFiles([null] as never[], invoker)).resolves.toEqual({
      copied: false,
      pasted: false,
      requiresElevation: false,
    })
    expect(invoker).not.toHaveBeenCalled()
  })

  it('degrades preserve mode to browser plain text and explicitly rejects browser file paste', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    await expect(pasteFormats('浏览器纯文本', '<b>忽略格式</b>')).resolves.toEqual({
      copied: true,
      pasted: false,
      requiresElevation: false,
    })
    await expect(pasteFiles(['C:\\Fixtures\\browser.txt'])).resolves.toEqual({
      copied: false,
      pasted: false,
      requiresElevation: false,
    })
    expect(writeText).toHaveBeenCalledWith('浏览器纯文本')
  })

  it('normalizes preserve and file invoker exceptions to the standard failure result', async () => {
    const invoker = vi.fn().mockRejectedValue(new Error('native unavailable'))

    await expect(pasteFormats('文本', '<b>文本</b>', undefined, invoker)).resolves.toEqual({
      copied: false,
      pasted: false,
      requiresElevation: false,
    })
    await expect(pasteFiles(['C:\\Fixtures\\one.txt'], invoker)).resolves.toEqual({
      copied: false,
      pasted: false,
      requiresElevation: false,
    })
  })
})
