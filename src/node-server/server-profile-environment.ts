import { resolveServerDataPath } from './server-paths'

export function configureServerProfileEnvironment(dataPath: string): void {
  process.env.ORCA_USER_DATA_PATH = dataPath
}

export function configureServerControlProfileEnvironment(): void {
  if (process.env.ORCA_SERVER_DATA_DIR || !process.env.ORCA_USER_DATA_PATH) {
    process.env.ORCA_USER_DATA_PATH = resolveServerDataPath()
  }
}
