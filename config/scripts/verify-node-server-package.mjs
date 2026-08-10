import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const packageRoot = join(repoRoot, 'resources', 'npm-server')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'orca-server-package-'))
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm'
const npmCommandArgs = getNpmCommandArgs()

try {
  const packOutput = await runCapture(npmCommand, [
    ...npmCommandArgs,
    'pack',
    packageRoot,
    '--json',
    '--pack-destination',
    temporaryRoot
  ])
  const [packed] = JSON.parse(packOutput)
  if (!packed || typeof packed.filename !== 'string') {
    throw new Error('npm pack returned no tarball')
  }
  verifyInventory(packed)

  const installRoot = join(temporaryRoot, 'install')
  mkdirSync(installRoot)
  writeFileSync(
    join(installRoot, 'package.json'),
    JSON.stringify({ private: true, name: 'orca-server-package-verifier', version: '0.0.0' })
  )
  await run(npmCommand, [
    ...npmCommandArgs,
    'install',
    join(temporaryRoot, packed.filename),
    '--no-audit',
    '--no-fund',
    '--prefix',
    installRoot
  ])

  const installedRoot = join(installRoot, 'node_modules', '@stablyai', 'orca')
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))
  verifyManifest(installedManifest)
  const cliPath = join(installedRoot, 'dist', 'cli.js')
  const help = await runCapture(npmCommand, [
    ...npmCommandArgs,
    '--prefix',
    installRoot,
    'exec',
    '--',
    'orca',
    '--help'
  ])
  if (!help.includes('Usage: orca-ide')) {
    throw new Error('installed CLI help is unavailable')
  }
  const version = (
    await runCapture(npmCommand, [
      ...npmCommandArgs,
      '--prefix',
      installRoot,
      'exec',
      '--',
      'orca-ide',
      '--version'
    ])
  ).trim()
  if (version !== installedManifest.version) {
    throw new Error('installed CLI version is inconsistent')
  }
  await run(process.execPath, [
    join(repoRoot, 'config', 'scripts', 'run-node-server-runtime-verifier.mjs'),
    '--cli',
    cliPath
  ])
  process.stdout.write(
    `Node server package verification passed (${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked)\n`
  )
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}

function verifyInventory(packed) {
  const files = new Map(packed.files.map((file) => [file.path, file]))
  for (const required of [
    'LICENSE',
    'README.md',
    'package.json',
    'dist/cli.js',
    'dist/daemon-entry.js',
    'dist/LICENSE',
    'dist/web/web-index.html'
  ]) {
    if (!files.has(required)) {
      throw new Error(`tarball is missing ${required}`)
    }
  }
  if (process.platform !== 'win32' && (files.get('dist/cli.js')?.mode & 0o111) === 0) {
    throw new Error('CLI is not executable')
  }
  if (packed.unpackedSize > 100 * 1024 * 1024) {
    throw new Error('tarball exceeds 100 MiB')
  }
  for (const path of files.keys()) {
    if (/electron|agent-browser|serve-sim|sherpa-onnx|\.map$/i.test(path)) {
      throw new Error(`tarball contains forbidden file: ${path}`)
    }
  }
}

function verifyManifest(manifest) {
  if (manifest.name !== '@stablyai/orca') {
    throw new Error('installed package name is inconsistent')
  }
  if (manifest.license !== 'MIT') {
    throw new Error('installed package license is inconsistent')
  }
  if (manifest.bin?.orca !== 'dist/cli.js' || manifest.bin?.['orca-ide'] !== 'dist/cli.js') {
    throw new Error('installed package bins are inconsistent')
  }
  const dependencies = Object.keys(manifest.dependencies ?? {})
  if (dependencies.some((name) => name === 'electron' || name === 'electron-updater')) {
    throw new Error('installed package depends on Electron')
  }
}

function getNpmCommandArgs() {
  if (process.platform !== 'win32') {
    return []
  }
  const npmCliPath = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCliPath)) {
    throw new Error(`npm CLI is missing beside Node: ${npmCliPath}`)
  }
  return [npmCliPath]
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`${command} exited with signal ${signal}`))
      } else if (code !== 0) {
        rejectRun(new Error(`${command} exited with code ${code}`))
      } else {
        resolveRun()
      }
    })
  })
}

function runCapture(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`${command} exited with signal ${signal}`))
      } else if (code !== 0) {
        rejectRun(new Error(`${command} exited with code ${code}: ${stderr}`))
      } else {
        resolveRun(stdout)
      }
    })
  })
}
