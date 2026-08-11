import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getNpmRuntimeStatePath } from './npm-runtime-paths'
import {
  emptyNpmSupervisorState,
  npmSupervisorStartupFailure,
  parseNpmSupervisorState,
  readNpmSupervisorState,
  recoverInterruptedNpmHandoff,
  writeNpmSupervisorState
} from './npm-supervisor-state'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('npm supervisor state', () => {
  it('writes a private atomic document and reads it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-npm-state-'))
    roots.push(root)
    const state = {
      schemaVersion: 1 as const,
      activeVersion: '1.5.0',
      failure: {
        requestId: 'request-1',
        fromVersion: '1.4.0',
        targetVersion: '1.5.0',
        originRuntimeId: 'runtime-old',
        reason: 'candidate_failed'
      }
    }

    await writeNpmSupervisorState(root, state)

    expect(await readNpmSupervisorState(root)).toEqual(state)
    expect(JSON.parse(await readFile(getNpmRuntimeStatePath(root), 'utf8'))).toEqual(state)
  })

  it('fails closed to an empty state for malformed or non-exact data', async () => {
    expect(parseNpmSupervisorState({ schemaVersion: 1, activeVersion: 'latest' })).toBeNull()
    expect(
      parseNpmSupervisorState({
        schemaVersion: 1,
        pending: {
          requestId: 'request-1',
          fromVersion: '1.4.0',
          targetVersion: '1.5.0',
          originRuntimeId: ''
        }
      })
    ).toBeNull()
    expect(
      parseNpmSupervisorState({
        schemaVersion: 1,
        failure: {
          requestId: 'request-1',
          fromVersion: '1.4.0',
          targetVersion: '1.5.0',
          originRuntimeId: 'runtime-old',
          reason: 'raw stderr with a token'
        }
      })
    ).toBeNull()
    expect(await readNpmSupervisorState('/path/that/does/not/exist')).toEqual(
      emptyNpmSupervisorState()
    )
  })

  it('lets only the supervisor classify an interrupted pending handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-npm-state-'))
    roots.push(root)
    const pending = {
      requestId: 'request-1',
      fromVersion: '1.4.0',
      targetVersion: '1.5.0',
      originRuntimeId: 'runtime-old'
    }
    const state = { schemaVersion: 1 as const, pending }

    expect(npmSupervisorStartupFailure(state)).toBeUndefined()
    const recovered = await recoverInterruptedNpmHandoff(root, state)

    expect(recovered).toMatchObject({
      failure: { ...pending, reason: 'npm_update_supervisor_interrupted' }
    })
    expect(recovered).not.toHaveProperty('pending')
  })
})
