import { describe, expect, it } from 'vitest'
import { isExpectedInstalledServerStopResult } from './node-server-installed-process-harness'

describe('installed server stop result', () => {
  it('accepts only a clean application exit on POSIX', () => {
    expect(isExpectedInstalledServerStopResult({ code: 0, signal: null }, 'linux')).toBe(true)
    expect(isExpectedInstalledServerStopResult({ code: 0, signal: null }, 'darwin')).toBe(true)
    expect(isExpectedInstalledServerStopResult({ code: null, signal: 'SIGTERM' }, 'linux')).toBe(
      false
    )
    expect(isExpectedInstalledServerStopResult({ code: 1, signal: null }, 'linux')).toBe(false)
  })

  it('accepts only the Windows TerminateProcess result', () => {
    expect(isExpectedInstalledServerStopResult({ code: null, signal: 'SIGTERM' }, 'win32')).toBe(
      true
    )
    expect(isExpectedInstalledServerStopResult({ code: 0, signal: null }, 'win32')).toBe(false)
    expect(isExpectedInstalledServerStopResult({ code: 1, signal: null }, 'win32')).toBe(false)
    expect(isExpectedInstalledServerStopResult({ code: null, signal: 'SIGKILL' }, 'win32')).toBe(
      false
    )
  })
})
