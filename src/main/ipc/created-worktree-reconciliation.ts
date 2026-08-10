import { areWorktreePathsEqual } from './worktree-path-comparison'

export function findCreatedWorktree<T extends { path: string; branch?: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  branchName: string,
  platform = process.platform
): T | undefined {
  const direct = worktrees.find((worktree) =>
    areWorktreePathsEqual(worktree.path, requestedPath, platform)
  )
  if (direct) {
    return direct
  }

  return worktrees.find((worktree) => worktree.branch === `refs/heads/${branchName}`)
}

export function findCreatedWorktreeForRollback<T extends { path: string; branch?: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  branchName: string,
  resolvedRequestedPath?: string,
  platform = process.platform
): T | undefined {
  const expectedBranch = `refs/heads/${branchName}`
  return worktrees.find(
    (worktree) =>
      worktree.branch === expectedBranch &&
      (areWorktreePathsEqual(worktree.path, requestedPath, platform) ||
        (resolvedRequestedPath !== undefined &&
          areWorktreePathsEqual(worktree.path, resolvedRequestedPath, platform)))
  )
}
