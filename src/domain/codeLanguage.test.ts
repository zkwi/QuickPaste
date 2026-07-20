import { inferCodeLanguage } from './codeLanguage'

describe('inferCodeLanguage', () => {
  it.each([
    ['component.tsx', 'export const Button = (props: Props) => <button />', 'typescript'],
    ['worker.mjs', 'export const answer = 42', 'javascript'],
    ['settings.json', '{"theme":"dark"}', 'json'],
    ['release.ps1', '$files = Get-ChildItem -Recurse', 'powershell'],
    ['report.py', 'def render_report(items):\n    return items', 'python'],
    ['main.rs', 'fn main() {\n    println!("hello");\n}', 'rust'],
    ['history.sql', 'SELECT id, content FROM clips WHERE pinned = 1;', 'sql'],
    ['theme.css', '.card { color: var(--accent); }', 'css'],
    ['layout.html', '<section><h1>QuickPaste</h1></section>', 'xml'],
  ] as const)('uses an explicit filename hint for %s', (title, content, expected) => {
    expect(inferCodeLanguage(title, content)).toBe(expected)
  })

  it.each([
    ['const answer: number = 42', 'typescript'],
    ['const answer = 42;\nconsole.log(answer);', 'javascript'],
    ['{\n  "width": 760,\n  "height": 440\n}', 'json'],
    ['$items = Get-ChildItem\n$items | Where-Object { $_.Length -gt 0 }', 'powershell'],
    ['def greet(name):\n    return f"Hello {name}"', 'python'],
    ['fn main() {\n    let mut count = 0;\n}', 'rust'],
    ['SELECT id FROM clips\nWHERE pinned = 1;', 'sql'],
    ['.preview {\n  overflow: auto;\n}', 'css'],
    ['<?xml version="1.0"?><root />', 'xml'],
  ] as const)('detects a high-confidence snippet without an extension', (content, expected) => {
    expect(inferCodeLanguage('代码片段', content)).toBe(expected)
  })

  it.each([
    'cargo tauri dev',
    '今天完成快速面板验证。',
    'answer = 42',
    '# Release notes\n\n- Added previews',
    'name: QuickPaste\nversion: 0.6.0',
    '',
  ])('keeps ambiguous content plain: %s', (content) => {
    expect(inferCodeLanguage('代码片段', content)).toBeUndefined()
  })
})
