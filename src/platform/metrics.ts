import { isTauriRuntime } from './desktop'

export type NativeMetricsInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>

async function invokeThroughTauri(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

export async function acknowledgeQuickPanelFirstFrame(
  sessionId: number,
  invokeAdapter?: NativeMetricsInvoke,
): Promise<boolean> {
  if (!Number.isSafeInteger(sessionId)
    || sessionId <= 0
    || (!invokeAdapter && !isTauriRuntime())) return false

  try {
    const acknowledged = await (invokeAdapter ?? invokeThroughTauri)(
      'record_quick_panel_first_frame',
      { sessionId },
    )
    return acknowledged === true
  } catch {
    // 验收指标永远不能影响面板显示或焦点。
    return false
  }
}
