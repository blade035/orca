import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const buildScript = fileURLToPath(new URL('./run-electron-vite-build.mjs', import.meta.url))
const targetConfig = fileURLToPath(new URL('../electron-vite-target.config.ts', import.meta.url))

await run(process.execPath, [buildScript, '--config', targetConfig, '--ignoreConfigWarning'], {
  ORCA_ELECTRON_VITE_TARGET: 'renderer'
})
await run(process.execPath, [
  fileURLToPath(new URL('./project-renderer-web-client.mjs', import.meta.url))
])
await run(process.execPath, [fileURLToPath(new URL('./verify-web-build.mjs', import.meta.url))])

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env }
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}
