import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function tomlSection(content, name, array = false) {
  const marker = array ? `[[${name}]]` : `[${name}]`
  return content
    .split(/\r?\n(?=\[)/)
    .find((section) => section.trimStart().startsWith(marker))
}

function tomlString(section, key) {
  return section?.match(new RegExp(`^${key.replace('-', '\\-')}\\s*=\\s*"([^"]+)"\\s*$`, 'm'))?.[1]
}

function tomlBoolean(section, key) {
  const value = section?.match(new RegExp(`^${key.replace('-', '\\-')}\\s*=\\s*(true|false)\\s*$`, 'm'))?.[1]
  return value === undefined ? undefined : value === 'true'
}

function cargoLockVersion(cargoLock, packageName) {
  const packageSection = cargoLock
    .split(/\r?\n(?=\[\[package\]\])/)
    .find((section) => tomlString(section, 'name') === packageName)
  return tomlString(packageSection, 'version')
}

function normalizedRustVersion(version) {
  const parts = String(version ?? '').split('.')
  while (parts.length > 2 && parts.at(-1) === '0') parts.pop()
  return parts.join('.')
}

function reportVersion(issues, label, actual, expected) {
  if (actual !== expected) issues.push(`版本号不一致：${label} = ${actual ?? '无法读取'}（期望 ${expected}）`)
}

const requiredMainWindowPermissions = [
  'core:window:allow-hide',
  'core:window:allow-minimize',
  'core:window:allow-start-dragging',
  'core:window:allow-toggle-maximize',
]

const approvedCiActions = new Set([
  'actions/checkout@v6',
  'actions/setup-node@v6',
  'dtolnay/rust-toolchain@1.88.0',
  'Swatinem/rust-cache@v2',
])

function ciActions(workflow) {
  return [...(workflow ?? '').matchAll(/^\s*(?:uses|["']uses["'])\s*:\s*([^\s#]+)/gm)].map(([, action]) => action)
}

export function validateProjectMetadata(metadata) {
  const issues = []
  const packageSection = tomlSection(metadata.cargoManifest, 'package')
  const expectedVersion = metadata.packageJson.version

  if (metadata.packageJson.name !== 'quickpaste') issues.push('package.json name 必须为 quickpaste')
  if (metadata.packageLock.name !== 'quickpaste') issues.push('package-lock.json name 必须为 quickpaste')
  if (metadata.packageLock.packages?.['']?.name !== 'quickpaste') {
    issues.push('package-lock.json packages[""].name 必须为 quickpaste')
  }
  if (tomlString(packageSection, 'name') !== 'quickpaste') {
    issues.push('src-tauri/Cargo.toml package name 必须为 quickpaste')
  }
  if (metadata.tauriConfig.productName !== 'QuickPaste') issues.push('Tauri productName 必须为 QuickPaste')
  if (metadata.tauriConfig.identifier !== 'com.quickpaste.desktop') {
    issues.push('Tauri identifier 必须为 com.quickpaste.desktop')
  }

  reportVersion(issues, 'package-lock.json version', metadata.packageLock.version, expectedVersion)
  reportVersion(issues, 'package-lock.json packages[""].version', metadata.packageLock.packages?.['']?.version, expectedVersion)
  reportVersion(issues, 'src-tauri/Cargo.toml', tomlString(packageSection, 'version'), expectedVersion)
  reportVersion(issues, 'src-tauri/Cargo.lock quickpaste', cargoLockVersion(metadata.cargoLock, 'quickpaste'), expectedVersion)
  reportVersion(issues, 'src-tauri/tauri.conf.json', metadata.tauriConfig.version, expectedVersion)

  if (metadata.packageJson.private !== true) issues.push('package.json 必须保持 private = true')
  if (tomlBoolean(packageSection, 'publish') !== false) issues.push('src-tauri/Cargo.toml 必须保持 publish = false')
  if (JSON.stringify(metadata.tauriConfig.bundle?.targets) !== JSON.stringify(['nsis'])) {
    issues.push('src-tauri/tauri.conf.json 只能构建 NSIS')
  }
  if (metadata.tauriConfig.bundle?.windows?.nsis?.installMode !== 'currentUser') {
    issues.push('NSIS installMode 必须为 currentUser')
  }
  if (metadata.packageJson.scripts?.['build:windows'] !== 'tauri build --bundles nsis --target x86_64-pc-windows-msvc') {
    issues.push('build:windows 必须显式构建 x86_64-pc-windows-msvc 的 NSIS 安装包')
  }
  if (!metadata.ciWorkflow?.includes('actions/checkout@v6')) {
    issues.push('CI 必须使用 actions/checkout@v6')
  }
  if (!metadata.ciWorkflow?.includes('actions/setup-node@v6')) {
    issues.push('CI 必须使用 actions/setup-node@v6')
  }
  if (!metadata.ciWorkflow?.includes('Swatinem/rust-cache@v2')) {
    issues.push('CI 必须使用 Swatinem/rust-cache@v2')
  }
  for (const action of ciActions(metadata.ciWorkflow)) {
    if (!approvedCiActions.has(action)) issues.push(`CI 使用未批准的 GitHub Action：${action}`)
  }

  if (!metadata.updaterSource?.includes('https://api.github.com/repos/zkwi/QuickPaste/releases?per_page=10')) {
    issues.push('自定义更新器必须固定访问 zkwi/QuickPaste Releases API')
  }
  if (!metadata.updaterSource?.includes('https://github.com/zkwi/QuickPaste/releases/download/')) {
    issues.push('自定义更新器必须固定 QuickPaste GitHub Release 下载前缀')
  }
  if (!metadata.updaterSource?.includes('QuickPaste_{version}_x64-setup.exe')) {
    issues.push('自定义更新器必须严格匹配 x64 NSIS 安装包名称')
  }
  if (metadata.cargoManifest.includes('tauri-plugin-updater')) {
    issues.push('项目不得重新引入 Tauri updater 签名链')
  }

  const configuredPermissions = new Set(metadata.tauriCapabilities?.permissions ?? [])
  for (const permission of requiredMainWindowPermissions) {
    if (!configuredPermissions.has(permission)) issues.push(`Tauri 主窗口权限缺失：${permission}`)
  }

  const packageManager = metadata.packageJson.packageManager
  const declaredNpm = typeof packageManager === 'string' && packageManager.startsWith('npm@')
    ? packageManager.slice('npm@'.length)
    : undefined
  const engineNpm = metadata.packageJson.devEngines?.packageManager
  if (!declaredNpm) {
    issues.push('package.json 必须声明 packageManager = npm@<version>')
  } else if (engineNpm?.name !== 'npm' || engineNpm.version !== declaredNpm) {
    issues.push(`packageManager = npm@${declaredNpm}，与 devEngines.packageManager = ${engineNpm?.name ?? '无法读取'}@${engineNpm?.version ?? '无法读取'} 不一致`)
  }
  if (engineNpm?.onFail !== 'error') issues.push('devEngines.packageManager.onFail 必须为 error')

  const nodeVersion = metadata.nvmrc.trim().replace(/^v/, '')
  const runtimeEngine = metadata.packageJson.devEngines?.runtime
  if (runtimeEngine?.name !== 'node' || runtimeEngine.version !== nodeVersion) {
    issues.push(`.nvmrc = ${nodeVersion}，与 package.json devEngines.runtime.version = ${runtimeEngine?.version ?? '无法读取'} 不一致`)
  }
  if (runtimeEngine?.onFail !== 'error') issues.push('devEngines.runtime.onFail 必须为 error')

  const rustVersion = tomlString(packageSection, 'rust-version')
  const rustChannel = tomlString(tomlSection(metadata.rustToolchain, 'toolchain'), 'channel')
  if (normalizedRustVersion(rustChannel) !== normalizedRustVersion(rustVersion)) {
    issues.push(`rust-toolchain.toml channel = ${rustChannel ?? '无法读取'}，与 Cargo.toml rust-version = ${rustVersion ?? '无法读取'} 不一致`)
  }

  return issues
}

async function readProjectMetadata(root) {
  const [packageJson, packageLock, tauriConfig, tauriCapabilities, cargoManifest, cargoLock, nvmrc, rustToolchain, ciWorkflow, updaterSource] = await Promise.all([
    readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'src-tauri/capabilities/default.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8'),
    readFile(resolve(root, 'src-tauri/Cargo.lock'), 'utf8'),
    readFile(resolve(root, '.nvmrc'), 'utf8'),
    readFile(resolve(root, 'rust-toolchain.toml'), 'utf8'),
    readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(resolve(root, 'src-tauri/src/updater.rs'), 'utf8'),
  ])
  return { packageJson, packageLock, tauriConfig, tauriCapabilities, cargoManifest, cargoLock, nvmrc, rustToolchain, ciWorkflow, updaterSource }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const metadata = await readProjectMetadata(root)
  const issues = validateProjectMetadata(metadata)

  if (issues.length > 0) {
    console.error('项目元数据检查失败：')
    for (const issue of issues) console.error(`- ${issue}`)
    process.exitCode = 1
    return
  }

  console.log(`项目元数据一致：QuickPaste ${metadata.packageJson.version}，Node ${metadata.nvmrc.trim()}，npm ${metadata.packageJson.packageManager.split('@')[1]}。`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()
