import { randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as managedHookLockClaims from '../main/agent-hooks/managed-hook-lock-claims'
import { isManagedHookLockOwnerActive } from '../main/agent-hooks/managed-hook-lock-records'
import {
  readManagedHookHostIdentity,
  readManagedHookProcessIdentity
} from '../main/agent-hooks/managed-hook-owner-identity'
import {
  acquireServerProfileProcessLock,
  getServerProfileProcessLockDirectory,
  ServerProfileProcessLockError
} from './server-profile-process-lock'

const roots: string[] = []
const staleToken = '00000000-0000-4000-8000-000000000000'

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-server-profile-lock-'))
  roots.push(root)
  return root
}

async function currentIdentities(): Promise<{ host: string; process: string }> {
  const [host, processIdentity] = await Promise.all([
    readManagedHookHostIdentity(),
    readManagedHookProcessIdentity(process.pid)
  ])
  if (!processIdentity) {
    throw new Error('test process identity is unavailable')
  }
  return { host, process: processIdentity }
}

function paths(root: string): { directory: string; lock: string; owner: string } {
  const directory = getServerProfileProcessLockDirectory(root)
  return {
    directory,
    lock: join(directory, 'managed-hook-install.lock'),
    owner: join(directory, `managed-hook-install.owner-${staleToken}.json`)
  }
}

