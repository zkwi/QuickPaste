import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { translate } from './i18n'

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionSourceFiles(path)
    if (!/\.(?:ts|vue)$/.test(entry.name) || /(?:\.test|\.d)\.ts$/.test(entry.name)) return []
    return [path]
  })
}

describe('localized orchestration copy', () => {
  it('exposes the migrated storage, manager, and onboarding messages in both locales', () => {
    expect(translate('zh-CN', 'storageBackupSaved')).toBe('备份已安全保存。')
    expect(translate('en-US', 'storageBackupSaved')).toBe('Backup saved safely.')
    expect(translate('zh-CN', 'ordinaryHistoryCleared', { count: 3 }))
      .toBe('已清除 3 条普通记录，固定内容和永久片段均已保留。')
    expect(translate('en-US', 'ordinaryHistoryCleared', { count: 3 }))
      .toBe('Cleared 3 ordinary records. Pinned items and permanent snippets were kept.')
    expect(translate('zh-CN', 'currentCustomRetentionDays', { count: 45 })).toBe('当前自定义 45 天')
    expect(translate('en-US', 'currentCustomRetentionDays', { count: 45 })).toBe('Current custom value: 45 days')
    expect(translate('zh-CN', 'onboardingSampleContent'))
      .toBe('欢迎使用闪电剪贴板！这是你的第一次快捷粘贴。')
    expect(translate('en-US', 'onboardingSampleContent'))
      .toBe('Welcome to QuickPaste! This is your first quick paste.')
  })

  it('keeps bilingual copy decisions out of production orchestration code', () => {
    const source = productionSourceFiles('src')
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    expect(source).not.toMatch(/locale\.value\s*===\s*['"]zh-CN['"]\s*\?/)
    expect(source).not.toMatch(/locale\s*===\s*['"]zh-CN['"]\s*\?/)
    expect(source).not.toMatch(/\b(?:storageStatus|managerText)\s*\(/)
  })
})
