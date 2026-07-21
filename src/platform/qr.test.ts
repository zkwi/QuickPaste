import { detectNativeClipQr, type QrInvoke } from './qr'

describe('native QR adapter', () => {
  it('requests one history image and returns a cloned canonical result list', async () => {
    const raw = ['https://quickpaste.example/docs', '本地二维码文字']
    const invoke: QrInvoke = vi.fn().mockResolvedValue(raw)

    const result = await detectNativeClipQr('image-1', invoke)

    expect(invoke).toHaveBeenCalledWith('detect_clip_qr', { id: 'image-1' })
    expect(result).toEqual(raw)
    expect(result).not.toBe(raw)
  })

  it('rejects invalid ids and malformed native responses', async () => {
    const invoke: QrInvoke = vi.fn().mockResolvedValue([])
    await expect(detectNativeClipQr(' bad-id', invoke)).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    for (const response of [
      null,
      [''],
      ['duplicate', 'duplicate'],
      ['contains\0nul'],
      Array.from({ length: 9 }, (_, index) => `result-${index}`),
      ['x'.repeat(16_385)],
      [42],
    ]) {
      const malformed: QrInvoke = vi.fn().mockResolvedValue(response)
      await expect(detectNativeClipQr('image-1', malformed)).resolves.toBeNull()
    }
  })

  it('returns null outside Tauri and when the command fails', async () => {
    await expect(detectNativeClipQr('image-1')).resolves.toBeNull()
    const rejected: QrInvoke = vi.fn().mockRejectedValue(new Error('unavailable'))
    await expect(detectNativeClipQr('image-1', rejected)).resolves.toBeNull()
  })
})
