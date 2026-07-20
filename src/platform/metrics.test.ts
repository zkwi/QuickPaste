import {
  acknowledgeQuickPanelFirstFrame,
  type NativeMetricsInvoke,
} from './metrics'

describe('local acceptance metrics boundary', () => {
  it('acknowledges a positive safe session id through a content-free command', async () => {
    const invoke: NativeMetricsInvoke = vi.fn().mockResolvedValue(true)

    await expect(acknowledgeQuickPanelFirstFrame(17, invoke)).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith('record_quick_panel_first_frame', {
      sessionId: 17,
    })
  })

  it.each([false, undefined, null, {}, 1])(
    'treats a non-true native acknowledgement %j as rejected',
    async (nativeResult) => {
      const invoke: NativeMetricsInvoke = vi.fn().mockResolvedValue(nativeResult)

      await expect(acknowledgeQuickPanelFirstFrame(17, invoke)).resolves.toBe(false)
    },
  )

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid session id %s without native work',
    async (sessionId) => {
      const invoke: NativeMetricsInvoke = vi.fn()

      await expect(acknowledgeQuickPanelFirstFrame(sessionId, invoke)).resolves.toBe(false)
      expect(invoke).not.toHaveBeenCalled()
    },
  )

  it('fails closed without throwing into the quick-panel lifecycle', async () => {
    const invoke: NativeMetricsInvoke = vi.fn().mockRejectedValue(new Error('disabled'))

    await expect(acknowledgeQuickPanelFirstFrame(4, invoke)).resolves.toBe(false)
  })
})
