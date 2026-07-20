import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCodeHighlightBuild } from './check-code-highlight-build.mjs'

const languages = [
  'bash', 'css', 'javascript', 'json', 'powershell',
  'python', 'rust', 'sql', 'typescript', 'xml',
]

function manifest() {
  const value = {
    'index.html': {
      file: 'assets/index.js',
      isEntry: true,
      dynamicImports: ['src/components/CodePreview.vue'],
    },
    'src/components/CodePreview.vue': {
      file: 'assets/code-preview.js',
      src: 'src/components/CodePreview.vue',
      isDynamicEntry: true,
      imports: ['index.html'],
      dynamicImports: ['highlight/core', ...languages.map((language) => `highlight/${language}`)],
    },
    'highlight/core': {
      file: 'assets/highlight-core.js',
      src: 'node_modules/highlight.js/es/core.js',
      isDynamicEntry: true,
    },
  }
  for (const language of languages) {
    value[`highlight/${language}`] = {
      file: `assets/highlight-${language}.js`,
      src: `node_modules/highlight.js/es/languages/${language}.js`,
      isDynamicEntry: true,
    }
  }
  return value
}

test('accepts the exact dynamic-only highlight closure', () => {
  assert.deepEqual(validateCodeHighlightBuild(manifest(), () => ''), [])
})

test('rejects highlight in the initial static closure', () => {
  const value = manifest()
  value['index.html'].imports = ['highlight/core']
  assert.match(validateCodeHighlightBuild(value, () => '').join('\n'), /static closure/)
})

test('rejects an expanded or incomplete grammar set', () => {
  const value = manifest()
  value['src/components/CodePreview.vue'].dynamicImports.push('highlight/markdown')
  value['highlight/markdown'] = {
    file: 'assets/highlight-markdown.js',
    src: 'node_modules/highlight.js/es/languages/markdown.js',
    isDynamicEntry: true,
  }
  assert.match(validateCodeHighlightBuild(value, () => '').join('\n'), /unexpected lazy language set/)
})

test('rejects a full highlight bundle even when it is dynamically imported', () => {
  const value = manifest()
  value['src/components/CodePreview.vue'].dynamicImports.push('highlight/full')
  value['highlight/full'] = {
    file: 'assets/highlight-full.js',
    src: 'node_modules/highlight.js/es/index.js',
    isDynamicEntry: true,
  }
  assert.match(validateCodeHighlightBuild(value, () => '').join('\n'), /forbidden highlight module/)
})

test('rejects highlight modules in the CodePreview static closure', () => {
  const value = manifest()
  value['src/components/CodePreview.vue'].imports.push('highlight/core')
  assert.match(validateCodeHighlightBuild(value, () => '').join('\n'), /CodePreview static closure/)
})

test('rejects external highlight chunks and external module imports', () => {
  const externalFile = manifest()
  externalFile['highlight/core'].file = 'https://cdn.example/core.js'
  assert.match(validateCodeHighlightBuild(externalFile, () => '').join('\n'), /non-local/)

  const externalImport = manifest()
  assert.match(
    validateCodeHighlightBuild(externalImport, () => 'import("https://cdn.example/grammar.js")').join('\n'),
    /external import/,
  )
  assert.match(
    validateCodeHighlightBuild(externalImport, () => 'import(`https://cdn.example/grammar.js`)').join('\n'),
    /external import/,
  )
})

test('rejects external imports in the lazy preview loader chunk', () => {
  const value = manifest()
  const readAsset = (file) => file === 'assets/code-preview.js'
    ? 'import(`https://cdn.example/highlight.js`)'
    : ''
  assert.match(validateCodeHighlightBuild(value, readAsset).join('\n'), /CodePreview closure chunk/)

  const protocolRelative = (file) => file === 'assets/code-preview.js'
    ? 'import("//cdn.example/highlight.js")'
    : ''
  assert.match(validateCodeHighlightBuild(value, protocolRelative).join('\n'), /CodePreview closure chunk/)
})
