import { describe, expect, it } from 'vitest'
import { formatUpdateSize, shouldAutoCheckUpdate } from './update'

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
})
