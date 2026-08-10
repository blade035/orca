import { statSync } from 'node:fs'

export function isSameExistingHostPath(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left, { bigint: true })
    const rightStat = statSync(right, { bigint: true })
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch {
    return false
  }
}
