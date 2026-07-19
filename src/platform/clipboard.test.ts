import { copyImage, copyText, pasteImage, pasteText } from './clipboard'

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
})
