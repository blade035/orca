import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const contextRoot = mkdtempSync(join(tmpdir(), 'orca-server-docker-'))
const versions = readVersions()

try {
  const packOutput = await runCapture('npm', [
    'pack',
    join(repoRoot, 'packages', 'orca-server'),
    '--json',
    '--pack-destination',
    contextRoot
  ])
  const [packed] = JSON.parse(packOutput)
  if (!packed?.filename) {
    throw new Error('npm pack returned no tarball')
  }
  renameSync(join(contextRoot, packed.filename), join(contextRoot, 'orca-server.tgz'))
  copyFileSync(
    join(repoRoot, 'config', 'scripts', 'verify-linux-glibc-floor.cjs'),
    join(contextRoot, 'verify-linux-glibc-floor.cjs')
  )
  await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ['config/scripts/node-server-runtime-verifier.ts'],
    format: 'cjs',
    outfile: join(contextRoot, 'runtime-verifier.cjs'),
    platform: 'node',
    target: 'node24'
  })

  for (const version of versions) {
    process.stdout.write(`Verifying Orca server on Ubuntu ${version}\n`)
    await run('docker', [
      'build',
      '--platform',
      process.env.ORCA_SERVER_DOCKER_PLATFORM ?? 'linux/amd64',
      '--build-arg',
      `UBUNTU_VERSION=${version}`,
      '--file',
      join(repoRoot, 'config', 'docker', 'node-server', 'Dockerfile'),
      '--progress',
      'plain',
      contextRoot
    ])
  }
  process.stdout.write(`Node server Docker verification passed: Ubuntu ${versions.join(', ')}\n`)
} finally {
  rmSync(contextRoot, { force: true, recursive: true })
}

function readVersions() {
  const index = process.argv.indexOf('--ubuntu')
  if (index === -1) {
    return ['20.04', '22.04', '24.04']
  }
  const value = process.argv[index + 1]
  if (!value || !/^\d{2}\.\d{2}(?:,\d{2}\.\d{2})*$/.test(value)) {
    throw new Error('--ubuntu requires a comma-separated version list')
  }
  return value.split(',')
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
