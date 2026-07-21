import assert from 'node:assert/strict'
import test from 'node:test'
import {
  scanQuickPanelComponentBoundary,
  scanForbiddenRuntimeDependencies,
  scanLocalOnlyModule,
  scanPackagedResources,
  scanQuickPanelBoundary,
} from './check-runtime-boundaries.mjs'

test('scans the extracted quick panel component instead of relying on App.vue branch text', () => {
  const quickPanel = `
    <section class="quick-panel">
      <input data-testid="quick-search-input" />
      <div class="clip-list"></div>
      <section class="preview-panel"></section>
    </section>
  `
  assert.deepEqual(scanQuickPanelComponentBoundary(quickPanel), [])
  assert.deepEqual(scanQuickPanelComponentBoundary(`${quickPanel}<ManagerBulkToolbar />`), [
    'quick panel contains forbidden manager control: ManagerBulkToolbar',
  ])

  assert.deepEqual(scanQuickPanelBoundary(`${quickPanel}<SnippetEditor />`), [
    'quick panel contains forbidden manager control: SnippetEditor',
  ])
})

test('flags network clients in clipboard, history, and OCR local-only modules', () => {
  assert.deepEqual(scanLocalOnlyModule('src-tauri/src/ocr.rs', 'use windows::Media::Ocr;'), [])
  assert.deepEqual(scanLocalOnlyModule('src/platform/ocr.ts', "fetch('https://example.com')"), [
    'src/platform/ocr.ts contains forbidden network capability: fetch(',
    'src/platform/ocr.ts contains forbidden network capability: https://',
  ])
  assert.deepEqual(scanLocalOnlyModule('src-tauri/src/history.rs', 'let client = reqwest::Client::new();'), [
    'src-tauri/src/history.rs contains forbidden network capability: reqwest',
  ])
})

test('rejects OCR models, translation models, FFmpeg, and network runtimes from package dependencies', () => {
  const safe = {
    packages: {
      '': { dependencies: { vue: '^3.5.0', 'highlight.js': '11.11.1' } },
      'node_modules/highlight.js': { version: '11.11.1' },
    },
  }
  assert.deepEqual(scanForbiddenRuntimeDependencies(safe), [])
  assert.deepEqual(scanForbiddenRuntimeDependencies({
    packages: {
      '': { dependencies: { 'tesseract.js': '6.0.0', '@ffmpeg/ffmpeg': '1.0.0' } },
    },
  }), [
    'forbidden bundled runtime dependency: @ffmpeg/ffmpeg',
    'forbidden bundled runtime dependency: tesseract.js',
  ])
})

test('rejects model and FFmpeg files from Tauri resources without banning normal icons', () => {
  assert.deepEqual(scanPackagedResources({ bundle: { resources: ['icons/app.ico', 'assets/help.txt'] } }), [])
  assert.deepEqual(scanPackagedResources({
    bundle: { resources: ['models/ocr.onnx', 'bin/ffmpeg.exe', 'translation/model.gguf'] },
  }), [
    'forbidden packaged runtime asset: bin/ffmpeg.exe',
    'forbidden packaged runtime asset: models/ocr.onnx',
    'forbidden packaged runtime asset: translation/model.gguf',
  ])
})
