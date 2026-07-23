import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_RELEASES_URL,
  classifyUpdateFailure,
  formatUpdateSize,
  shouldAutoCheckUpdate,
} from './update'

describe('update domain rules', () => {
  it('limits automatic checks to the first launch of each local calendar day', () => {
    const todayEarly = new Date(2026, 6, 23, 0, 1).getTime()
    const todayLate = new Date(2026, 6, 23, 23, 59).getTime()
    const yesterdayLate = new Date(2026, 6, 22, 23, 59).getTime()
    const tomorrowEarly = new Date(2026, 6, 24, 0, 1).getTime()

    expect(shouldAutoCheckUpdate(null, todayEarly)).toBe(true)
    expect(shouldAutoCheckUpdate(Number.NaN, todayEarly)).toBe(true)
    expect(shouldAutoCheckUpdate(todayEarly, todayLate, '2026-07-23')).toBe(false)
    expect(shouldAutoCheckUpdate(todayEarly, todayLate)).toBe(true)
    expect(shouldAutoCheckUpdate(yesterdayLate, todayEarly)).toBe(true)
    expect(shouldAutoCheckUpdate(tomorrowEarly, todayEarly)).toBe(true)
    expect(shouldAutoCheckUpdate(
      new Date(2026, 6, 23, 0, 30).getTime(),
      new Date(2026, 6, 23, 0, 45).getTime(),
      '2026-07-22',
    )).toBe(true)
  })

  it('formats installer sizes without implying excessive precision', () => {
    expect(formatUpdateSize(0)).toBe('0 MB')
    expect(formatUpdateSize(1_572_864)).toBe('1.5 MB')
    expect(formatUpdateSize(undefined)).toBe('—')
  })

  it.each([
    [new Error('operation timed out after 30s'), 'timeout'],
    ['请求超时，请稍后重试', 'timeout'],
    [new Error('network is unreachable'), 'unreachable'],
    [{ message: 'Could not resolve host: api.github.com' }, 'unreachable'],
  ])('classifies recoverable updater network failures', (error, expected) => {
    expect(classifyUpdateFailure(error)).toBe(expected)
  })

  it.each([
    '连接 GitHub 更新服务失败：请检查网络、代理或防火墙设置。',
    '下载安装包失败：请检查网络、代理或防火墙设置。',
  ])('classifies the native updater network guidance as unreachable: %s', (message) => {
    expect(classifyUpdateFailure(new Error(message))).toBe('unreachable')
  })

  it('falls back to a generic updater failure without exposing arbitrary values', () => {
    expect(classifyUpdateFailure(new Error('invalid release signature'))).toBe('generic')
    expect(classifyUpdateFailure(new Error('下载安装包失败，HTTP 404。'))).toBe('generic')
    expect(classifyUpdateFailure({ secret: 'do not render' })).toBe('generic')
  })

  it('keeps the official project releases page as the single escape-hatch URL', () => {
    expect(OFFICIAL_RELEASES_URL).toBe('https://github.com/zkwi/QuickPaste/releases')
  })
})
