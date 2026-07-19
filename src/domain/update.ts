export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000

export function shouldAutoCheckUpdate(
  lastCheckedAt: number | null,
  now = Date.now(),
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt)) return true
  const elapsed = now - lastCheckedAt
  return elapsed < 0 || elapsed >= intervalMs
}

export function formatUpdateSize(bytes: number | undefined): string {
  if (!bytes || bytes < 0 || !Number.isFinite(bytes)) return bytes === 0 ? '0 MB' : '—'
  const megabytes = bytes / (1024 * 1024)
  return `${Number(megabytes.toFixed(megabytes >= 10 ? 0 : 1))} MB`
}
