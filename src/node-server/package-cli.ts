#!/usr/bin/env node
export {}

const argv = process.argv.slice(2)
const serverCommand =
  argv.length === 0 ||
  argv[0] === 'serve' ||
  argv[0] === 'version' ||
  argv[0] === '--version' ||
  argv[0] === '-v'

if (serverCommand) {
  void import('./index').then(({ reportNodeServerFailure, runNodeServer }) =>
    runNodeServer(argv).catch(reportNodeServerFailure)
  )
} else {
  void Promise.all([import('../cli/cli-program'), import('./server-profile-environment')]).then(
    ([{ main: runControlCli }, { configureServerControlProfileEnvironment }]) => {
      configureServerControlProfileEnvironment()
      return runControlCli(argv)
    }
  )
}
