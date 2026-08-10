import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const packageRoot = join(repoRoot, 'packages', 'orca-server')
const distRoot = join(packageRoot, 'dist')
const facadePath = join(repoRoot, 'src', 'node-server', 'node-host-electron-facade.ts')
const external = ['@parcel/watcher', 'node-pty', 'ssh2', 'tweetnacl', 'ws']
const common = {
  absWorkingDir: repoRoot,
  alias: { electron: facadePath, 'electron-updater': facadePath },
  bundle: true,
  define: {
    ORCA_BUILD_IDENTITY: 'null',
    ORCA_DIAGNOSTICS_TOKEN_URL: 'null',
    ORCA_POSTHOG_WRITE_KEY: 'null'
  },
  external,
  format: 'cjs',
  logLevel: 'info',
  mainFields: ['module', 'main'],
  metafile: true,
  platform: 'node',
  sourcemap: false,
  target: 'node24'
}

rmSync(distRoot, { force: true, recursive: true })
mkdirSync(distRoot, { recursive: true })

const serverResult = await build({
  ...common,
  entryPoints: [join(repoRoot, 'src', 'node-server', 'index.ts')],
  outfile: join(distRoot, 'cli.js')
})
const daemonResult = await build({
  ...common,
  entryPoints: [join(repoRoot, 'src', 'main', 'daemon', 'daemon-entry.ts')],
  outfile: join(distRoot, 'daemon-entry.js')
})

const webRoot = join(repoRoot, 'out', 'web')
if (!existsSync(join(webRoot, 'web-index.html'))) {
  throw new Error('Missing out/web/web-index.html; run build:web-from-renderer first')
}
cpSync(webRoot, join(distRoot, 'web'), { recursive: true })
cpSync(join(repoRoot, 'LICENSE'), join(distRoot, 'LICENSE'))
verifyPlainNodeBundle(serverResult.metafile, 'server')
verifyPlainNodeBundle(daemonResult.metafile, 'daemon')

const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
if (packageJson.version !== rootPackageJson.version) {
  throw new Error(
    `Server package version ${packageJson.version} does not match root ${rootPackageJson.version}`
  )
}

function verifyPlainNodeBundle(metafile, label) {
  const forbiddenExternal = new Set(['electron', 'electron-updater'])
  const forbiddenPackages = ['agent-browser', 'serve-sim', 'sherpa-onnx']
  for (const [output, metadata] of Object.entries(metafile.outputs)) {
    for (const imported of metadata.imports) {
      if (forbiddenExternal.has(imported.path)) {
        throw new Error(`${label} bundle ${output} imports forbidden runtime ${imported.path}`)
      }
    }
  }
  for (const input of Object.keys(metafile.inputs)) {
    if (forbiddenPackages.some((name) => input.includes(`/node_modules/${name}/`))) {
      throw new Error(`${label} bundle includes desktop-only package ${input}`)
    }
  }
}
