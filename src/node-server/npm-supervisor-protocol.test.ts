import { describe, expect, it } from 'vitest'
import { isExactNpmVersion, parseNpmSupervisorMessage } from './npm-supervisor-protocol'

describe('npm supervisor protocol', () => {
  it('accepts exact worker readiness and activation messages', () => {
    expect(
      parseNpmSupervisorMessage({
        type: 'orca:npm-worker-ready',
        protocolVersion: 1,
        version: '1.5.0-rc.2',
        runtimeId: 'runtime-new'
      })
    ).toMatchObject({ version: '1.5.0-rc.2' })
    expect(
      parseNpmSupervisorMessage({
        type: 'orca:npm-update-activate',
        protocolVersion: 1,
        requestId: 'request-1',
        fromVersion: '1.4.0',
        targetVersion: '1.5.0',
        runtimeId: 'runtime-old'
      })
    ).toMatchObject({ targetVersion: '1.5.0' })
    expect(
      parseNpmSupervisorMessage({
        type: 'orca:npm-worker-stop',
        protocolVersion: 1,
        signal: 'SIGTERM'
      })
    ).toMatchObject({ signal: 'SIGTERM' })
  })

  it('rejects tags, ranges, empty identities, and unknown messages', () => {
    expect(isExactNpmVersion('v1.5.0')).toBe(false)
    expect(isExactNpmVersion('latest')).toBe(false)
    expect(isExactNpmVersion('^1.5.0')).toBe(false)
    expect(isExactNpmVersion('01.5.0')).toBe(false)
    expect(isExactNpmVersion('1.5.0-01')).toBe(false)
    expect(isExactNpmVersion('1.5.0-rc.')).toBe(false)
    expect(
      parseNpmSupervisorMessage({
        type: 'orca:npm-update-activate',
        protocolVersion: 1,
        requestId: '',
        fromVersion: '1.4.0',
        targetVersion: 'latest',
        runtimeId: 'runtime-old'
      })
    ).toBeNull()
    expect(parseNpmSupervisorMessage({ type: 'orca:npm-update-complete' })).toBeNull()
    expect(
      parseNpmSupervisorMessage({
        type: 'orca:npm-worker-stop',
        protocolVersion: 1,
        signal: 'SIGKILL'
      })
    ).toBeNull()
  })
})
