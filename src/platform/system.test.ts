import {
  openExternalLink,
  openFilePath,
  revealFilePath,
  saveClipboardImage,
  type SystemInvoker,
} from './system'

describe('system action adapter', () => {
  it('invokes only absolute HTTP(S) links and strictly parses boolean results', async () => {
    const invoker = vi.fn<SystemInvoker>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce('true')

    await expect(openExternalLink('https://example.com/path', invoker)).resolves.toBe(true)
    await expect(openExternalLink('http://localhost:4173', invoker)).resolves.toBe(false)

    for (const invalid of [
      '',
      'example.com',
      '/relative',
      'file:///C:/secret.txt',
      'javascript:alert(1)',
      'https://user@example.com/private',
      'https://user:secret@example.com/private',
      ' https://example.com/',
      'https://example.com/ ',
      'https://example.com/\nnext',
      `https://example.com/${'a'.repeat(8 * 1024)}`,
      'https://example.com/\0bad',
    ]) {
      await expect(openExternalLink(invalid, invoker)).resolves.toBe(false)
    }

    expect(invoker).toHaveBeenNthCalledWith(1, 'open_external_link', { url: 'https://example.com/path' })
    expect(invoker).toHaveBeenNthCalledWith(2, 'open_external_link', { url: 'http://localhost:4173' })
    expect(invoker).toHaveBeenCalledTimes(2)
  })

  it('fast-fails unsafe Windows paths before native open and reveal commands', async () => {
    const invoker = vi.fn<SystemInvoker>().mockResolvedValue(true)

    await expect(openFilePath('C:\\Fixtures\\report.txt', invoker)).resolves.toBe(true)
    await expect(revealFilePath('\\\\server\\share\\folder\\report.txt', invoker)).resolves.toBe(true)

    for (const invalid of [
      '',
      'relative\\report.txt',
      'C:drive-relative.txt',
      '\\root-relative.txt',
      '\\\\?\\C:\\device.txt',
      '\\\\.\\pipe\\name',
      'C:/forward/slash.txt',
      'C:\\bad\0path.txt',
    ]) {
      await expect(openFilePath(invalid, invoker)).resolves.toBe(false)
      await expect(revealFilePath(invalid, invoker)).resolves.toBe(false)
    }

    expect(invoker).toHaveBeenNthCalledWith(1, 'open_file_path', { path: 'C:\\Fixtures\\report.txt' })
    expect(invoker).toHaveBeenNthCalledWith(2, 'reveal_file_path', { path: '\\\\server\\share\\folder\\report.txt' })
    expect(invoker).toHaveBeenCalledTimes(2)
  })

  it('strictly parses image-save status and treats cancellation as a successful no-op', async () => {
    const invoker = vi.fn<SystemInvoker>()
      .mockResolvedValueOnce({ status: 'saved' })
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'failed' })

    const png = 'data:image/png;base64,iVBORw0KGgo='
    await expect(saveClipboardImage(png, invoker)).resolves.toBe('saved')
    await expect(saveClipboardImage(png, invoker)).resolves.toBe('cancelled')
    await expect(saveClipboardImage(png, invoker)).resolves.toBe('failed')
    await expect(saveClipboardImage('data:text/plain;base64,QQ==', invoker)).resolves.toBe('failed')

    expect(invoker).toHaveBeenCalledTimes(3)
    expect(invoker).toHaveBeenNthCalledWith(1, 'save_clipboard_image', { imageDataUrl: png })
  })

  it('uses safe browser and exception fallbacks without reporting success', async () => {
    const invoker = vi.fn<SystemInvoker>().mockRejectedValue(new Error('native unavailable'))

    await expect(openExternalLink('https://example.com', invoker)).resolves.toBe(false)
    await expect(openFilePath('C:\\Fixtures\\report.txt', invoker)).resolves.toBe(false)
    await expect(revealFilePath('C:\\Fixtures\\report.txt', invoker)).resolves.toBe(false)
    await expect(saveClipboardImage('data:image/png;base64,AA==', invoker)).resolves.toBe('failed')

    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    await expect(openExternalLink('https://example.com')).resolves.toBe(false)
    await expect(openFilePath('C:\\Fixtures\\report.txt')).resolves.toBe(false)
    await expect(revealFilePath('C:\\Fixtures\\report.txt')).resolves.toBe(false)
    await expect(saveClipboardImage('data:image/png;base64,AA==')).resolves.toBe('failed')
  })
})