async function seedOwner(
  root: string,
  owner: { hostIdentity: string; pid: number; processIdentity: string; token?: string }
): Promise<void> {
  const lockPaths = paths(root)
  const token = owner.token ?? staleToken
  const ownerPath = join(lockPaths.directory, `managed-hook-install.owner-${token}.json`)
  await mkdir(lockPaths.directory, { recursive: true })
  await writeFile(ownerPath, JSON.stringify({ ...owner, token }))
  await link(ownerPath, lockPaths.lock)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('server profile process lock', () => {
  it('publishes a complete hard-linked owner record and releases it', async () => {
    const root = await createRoot()
    const lock = await acquireServerProfileProcessLock(root)
    const lockPaths = paths(root)
    const entries = await readdir(lockPaths.directory)
    const ownerName = entries.find((entry) => entry.startsWith('managed-hook-install.owner-'))
    expect(ownerName).toBeDefined()
    if (!ownerName) {
      throw new Error('owner record was not published')
    }
    const ownerPath = join(lockPaths.directory, ownerName)
    const owner = JSON.parse(await readFile(lockPaths.lock, 'utf8')) as {
      pid: number
      token: string
    }
    const [lockStats, ownerStats] = await Promise.all([lstat(lockPaths.lock), lstat(ownerPath)])

    expect(owner).toMatchObject({ pid: process.pid })
    expect(owner.token).toMatch(/^[\da-f-]{36}$/)
    expect(lockStats.ino).toBe(ownerStats.ino)
    expect(lockStats.nlink).toBe(2)

    await lock.release()
    expect(await readdir(lockPaths.directory)).toEqual([])
  })

  it('fails fast for a live owner without stealing it', async () => {
    const root = await createRoot()
    const first = await acquireServerProfileProcessLock(root)
    const before = await readFile(paths(root).lock, 'utf8')

    await expect(acquireServerProfileProcessLock(root)).rejects.toMatchObject({
      reason: 'already_owned',
      ownerPid: process.pid
    })
    expect(await readFile(paths(root).lock, 'utf8')).toBe(before)
    await first.release()
  })

  it('does not expire a live owner based on wall-clock age', async () => {
    const root = await createRoot()
    const first = await acquireServerProfileProcessLock(root)
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)

    await expect(acquireServerProfileProcessLock(root)).rejects.toMatchObject({
      reason: 'already_owned'
    })
    await first.release()
  })

  it('lets different profiles coexist', async () => {
    const firstRoot = await createRoot()
    const secondRoot = await createRoot()
    const [first, second] = await Promise.all([
      acquireServerProfileProcessLock(firstRoot),
      acquireServerProfileProcessLock(secondRoot)
    ])

    await Promise.all([first.release(), second.release()])
  })

  it('recovers a dead owner and a reused pid with a different incarnation', async () => {
    const deadRoot = await createRoot()
    const reusedRoot = await createRoot()
    const identities = await currentIdentities()
    await seedOwner(deadRoot, {
      hostIdentity: identities.host,
      pid: 2_000_000_000,
      processIdentity: 'dead'
    })
    await seedOwner(reusedRoot, {
      hostIdentity: identities.host,
      pid: process.pid,
      processIdentity: 'prior-incarnation'
    })
    const probes = {
      readHostIdentity: async () => identities.host,
      readProcessIdentity: async (pid: number) =>
        pid === 2_000_000_000 ? null : identities.process
    }

    const [deadRecovered, reusedRecovered] = await Promise.all([
      acquireServerProfileProcessLock(deadRoot, probes),
      acquireServerProfileProcessLock(reusedRoot, probes)
    ])
    await Promise.all([deadRecovered.release(), reusedRecovered.release()])
  })

  it('refuses foreign-host, unavailable, and malformed owners', async () => {
    const foreignRoot = await createRoot()
    const unavailableRoot = await createRoot()
    const malformedRoot = await createRoot()
    const identities = await currentIdentities()
    const unavailablePid = 2_000_000_003
    await seedOwner(foreignRoot, {
      hostIdentity: 'another-host',
      pid: process.pid,
      processIdentity: identities.process
    })
    await seedOwner(unavailableRoot, {
      hostIdentity: identities.host,
      pid: unavailablePid,
      processIdentity: 'unavailable-incarnation'
    })
    await mkdir(paths(malformedRoot).directory, { recursive: true })
    await writeFile(paths(malformedRoot).lock, '{')

    await expect(acquireServerProfileProcessLock(foreignRoot)).rejects.toMatchObject({
      reason: 'foreign_host'
    })
    await expect(
      acquireServerProfileProcessLock(unavailableRoot, {
        readHostIdentity: async () => identities.host,
        readProcessIdentity: async (pid) =>
          pid === unavailablePid ? undefined : identities.process
      })
    ).rejects.toMatchObject({ reason: 'unverifiable' })
    expect(JSON.parse(await readFile(paths(unavailableRoot).lock, 'utf8'))).toMatchObject({
      pid: unavailablePid,
      processIdentity: 'unavailable-incarnation'
    })
    await expect(acquireServerProfileProcessLock(malformedRoot)).rejects.toMatchObject({
      reason: 'unverifiable'
    })
  })

  it('allows only one contender to replace a stale generation', async () => {
    const root = await createRoot()
    const identities = await currentIdentities()
    const stalePid = 2_000_000_001
    await seedOwner(root, {
      hostIdentity: identities.host,
      pid: stalePid,
      processIdentity: 'dead'
    })
    const probes = {
      readHostIdentity: async () => identities.host,
      readProcessIdentity: async (pid: number) => (pid === stalePid ? null : identities.process)
    }

    const attempts = await Promise.allSettled([
      acquireServerProfileProcessLock(root, probes),
      acquireServerProfileProcessLock(root, probes)
    ])
    const acquired = attempts.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    const rejected = attempts.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )

    expect(acquired).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: 'already_owned' })
    const winner = acquired[0]
    if (!winner) {
      throw new Error('stale generation had no winner')
    }
    await winner.release()
  })

  it('recovers when a previous recovery claimant crashed', async () => {
    const root = await createRoot()
    const identities = await currentIdentities()
    const lockPaths = paths(root)
    const claimToken = randomUUID()
    const stalePid = 2_000_000_002
    await seedOwner(root, {
      hostIdentity: identities.host,
      pid: stalePid,
      processIdentity: 'dead'
    })
    const claimedOwner = join(
      lockPaths.directory,
      `managed-hook-install.claimed-${staleToken}-${claimToken}.json`
    )
    await writeFile(
      join(lockPaths.directory, `managed-hook-install.claim-${staleToken}-${claimToken}.json`),
      JSON.stringify({
        ownerToken: staleToken,
        claimToken,
        pid: stalePid,
        hostIdentity: identities.host,
        processIdentity: 'dead-claimant'
      })
    )
    await rename(lockPaths.owner, claimedOwner)

    const acquired = await acquireServerProfileProcessLock(root, {
      readHostIdentity: async () => identities.host,
      readProcessIdentity: async (pid) => (pid === stalePid ? null : identities.process)
    })
    await acquired.release()
    expect(await readdir(lockPaths.directory)).toEqual([])
  })

  it('does not let a late release remove a replacement generation', async () => {
    const root = await createRoot()
    const first = await acquireServerProfileProcessLock(root)
    const lockPaths = paths(root)
    await rename(lockPaths.lock, `${lockPaths.lock}.displaced`)
    const second = await acquireServerProfileProcessLock(root)
    const secondOwner = await readFile(lockPaths.lock, 'utf8')

    await first.release()
    expect(await readFile(lockPaths.lock, 'utf8')).toBe(secondOwner)
    await second.release()
  })

  it('makes release idempotent and recovers an abandoned same-process lock', async () => {
    const firstRoot = await createRoot()
    const abandonedRoot = await createRoot()
    const identities = await currentIdentities()
    const first = await acquireServerProfileProcessLock(firstRoot)
    await first.release()
    await expect(first.release()).resolves.toBeUndefined()

    await seedOwner(abandonedRoot, {
      hostIdentity: identities.host,
      pid: process.pid,
      processIdentity: identities.process
    })
    const recovered = await acquireServerProfileProcessLock(abandonedRoot)
    await recovered.release()
  })

  it('retries release after a transient removal failure', async () => {
    const root = await createRoot()
    const lock = await acquireServerProfileProcessLock(root)
    const owner = JSON.parse(await readFile(paths(root).lock, 'utf8')) as { token: string }
    const removeManagedHookLock = managedHookLockClaims.removeManagedHookLock
    const removeLock = vi.spyOn(managedHookLockClaims, 'removeManagedHookLock')
    removeLock.mockResolvedValueOnce('unverifiable').mockImplementationOnce(async (...args) => {
      expect(isManagedHookLockOwnerActive(owner.token)).toBe(true)
      return removeManagedHookLock(...args)
    })

    await expect(lock.release()).resolves.toBeUndefined()
    expect(removeLock).toHaveBeenCalledTimes(2)
    expect(isManagedHookLockOwnerActive(owner.token)).toBe(false)
  })

  it('surfaces a typed error when the current process cannot be identified', async () => {
    const root = await createRoot()
    const error = await acquireServerProfileProcessLock(root, {
      readHostIdentity: async () => 'host',
      readProcessIdentity: async () => undefined
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ServerProfileProcessLockError)
    expect(error).toMatchObject({ reason: 'unverifiable' })
  })
})
