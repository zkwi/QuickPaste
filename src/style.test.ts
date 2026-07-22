import { readFileSync } from 'node:fs'

const styles = readFileSync('src/style.css', 'utf8')
const testingGuide = readFileSync('docs/testing.md', 'utf8')
const securityPolicy = readFileSync('SECURITY.md', 'utf8')

type DensityVariant = 'standard' | 'compact'

function quickPanelMetric(name: string, variant: DensityVariant): number {
  const values = [...styles.matchAll(new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`, 'g'))]
    .map((match) => Number(match[1]))
  if (!values.length) throw new Error(`Missing quick-panel metric: ${name}`)
  return variant === 'standard' ? values[0] : values.at(-1)!
}

function visibleClipRows(shellHeight: number, variant: DensityVariant): number {
  const fixedHeight = [
    '--quick-chrome-height',
    '--quick-search-area-height',
    '--quick-filter-height',
  ].reduce((total, name) => total + quickPanelMetric(name, variant), 0)
  const listPadding = quickPanelMetric('--quick-list-padding-block', variant) * 2
  const rowHeight = quickPanelMetric('--quick-row-height', variant)
  const rowGap = quickPanelMetric('--quick-row-gap', variant)
  const availableHeight = shellHeight - fixedHeight - listPadding
  return Math.floor((availableHeight + rowGap) / (rowHeight + rowGap))
}

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  if (!match) throw new Error(`Missing CSS rule: ${selector}`)
  return match[1]
}

describe('quick-panel density contract', () => {
  it('makes every transition and keyframe immediate when reduced motion is requested', () => {
    const reducedMotion = styles.match(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/,
    )?.[1]

    expect(reducedMotion).toBeDefined()
    expect(reducedMotion).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/)
    expect(reducedMotion).toMatch(/scroll-behavior:\s*auto\s*!important/)
    expect(reducedMotion).toMatch(/transition-duration:\s*0s\s*!important/)
    expect(reducedMotion).toMatch(/transition-delay:\s*0s\s*!important/)
    expect(reducedMotion).toMatch(/animation-duration:\s*0s\s*!important/)
    expect(reducedMotion).toMatch(/animation-delay:\s*0s\s*!important/)
    expect(reducedMotion).toMatch(/animation-iteration-count:\s*1\s*!important/)
  })

  it('shows at least eight readable clips with the documented standard row height', () => {
    const rowHeight = quickPanelMetric('--quick-row-height', 'standard')

    expect(rowHeight).toBe(44)
    expect(quickPanelMetric('--quick-search-control-height', 'standard')).toBeGreaterThanOrEqual(32)
    expect(visibleClipRows(quickPanelMetric('--quick-shell-height', 'standard'), 'standard')).toBeGreaterThanOrEqual(8)
    expect(testingGuide).toContain('标准行高不低于 44px')
  })

  it('keeps six readable clips with the documented compact row height', () => {
    const compactVisibleShellHeight = 440 - 2 * 16

    expect(quickPanelMetric('--quick-row-height', 'compact')).toBe(40)
    expect(quickPanelMetric('--quick-search-control-height', 'compact')).toBeGreaterThanOrEqual(32)
    expect(visibleClipRows(compactVisibleShellHeight, 'compact')).toBeGreaterThanOrEqual(6)
    expect(testingGuide).toContain('紧凑行高不低于 40px')
  })

  it('keeps the security support statement independent of a stale minor version', () => {
    expect(securityPolicy).toContain('最新稳定版本')
    expect(securityPolicy).not.toMatch(/最新的 `\d+\.\d+\.x`/)
  })

  it('stacks source and time in one narrow right-side metadata track', () => {
    expect(cssRule('.clip-meta')).toMatch(/display:\s*flex/)
    expect(cssRule('.clip-meta')).toMatch(/width:\s*92px/)
    expect(cssRule('.clip-meta')).toMatch(/flex-direction:\s*column/)
    expect(cssRule('.clip-meta')).toMatch(/justify-content:\s*center/)
    expect(cssRule('.source-app')).toMatch(/grid-template-columns:\s*14px\s+minmax\(0,\s*1fr\)/)
    expect(cssRule('.source-app')).toMatch(/line-height:\s*14px/)
    expect(cssRule('.clip-time')).toMatch(/font-variant-numeric:\s*tabular-nums/)
    expect(cssRule('.app-dot')).toMatch(/width:\s*14px/)
    expect(cssRule('.app-dot')).toMatch(/height:\s*14px/)
    expect(cssRule('.manager-meta')).toMatch(/justify-content:\s*center/)
    expect(cssRule('.manager-source')).toMatch(/line-height:\s*16px/)
  })

  it('keeps metadata visible on primary keyboard focus and only replaces it inside row actions', () => {
    expect(styles).not.toContain('.clip-row:focus-within .clip-meta')
    expect(styles).toContain('.row-actions:focus-within')
    expect(styles).toContain('.clip-row:has(.row-actions:focus-within) .clip-meta')
  })

  it('uses hover space for readable content previews instead of shortcut badges', () => {
    expect(cssRule('.clip-hover-preview')).toMatch(/position:\s*absolute/)
    expect(cssRule('.clip-hover-preview')).toMatch(/pointer-events:\s*none/)
    expect(cssRule('.clip-hover-preview-text')).toMatch(/-webkit-line-clamp:\s*8/)
    expect(cssRule('.clip-hover-preview-text')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(cssRule('.clip-hover-preview-image')).toMatch(/min-height:\s*180px/)
    expect(cssRule('.clip-hover-preview-image img,\n.clip-hover-preview-image > svg')).toMatch(/object-fit:\s*contain/)
    expect(styles).not.toContain('.clip-row:hover .quick-number')
  })

  it('keeps the compact title bar free of the old footer allocation', () => {
    expect(styles).not.toContain('--quick-footer-height')
    expect(styles).not.toContain('.panel-footer')
    expect(cssRule('.chrome-target')).toMatch(/align-items:\s*center/)
    expect(cssRule('.chrome-target')).toMatch(/max-width:\s*112px/)
  })

  it('adapts settings columns to available content width without stretching short cards', () => {
    expect(styles).toMatch(/\.settings-content\s*\{\s*display:\s*grid;[\s\S]*?width:\s*min\(100%,\s*960px\);[\s\S]*?margin-inline:\s*auto;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(cssRule('.setting-group')).toMatch(/align-self:\s*start/)
    expect(cssRule('.settings-primary-actions,\n.update-card,\n.settings-loading')).toMatch(/grid-column:\s*1\s*\/\s*-1/)
    expect(cssRule('.settings-primary-actions')).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(280px,\s*1fr\)\)/)
    expect(cssRule('.settings-primary-card')).toMatch(/display:\s*grid/)
    expect(cssRule('.setting-row')).toMatch(/display:\s*grid/)
    expect(cssRule('.setting-row')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/)
    expect(cssRule('.shortcut-card')).toMatch(/grid-template-columns:\s*34px\s+minmax\(0,\s*1fr\)/)
    expect(cssRule('.shortcut-recorder')).toMatch(/grid-column:\s*2/)
    expect(cssRule('.update-card')).toMatch(/grid-template-columns:\s*24px\s+minmax\(0,\s*1fr\)/)
    expect(cssRule('.update-actions')).toMatch(/grid-column:\s*2/)
    expect(cssRule('.update-actions')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('keeps settings copy readable without flattening its visual hierarchy', () => {
    expect(cssRule('.settings-primary-copy strong')).toMatch(/font-size:\s*12px/)
    expect(cssRule('.settings-primary-copy small,\n.settings-primary-link')).toMatch(/font-size:\s*10px/)
    expect(cssRule('.setting-heading h2')).toMatch(/font-size:\s*13px/)
    expect(cssRule('.setting-heading p,\n.setting-row small')).toMatch(/font-size:\s*10px/)
    expect(cssRule('.setting-row strong')).toMatch(/font-size:\s*11\.5px/)
    expect(cssRule('.storage-manager-header p,\n.storage-panel header p,\n.storage-health-notice p,\n.storage-operation-card p,\n.storage-operation-card small')).toMatch(/font-size:\s*10px/)
    expect(cssRule('.storage-action-button,\n.storage-directory-button,\n.storage-refresh-button,\n.storage-cancel-button,\n.storage-danger-button')).toMatch(/font-size:\s*9\.5px/)
    expect(cssRule('.update-copy p')).toMatch(/font-size:\s*10\.5px/)
  })

  it('keeps collection management readable and independently scrollable in compact manager windows', () => {
    expect(cssRule('.manager-collections nav')).toMatch(/max-height:\s*190px/)
    expect(cssRule('.manager-collections nav')).toMatch(/overflow-y:\s*auto/)
    expect(cssRule('.manager-collection-row')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+28px\s+28px/)
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.library-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(150px,\s*25vw\)\s+minmax\(0,\s*1fr\)/)
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.manager-collections form\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('covers the full maximized window with settings modals', () => {
    expect(cssRule('.app-stage.is-window-maximized .settings-modal-backdrop')).toMatch(/width:\s*100vw/)
    expect(cssRule('.app-stage.is-window-maximized .settings-modal-backdrop')).toMatch(/height:\s*100vh/)
  })

  it('compacts onboarding at reduced effective heights with an overflow safety fallback', () => {
    expect(cssRule('.onboarding-backdrop')).toMatch(/inset:\s*0/)
    expect(cssRule('.onboarding-dialog')).toMatch(/display:\s*grid/)
    expect(cssRule('.onboarding-dialog')).toMatch(/max-height:\s*100%/)
    expect(cssRule('.onboarding-dialog')).toMatch(/overflow:\s*auto/)
    expect(styles).toMatch(/@media \(max-height:\s*520px\)[\s\S]*?\.onboarding-visual\s*\{[\s\S]*?height:\s*148px/)
  })

  it('keeps format metadata readable without crowding a 640 by 440 preview', () => {
    expect(cssRule('.format-badges')).toMatch(/display:\s*flex/)
    expect(cssRule('.format-badges')).toMatch(/flex-wrap:\s*wrap/)
    expect(cssRule('.format-omission-warning')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(cssRule('.preview-actions')).toMatch(/flex-wrap:\s*wrap/)
    expect(styles).toMatch(/@media \(max-height:\s*520px\)[\s\S]*?\.preview-body\s*\{[\s\S]*?padding:\s*12px\s+16px/)
  })

  it('gives image previews the remaining viewport instead of forcing a detail scroll', () => {
    expect(cssRule('.preview-body.image-preview-body')).toMatch(/display:\s*flex/)
    expect(cssRule('.preview-body.image-preview-body')).toMatch(/overflow:\s*hidden/)
    expect(cssRule('.image-preview-content')).toMatch(/display:\s*grid/)
    expect(cssRule('.image-preview-content')).toMatch(/grid-template-rows:\s*minmax\(180px,\s*1fr\)\s+auto/)
    expect(cssRule('.image-preview-body .preview-image')).toMatch(/min-height:\s*180px/)
    expect(cssRule('.image-preview-body .preview-image')).toMatch(/max-height:\s*none/)
    expect(cssRule('.preview-ocr-text')).toMatch(/max-height:\s*30px/)
    expect(cssRule('.preview-ocr-text[open]')).toMatch(/max-height:\s*96px/)
    expect(cssRule('.preview-ocr-text summary')).toMatch(/cursor:\s*pointer/)
    expect(cssRule('.preview-image-title')).toMatch(/text-overflow:\s*ellipsis/)
    expect(cssRule('.preview-image-title')).toMatch(/white-space:\s*nowrap/)
    expect(styles).toMatch(/@media \(max-height:\s*520px\)[\s\S]*?\.image-preview-content\s*\{[\s\S]*?grid-template-rows:\s*minmax\(120px,\s*1fr\)\s+auto/)
    expect(styles).toMatch(/@media \(max-height:\s*520px\)[\s\S]*?\.image-preview-body \.preview-image\s*\{[\s\S]*?min-height:\s*120px/)
    expect(styles).toMatch(/@media \(max-height:\s*520px\)[\s\S]*?\.preview-ocr-text\[open\]\s*\{[\s\S]*?max-height:\s*72px/)
  })

  it('keeps manager controls and row metadata on stable compact tracks', () => {
    expect(cssRule('.manager-toolbar')).toMatch(/display:\s*grid/)
    expect(cssRule('.manager-toolbar')).toMatch(/grid-template-columns:\s*minmax\(240px,\s*1fr\)\s+auto/)
    expect(cssRule('.manager-toolbar')).toMatch(/grid-template-areas:\s*"search actions"\s*"filters filters"/)
    expect(cssRule('.manager-toolbar-actions')).toMatch(/display:\s*flex/)
    expect(cssRule('.manager-filters')).toMatch(/overflow-x:\s*auto/)
    expect(cssRule('.manager-filters button')).toMatch(/flex:\s*0\s+0\s+auto/)
    expect(cssRule('.manager-filters button')).toMatch(/white-space:\s*nowrap/)
    expect(cssRule('.manager-row')).toMatch(/grid-template-columns:\s*24px\s+42px\s+minmax\(0,\s*1fr\)\s+96px\s+90px/)
  })

  it('uses two unique-content lines without increasing quick or manager rows', () => {
    const quickSummary = cssRule('.clip-content-text')
    const managerSummary = cssRule('.manager-summary-text')

    for (const rule of [quickSummary, managerSummary]) {
      expect(rule).toMatch(/display:\s*-webkit-box/)
      expect(rule).toMatch(/-webkit-box-orient:\s*vertical/)
      expect(rule).toMatch(/-webkit-line-clamp:\s*2/)
      expect(rule).toMatch(/white-space:\s*normal/)
      expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
    }
    expect(quickPanelMetric('--quick-row-height', 'standard')).toBe(44)
    expect(quickPanelMetric('--quick-row-height', 'compact')).toBe(40)
    expect(cssRule('.manager-row')).toMatch(/min-height:\s*54px/)
    expect(testingGuide).toContain('条目摘要默认显示两行')
  })

  it('keeps search-origin badges compact instead of letting them wrap and increase row height', () => {
    const matchBadges = cssRule('.phonetic-match,\n.ocr-match')

    expect(matchBadges).toMatch(/flex:\s*0\s+0\s+auto/)
    expect(matchBadges).toMatch(/white-space:\s*nowrap/)
  })

  it('keeps phonetic and index match badges distinct in forced-color mode', () => {
    expect(styles).toMatch(
      /@media \(forced-colors:\s*active\)[\s\S]*?\.phonetic-match,[\s\S]*?\.ocr-match,[\s\S]*?\.ocr-status\s*\{[\s\S]*?border:\s*1px\s+solid\s+CanvasText/,
    )
  })

  it('keeps update actions in a dismissible bottom-right notice', () => {
    expect(cssRule('.update-notice')).toMatch(/position:\s*fixed/)
    expect(cssRule('.update-notice')).toMatch(/right:\s*16px/)
    expect(cssRule('.update-notice')).toMatch(/bottom:\s*14px/)
    expect(cssRule('.update-notice-actions')).toMatch(/display:\s*flex/)
    expect(cssRule('.update-notice-actions .update-notice-install')).toMatch(/background:\s*var\(--brand\)/)
  })

  it('uses a two-card storage summary for the only user-facing statistics', () => {
    expect(cssRule('.storage-summary')).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(cssRule('.storage-summary strong')).toMatch(/font-variant-numeric:\s*tabular-nums/)
  })

  it('reserves visible title space for degraded multi-file availability badges', () => {
    const contentTextRules = cssRule('.clip-content-text')
    expect(cssRule('.clip-content')).toMatch(/display:\s*flex/)
    expect(contentTextRules).toMatch(/min-width:\s*0/)
    expect(contentTextRules).toMatch(/overflow:\s*hidden/)
    expect(cssRule('.manager-copy')).toMatch(/display:\s*flex/)
    expect(cssRule('.manager-summary-text')).toMatch(/flex:\s*1\s+1\s+auto/)
    expect(cssRule('.file-availability')).toMatch(/flex:\s*0\s+0\s+auto/)
  })

  it('keeps format and omission badges visible in light, dark, and forced-color themes', () => {
    expect(cssRule('.format-badge')).toMatch(/color:\s*var\(--brand-strong\)/)
    expect(cssRule('.format-omission-warning')).toMatch(/color:\s*var\(--text-soft\)/)
    expect(styles).toMatch(/:root\[data-theme="dark"\]/)
    expect(styles).toMatch(/@media \(forced-colors:\s*active\)[\s\S]*?\.format-badge,[\s\S]*?\.format-omission-warning,[\s\S]*?\{[\s\S]*?border:\s*1px\s+solid\s+CanvasText/)
    expect(styles).toMatch(/\.ocr-match,[\s\S]*?\.ocr-status\s*\{[\s\S]*?border:\s*1px\s+solid\s+CanvasText/)
  })
})
