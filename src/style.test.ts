import { readFileSync } from 'node:fs'

const styles = readFileSync('src/style.css', 'utf8')

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
    '--quick-footer-height',
  ].reduce((total, name) => total + quickPanelMetric(name, variant), 0)
  const listPadding = quickPanelMetric('--quick-list-padding-block', variant) * 2
  const rowHeight = quickPanelMetric('--quick-row-height', variant)
  const rowGap = quickPanelMetric('--quick-row-gap', variant)
  const availableHeight = shellHeight - fixedHeight - listPadding
  return Math.floor((availableHeight + rowGap) / (rowHeight + rowGap))
}

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  if (!match) throw new Error(`Missing CSS rule: ${selector}`)
  return match[1]
}

describe('quick-panel density contract', () => {
  it('shows at least eight readable two-line clips in the standard shell', () => {
    const rowHeight = quickPanelMetric('--quick-row-height', 'standard')

    expect(rowHeight).toBeGreaterThanOrEqual(44)
    expect(quickPanelMetric('--quick-search-control-height', 'standard')).toBeGreaterThanOrEqual(32)
    expect(visibleClipRows(quickPanelMetric('--quick-shell-height', 'standard'), 'standard')).toBeGreaterThanOrEqual(8)
  })

  it('keeps six clips visible when native positioning selects the compact 640 by 440 window', () => {
    const compactVisibleShellHeight = 440 - 2 * 16

    expect(quickPanelMetric('--quick-row-height', 'compact')).toBeGreaterThanOrEqual(40)
    expect(quickPanelMetric('--quick-search-control-height', 'compact')).toBeGreaterThanOrEqual(32)
    expect(visibleClipRows(compactVisibleShellHeight, 'compact')).toBeGreaterThanOrEqual(6)
  })

  it('keeps source icons and timestamps on fixed right-side alignment tracks', () => {
    expect(cssRule('.clip-meta')).toMatch(/display:\s*grid/)
    expect(cssRule('.clip-meta')).toMatch(/width:\s*96px/)
    expect(cssRule('.source-app')).toMatch(/grid-template-columns:\s*16px\s+minmax\(0,\s*1fr\)/)
    expect(cssRule('.clip-time')).toMatch(/justify-self:\s*end/)
    expect(cssRule('.clip-time')).toMatch(/font-variant-numeric:\s*tabular-nums/)
    expect(cssRule('.app-dot')).toMatch(/width:\s*16px/)
    expect(cssRule('.app-dot')).toMatch(/height:\s*16px/)
  })

  it('keeps metadata visible on primary keyboard focus and only replaces it inside row actions', () => {
    expect(styles).not.toContain('.clip-row:focus-within .clip-meta')
    expect(styles).toContain('.row-actions:focus-within')
    expect(styles).toContain('.clip-row:has(.row-actions:focus-within) .clip-meta')
  })

  it('collapses the administrator label before it can crowd out the target app', () => {
    expect(styles).toMatch(/@media \(max-width:\s*520px\)[\s\S]*?\.target-admin-label\s*\{[\s\S]*?display:\s*none/)
  })

  it('keeps all settings visible in a compact two-column desktop layout', () => {
    expect(styles).toMatch(/\.settings-content\s*\{\s*display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(cssRule('.shortcut-card,\n.update-card,\n.settings-loading')).toMatch(/grid-column:\s*1\s*\/\s*-1/)
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.settings-content\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('covers the full maximized window with settings modals', () => {
    expect(cssRule('.app-stage.is-window-maximized .settings-modal-backdrop')).toMatch(/width:\s*100vw/)
    expect(cssRule('.app-stage.is-window-maximized .settings-modal-backdrop')).toMatch(/height:\s*100vh/)
  })
})
