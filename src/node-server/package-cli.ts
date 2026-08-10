#!/usr/bin/env node
import { main as runControlCli } from '../cli/cli-program'
import { reportNodeServerFailure, runNodeServer } from './index'
import { resolveServerDataPath } from './server-paths'

const argv = process.argv.slice(2)
const serverCommand =
  argv.length === 0 ||
  argv[0] === 'serve' ||
  argv[0] === 'version' ||
  argv[0] === '--version' ||
  argv[0] === '-v'

if (serverCommand) {
  void runNodeServer(argv).catch(reportNodeServerFailure)
} else {
  process.env.ORCA_USER_DATA_PATH ??= resolveServerDataPath()
  void runControlCli(argv)
}
