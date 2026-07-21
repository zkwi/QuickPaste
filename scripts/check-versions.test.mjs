import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateProjectMetadata } from './check-versions.mjs'

function validMetadata() {
  return {
    packageJson: {
      name: 'quickpaste',
      version: '0.1.0',
      private: true,
      packageManager: 'npm@11.9.0',
      scripts: {
        'build:windows': 'tauri build --bundles nsis --target x86_64-pc-windows-msvc',
      },
      devEngines: {
        runtime: { name: 'node', version: '22.14.0', onFail: 'error' },
        packageManager: { name: 'npm', version: '11.9.0', onFail: 'error' },
      },
    },
    packageLock: {
      name: 'quickpaste',
      version: '0.1.0',
      packages: { '': { name: 'quickpaste', version: '0.1.0' } },
    },
    tauriConfig: {
      productName: 'QuickPaste',
      identifier: 'com.quickpaste.desktop',
      version: '0.1.0',
      bundle: {
        targets: ['nsis'],
        windows: { nsis: { installMode: 'currentUser' } },
      },
    },
    tauriCapabilities: {
      permissions: [
        'core:default',
        'core:window:allow-hide',
        'core:window:allow-minimize',
        'core:window:allow-start-dragging',
        'core:window:allow-toggle-maximize',
      ],
    },
    cargoManifest: [
      '[package]',
      'name = "quickpaste"',
      'version = "0.1.0"',
      'publish = false',
      'rust-version = "1.88"',
      '',
      '[dependencies]',
    ].join('\n'),
    cargoLock: [
      '[[package]]',
      'name = "quickpaste"',
      'version = "0.1.0"',
    ].join('\n'),
    nvmrc: '22.14.0\n',
    rustToolchain: [
      '[toolchain]',
      'channel = "1.88.0"',
      'components = ["clippy", "rustfmt"]',
    ].join('\n'),
    ciWorkflow: [
      'uses: actions/checkout@v6',
      'uses: actions/setup-node@v6',
      'uses: dtolnay/rust-toolchain@1.88.0',
      'uses: Swatinem/rust-cache@v2',
    ].join('\n'),
    updaterSource: [
      'https://api.github.com/repos/zkwi/QuickPaste/releases?per_page=10',
      'https://github.com/zkwi/QuickPaste/releases/download/',
      'QuickPaste_{version}_x64-setup.exe',
    ].join('\n'),
  }
}

test('validateProjectMetadata accepts the repository contract', () => {
  assert.deepEqual(validateProjectMetadata(validMetadata()), [])
})

test('validateProjectMetadata locks the QuickPaste brand identifiers', () => {
  const metadata = validMetadata()
  metadata.packageJson.name = 'old-name'
  metadata.packageLock.name = 'old-name'
  metadata.packageLock.packages[''].name = 'old-name'
  metadata.cargoManifest = metadata.cargoManifest.replace('name = "quickpaste"', 'name = "old-name"')
  metadata.tauriConfig.productName = 'Old Name'
  metadata.tauriConfig.identifier = 'com.old.desktop'

  assert.deepEqual(validateProjectMetadata(metadata), [
    'package.json name 必须为 quickpaste',
    'package-lock.json name 必须为 quickpaste',
    'package-lock.json packages[""].name 必须为 quickpaste',
    'src-tauri/Cargo.toml package name 必须为 quickpaste',
    'Tauri productName 必须为 QuickPaste',
    'Tauri identifier 必须为 com.quickpaste.desktop',
  ])
})

test('validateProjectMetadata catches version and toolchain drift', () => {
  const metadata = validMetadata()
  metadata.packageLock.packages[''].version = '0.2.0'
  metadata.cargoLock = metadata.cargoLock.replace('version = "0.1.0"', 'version = "0.2.0"')
  metadata.nvmrc = '22.13.0\n'
  metadata.rustToolchain = metadata.rustToolchain.replace('1.88.0', '1.89.0')

  assert.deepEqual(validateProjectMetadata(metadata), [
    '版本号不一致：package-lock.json packages[""].version = 0.2.0（期望 0.1.0）',
    '版本号不一致：src-tauri/Cargo.lock quickpaste = 0.2.0（期望 0.1.0）',
    '.nvmrc = 22.13.0，与 package.json devEngines.runtime.version = 22.14.0 不一致',
    'rust-toolchain.toml channel = 1.89.0，与 Cargo.toml rust-version = 1.88 不一致',
  ])
})

