import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'orca-runtime-verifier-build-'))
const verifierPath = join(temporaryRoot, 'verifier.cjs')

try {
  await build({
    absWorkingDir: resolve('.'),
    bundle: true,
    entryPoints: ['config/scripts/node-server-runtime-verifier.ts'],
    format: 'cjs',
    outfile: verifierPath,
    platform: 'node',
    target: 'node24'
  })
  await run(process.execPath, [verifierPath, ...process.argv.slice(2)])
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`verifier exited with signal ${signal}`))
      } else if (code !== 0) {
        rejectRun(new Error(`verifier exited with code ${code}`))
      } else {
        resolveRun()
      }
    })
  })
}
