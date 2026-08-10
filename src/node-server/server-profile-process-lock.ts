import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { removeManagedHookLock } from '../main/agent-hooks/managed-hook-lock-claims'
import {
  deactivateManagedHookLockOwner,
  inspectManagedHookLock,
  isManagedHookLockOwnerActive,
  tryCreateManagedHookLock,
  type ManagedHookLockOwner
} from '../main/agent-hooks/managed-hook-lock-records'
import {
  readManagedHookHostIdentity,
  readManagedHookProcessIdentity
} from '../main/agent-hooks/managed-hook-owner-identity'

const MAX_RECOVERY_ATTEMPTS = 32

export type ServerProfileProcessLock = {
  ownerPid: number
  release: () => Promise<void>
}

export type ServerProfileProcessLockFailure =
  | 'already_owned'
  | 'foreign_host'
  | 'recovery_contended'
  | 'release_failed'
  | 'unverifiable'

export class ServerProfileProcessLockError extends Error {
  constructor(
    readonly reason: ServerProfileProcessLockFailure,
    message: string,
    readonly ownerPid?: number
  ) {
    super(message)
    this.name = 'ServerProfileProcessLockError'
  }
}

type ServerProfileProcessLockProbes = {
  readHostIdentity: () => Promise<string>
  readProcessIdentity: (pid: number) => Promise<string | null | undefined>
}

const defaultProbes: ServerProfileProcessLockProbes = {
  readHostIdentity: readManagedHookHostIdentity,
  readProcessIdentity: readManagedHookProcessIdentity
}

export function getServerProfileProcessLockDirectory(dataPath: string): string {
  return join(dataPath, '.server-profile-process-lock')
}

export async function acquireServerProfileProcessLock(
  dataPath: string,
  probes: ServerProfileProcessLockProbes = defaultProbes
): Promise<ServerProfileProcessLock> {
  const lockParent = getServerProfileProcessLockDirectory(dataPath)
  const lockPath = join(lockParent, 'managed-hook-install.lock')
  await mkdir(lockParent, { recursive: true, mode: 0o700 })
  const [hostIdentity, processIdentity] = await Promise.all([
    probes.readHostIdentity(),
    probes.readProcessIdentity(process.pid)
  ])
  if (!processIdentity) {
    throw new ServerProfileProcessLockError(
      'unverifiable',
      'Could not identify the Orca server process'
    )
  }

  for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    const owner = await tryCreateManagedHookLock(
      lockParent,
      lockPath,
      hostIdentity,
      processIdentity
    )
    if (owner) {
      return createOwnedLock(lockPath, lockParent, owner, hostIdentity, processIdentity)
    }

    const state = await inspectManagedHookLock(lockPath)
    if (state.kind === 'missing') {
      continue
    }
    if (state.kind === 'unknown') {
      throw new ServerProfileProcessLockError(
        'unverifiable',
        'The Orca server profile lock has an unverifiable owner'
      )
    }
    if (state.owner.hostIdentity !== hostIdentity) {
      throw new ServerProfileProcessLockError(
        'foreign_host',
        'The Orca server profile lock belongs to another host',
        state.owner.pid
      )
    }

    const currentIdentity = await probes.readProcessIdentity(state.owner.pid)
    if (currentIdentity === undefined) {
      throw new ServerProfileProcessLockError(
        'unverifiable',
        'Could not verify the Orca server profile lock owner',
        state.owner.pid
      )
    }
    const abandonedOwnLock =
      state.owner.pid === process.pid &&
      currentIdentity === processIdentity &&
      !isManagedHookLockOwnerActive(state.owner.token)
    if (
      currentIdentity !== null &&
      currentIdentity === state.owner.processIdentity &&
      !abandonedOwnLock
    ) {
      throw new ServerProfileProcessLockError(
        'already_owned',
        `Another Orca server process (${state.owner.pid}) owns this profile`,
        state.owner.pid
      )
    }

    const removal = await removeManagedHookLock(
      lockPath,
      lockParent,
      state.owner,
      hostIdentity,
      processIdentity
    )
    if (removal === 'removed' || removal === 'active') {
      continue
    }
    throw removal === 'foreign'
      ? new ServerProfileProcessLockError(
          'foreign_host',
          'Orca server profile lock recovery belongs to another host',
          state.owner.pid
        )
      : new ServerProfileProcessLockError(
          'unverifiable',
          'Orca server profile lock recovery could not verify ownership',
          state.owner.pid
        )
  }

  throw new ServerProfileProcessLockError(
    'recovery_contended',
    'Orca server profile lock recovery remained contended'
  )
}

function createOwnedLock(
  lockPath: string,
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string
): ServerProfileProcessLock {
  let released = false
  return {
    ownerPid: owner.pid,
    release: async () => {
      if (released) {
        return
      }
      released = true
      try {
        const removal = await removeManagedHookLock(
          lockPath,
          lockParent,
          owner,
          hostIdentity,
          processIdentity
        )
        if (removal !== 'removed') {
          throw new ServerProfileProcessLockError(
            'release_failed',
            `Could not release the Orca server profile lock: ${removal}`,
            owner.pid
          )
        }
      } finally {
        deactivateManagedHookLockOwner(owner.token)
      }
    }
  }
}
