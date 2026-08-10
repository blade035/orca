import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export function resolveNodeServerNpmInvocation({
  platform = process.platform,
  executablePath = process.execPath,
  pathExists = existsSync
} = {}) {
  if (platform !== 'win32') {
    return { command: 'npm', prefixArgs: [] }
  }
  const npmCliPath = win32.join(
    win32.dirname(executablePath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js'
  )
  if (!pathExists(npmCliPath)) {
    throw new Error(`npm CLI is missing beside Node: ${npmCliPath}`)
  }
  return { command: executablePath, prefixArgs: [npmCliPath] }
}