test('validateProjectMetadata enforces private NSIS current-user packaging', () => {
  const metadata = validMetadata()
  metadata.packageJson.private = false
  metadata.cargoManifest = metadata.cargoManifest.replace('publish = false', 'publish = true')
  metadata.tauriConfig.bundle.targets = ['msi']
  metadata.tauriConfig.bundle.windows.nsis.installMode = 'perMachine'
  metadata.packageJson.devEngines.packageManager.version = '10.9.2'
  metadata.packageJson.scripts['build:windows'] = 'tauri build --bundles nsis'

  assert.deepEqual(validateProjectMetadata(metadata), [
    'package.json 必须保持 private = true',
    'src-tauri/Cargo.toml 必须保持 publish = false',
    'src-tauri/tauri.conf.json 只能构建 NSIS',
    'NSIS installMode 必须为 currentUser',
    'build:windows 必须显式构建 x86_64-pc-windows-msvc 的 NSIS 安装包',
    'packageManager = npm@11.9.0，与 devEngines.packageManager = npm@10.9.2 不一致',
  ])
})

test('validateProjectMetadata rejects unavailable GitHub Actions major versions', () => {
  const metadata = validMetadata()
  metadata.ciWorkflow = metadata.ciWorkflow.replaceAll('@v6', '@v7')

  assert.deepEqual(validateProjectMetadata(metadata), [
    'CI 必须使用 actions/checkout@v6',
    'CI 必须使用 actions/setup-node@v6',
    'CI 使用未批准的 GitHub Action：actions/checkout@v7',
    'CI 使用未批准的 GitHub Action：actions/setup-node@v7',
  ])
})

test('validateProjectMetadata requires the pinned Rust cache action', () => {
  const metadata = validMetadata()
  metadata.ciWorkflow = metadata.ciWorkflow.replace('Swatinem/rust-cache@v2', 'Swatinem/rust-cache@v3')

  assert.deepEqual(validateProjectMetadata(metadata), [
    'CI 必须使用 Swatinem/rust-cache@v2',
    'CI 使用未批准的 GitHub Action：Swatinem/rust-cache@v3',
  ])
})

test('validateProjectMetadata rejects an additional unapproved Rust cache major', () => {
  const metadata = validMetadata()
  metadata.ciWorkflow += '\nuses: Swatinem/rust-cache@v3'

  assert.deepEqual(validateProjectMetadata(metadata), [
    'CI 使用未批准的 GitHub Action：Swatinem/rust-cache@v3',
  ])
})

test('validateProjectMetadata recognizes whitespace and quoted YAML uses keys', () => {
  const metadata = validMetadata()
  metadata.ciWorkflow += '\nuses : Swatinem/rust-cache@v3\n"uses" : Swatinem/rust-cache@v1'

  assert.deepEqual(validateProjectMetadata(metadata), [
    'CI 使用未批准的 GitHub Action：Swatinem/rust-cache@v3',
    'CI 使用未批准的 GitHub Action：Swatinem/rust-cache@v1',
  ])
})

test('validateProjectMetadata protects setup-node npm cache bootstrap from the preinstalled npm version', () => {
  const metadata = validMetadata()
  metadata.ciWorkflow += `\n${[
    '      - name: Set up Node.js',
    '        uses: actions/setup-node@v6',
    '        with:',
    '          node-version-file: .nvmrc',
    '          cache: npm',
    '          cache-dependency-path: package-lock.json',
  ].join('\n')}`

  assert.deepEqual(validateProjectMetadata(metadata), [
    '使用 npm 缓存的 setup-node 步骤必须临时设置 npm_config_force: true',
  ])
})

test('validateProjectMetadata rejects npm_config_force nested under setup-node with options', () => {
  const metadata = validMetadata()
  metadata.ciWorkflow += `\n${[
    '      - name: Set up Node.js',
    '        uses: actions/setup-node@v6',
    '        with:',
    '          node-version-file: .nvmrc',
    '          cache: npm',
    '          env:',
    '            npm_config_force: true',
  ].join('\n')}`

  assert.deepEqual(validateProjectMetadata(metadata), [
    '使用 npm 缓存的 setup-node 步骤必须临时设置 npm_config_force: true',
  ])
})

test('validateProjectMetadata requires every custom titlebar window permission', () => {
  const metadata = validMetadata()
  metadata.tauriCapabilities.permissions = metadata.tauriCapabilities.permissions.filter(
    (permission) => permission !== 'core:window:allow-toggle-maximize',
  )

  assert.deepEqual(validateProjectMetadata(metadata), [
    'Tauri 主窗口权限缺失：core:window:allow-toggle-maximize',
  ])
})

test('validateProjectMetadata locks the unsigned updater to the public QuickPaste NSIS releases', () => {
  const metadata = validMetadata()
  metadata.updaterSource = 'https://api.github.com/repos/another/project/releases\ninstaller.msi'
  metadata.cargoManifest += '\ntauri-plugin-updater = "2"\n'

  assert.deepEqual(validateProjectMetadata(metadata), [
    '自定义更新器必须固定访问 zkwi/QuickPaste Releases API',
    '自定义更新器必须固定 QuickPaste GitHub Release 下载前缀',
    '自定义更新器必须严格匹配 x64 NSIS 安装包名称',
    '项目不得重新引入 Tauri updater 签名链',
  ])
})
