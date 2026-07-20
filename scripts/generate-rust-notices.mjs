import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'quickpaste-rust-notices-'))
const temporaryOutput = path.join(temporaryDirectory, 'THIRD_PARTY_LICENSES_RUST.md')

try {
  execFileSync('cargo', [
    'about', 'generate',
    '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'),
    '--config', path.join(root, 'src-tauri', 'about.toml'),
    '--target', 'x86_64-pc-windows-msvc',
    '--locked', '--fail',
    '--output-file', temporaryOutput,
    path.join(root, 'scripts', 'licenses', 'rust-notices.hbs'),
  ], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })

  const generated = `${(await readFile(temporaryOutput, 'utf8'))
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .trimEnd()}\n`
  if (!generated.startsWith('# Rust 第三方许可证\n')) {
    throw new Error('cargo-about 生成了非预期的 Rust 第三方声明。')
  }
  await writeFile(path.join(root, 'THIRD_PARTY_LICENSES_RUST.md'), generated, 'utf8')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

console.log('Rust 第三方许可证已生成并规范化为 LF。')
