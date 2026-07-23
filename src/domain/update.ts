export const OFFICIAL_RELEASES_URL = 'https://github.com/zkwi/QuickPaste/releases'

export type UpdateFailureKind = 'timeout' | 'unreachable' | 'generic'

function readableFailureText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  }
  return ''
}

export function classifyUpdateFailure(error: unknown): UpdateFailureKind {
  const message = readableFailureText(error).toLocaleLowerCase()
  if (/\b(?:timed?\s*out|etimedout)\b|超时/.test(message)) return 'timeout'
  if (/network\s+is\s+unreachable|could\s+not\s+resolve|failed\s+to\s+(?:connect|lookup)|connection\s+(?:refused|reset)|dns|无法连接|网络不可用|主机不可达|请检查网络、代理或防火墙设置/.test(message)) {
    return 'unreachable'
  }
  return 'generic'
}

export function shouldAutoCheckUpdate(
  _lastCheckedAt: number | null,
  now = Date.now(),
  lastCheckedLocalDate: string | null = null,
): boolean {
  const currentLocalDate = updateCheckLocalDateKey(now)
  if (currentLocalDate === null) return true
  // 旧版本只有时间戳，无法还原记录当时的时区；安全地多检查一次并写入日期键。
  return lastCheckedLocalDate === null || lastCheckedLocalDate !== currentLocalDate
}

export function updateCheckLocalDateKey(value = Date.now()): string | null {
  if (!Number.isFinite(value)) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatUpdateSize(bytes: number | undefined): string {
  if (!bytes || bytes < 0 || !Number.isFinite(bytes)) return bytes === 0 ? '0 MB' : '—'
  const megabytes = bytes / (1024 * 1024)
  return `${Number(megabytes.toFixed(megabytes >= 10 ? 0 : 1))} MB`
}
