import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_RELEASES_URL,
  classifyUpdateFailure,
  formatUpdateSize,
  shouldAutoCheckUpdate,
} from './update'

describe('update domain rules', () => {
  it('limits automatic checks to once every 24 hours', () => {
    const now = Date.parse('2026-07-19T12:00:00Z')

    expect(shouldAutoCheckUpdate(null, now)).toBe(true)
    expect(shouldAutoCheckUpdate(now - 23 * 60 * 60 * 1_000, now)).toBe(false)
    expect(shouldAutoCheckUpdate(now - 24 * 60 * 60 * 1_000, now)).toBe(true)
    expect(shouldAutoCheckUpdate(now + 60_000, now)).toBe(true)
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
