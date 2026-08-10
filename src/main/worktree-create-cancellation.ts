export const WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS = 10_000

export function createWorktreeRollbackSignal(): AbortSignal {
  return AbortSignal.timeout(WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS)
}

export class WorktreeCreateCancellation {
  private rollback: (() => Promise<void>) | null = null
  private rollbackOnFailure = false
  private rollbackPromise: Promise<void> | null = null
  private releases: (() => void)[] = []

  constructor(readonly signal?: AbortSignal) {}

  registerRollback(rollback: () => Promise<void>, options: { onFailure?: boolean } = {}): void {
    this.rollback = rollback
    this.rollbackOnFailure = options.onFailure === true
  }

  disableRollbackOnFailure(): void {
    this.rollbackOnFailure = false
  }

  registerRelease(release: () => void): void {
    this.releases.push(release)
  }

  checkpoint(): void {
    this.signal?.throwIfAborted()
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation()
      this.signal?.throwIfAborted()
      return result
    } catch (error) {
      if ((!this.signal?.aborted && !this.rollbackOnFailure) || !this.rollback) {
        throw error
      }
      try {
        this.rollbackPromise ??= this.rollback()
        await this.rollbackPromise
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          this.signal?.aborted
            ? 'Cancelled worktree creation rollback failed.'
            : 'Worktree creation rollback failed.'
        )
      }
      throw error
    } finally {
      for (const release of this.releases.splice(0)) {
        release()
      }
    }
  }
}
