/**
 * Ref and worktree-operation helpers shared by the Git write operations.
 *
 * These answer the checks every write runs first (which branch is checked out,
 * whether a ref exists or is valid, whether a revision resolves to a commit)
 * and run abortable worktree operations so a failed merge, rebase,
 * cherry-pick, or revert never touches an unrelated in-progress operation.
 */

import { badRequest, outputTooLarge, VcsError } from './errors.js'
import { redactDetail } from './git-utils.js'

/** Reset modes a commit reset may choose. */
export const RESET_MODES = new Set(['soft', 'mixed', 'hard'])

/**
 * The symbolic name of the checked-out branch, or an empty string when HEAD is detached.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>} the branch name, or an empty string.
 */
export async function currentBranch(git, root, signal) {
  const result = await git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal })
  return result.exitCode === 0 ? result.stdout.trim() : ''
}

/**
 * Resolve one revision to a commit id.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} revision - revision expression.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string | null>} the id, or null when it does not resolve.
 */
export async function commitAt(git, root, revision, signal) {
  const result = await git.run(['rev-parse', '-q', '--verify', `${revision}^{commit}`], { cwd: root, signal })
  if (result.exitCode !== 0) return null
  const id = result.stdout.trim()
  return id === '' ? null : id
}

/**
 * Whether an exact full ref (e.g. `refs/heads/main`, `refs/tags/v1`) exists.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} fullRef - full ref name.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<boolean>} true when the ref exists.
 */
export async function refExists(git, root, fullRef, signal) {
  const result = await git.run(['show-ref', '--verify', '--quiet', fullRef], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  return result.exitCode === 0
}

/**
 * Validate a full ref name with `git check-ref-format`, rejecting revision syntax.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} fullRef - full ref name such as `refs/heads/<name>` or `refs/tags/<name>`.
 * @param {string} invalidCode - VcsError code when malformed.
 * @param {string} invalidMessage - browser-safe error message when malformed.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
export async function validateRefFormat(git, root, fullRef, invalidCode, invalidMessage, signal) {
  // The full ref is checked, not `--branch`: `--branch` also expands `@{…}`
  // syntax, which would let a revision expression through as a new name.
  const checked = await git.run(['check-ref-format', fullRef], { cwd: root, signal })
  if (checked.exitCode !== 0) {
    throw new VcsError(invalidCode, invalidMessage)
  }
}

/**
 * Confirm one local branch exists in `refs/heads/` and whether it is checked out.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - local branch name.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ name: string, current: boolean }>} branch state.
 */
export async function requireLocalBranch(git, root, branch, signal) {
  const [exists, current] = await Promise.all([
    refExists(git, root, `refs/heads/${branch}`, signal),
    currentBranch(git, root, signal),
  ])
  if (!exists) {
    throw badRequest('That branch is not a local branch of this repository.')
  }
  return { name: branch, current: current === branch }
}

/**
 * Undo an operation this panel started, and only that one.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} stateHead - sentinel ref (`MERGE_HEAD`, `REBASE_HEAD`, etc.).
 * @param {string[]} abortArgs - git abort command argv.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
async function abortIfStarted(git, root, stateHead, abortArgs, signal) {
  try {
    if (await commitAt(git, root, stateHead, signal) !== null) {
      await git.run(abortArgs, { cwd: root, signal })
    }
  } catch {
    // The original failure is the answer; a failed cleanup cannot improve it.
  }
}

/** Undo a merge this panel started, and only that one. */
export function abortMergeIfStarted(git, root, signal) {
  return abortIfStarted(git, root, 'MERGE_HEAD', ['merge', '--abort'], signal)
}

/** Undo a rebase this panel started, and only that one. */
export function abortRebaseIfStarted(git, root, signal) {
  return abortIfStarted(git, root, 'REBASE_HEAD', ['rebase', '--abort'], signal)
}

/** Undo a cherry-pick this panel started, and only that one. */
export function abortCherryPickIfStarted(git, root, signal) {
  return abortIfStarted(git, root, 'CHERRY_PICK_HEAD', ['cherry-pick', '--abort'], signal)
}

/** Undo a revert this panel started, and only that one. */
export function abortRevertIfStarted(git, root, signal) {
  return abortIfStarted(git, root, 'REVERT_HEAD', ['revert', '--abort'], signal)
}

/**
 * Run one abortable Git worktree operation (merge, rebase, cherry-pick, revert, drop).
 * Refuses to disturb an existing in-progress state head and aborts only the state
 * created by this invocation before delegating error classification to `onFailure`.
 *
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {{ stateHead: string, inProgressCode?: string, inProgressMessage?: string, preflight?: boolean, args: string[], abort: Function, onFailure: Function }} spec - operation spec.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<object>} the successful command result.
 */
export async function runAbortableOp(
  git,
  root,
  {
    stateHead,
    inProgressCode,
    inProgressMessage,
    preflight = true,
    args,
    abort,
    onFailure,
  },
  signal,
) {
  if (preflight && await commitAt(git, root, stateHead, signal) !== null) {
    throw new VcsError(inProgressCode, inProgressMessage)
  }
  let result
  try {
    result = await git.run(args, { cwd: root, signal })
  } catch (error) {
    await abort(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    const started = await commitAt(git, root, stateHead, signal) !== null
    await abort(git, root, signal)
    onFailure(result, started)
  }
  return result
}

/**
 * Merge one branch ref or commit id into the checked-out branch, aborting on conflict.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {{ targetRef: string, targetSha?: string | null, allowSelfBranch?: string | null, noBranchMessage?: string }} target - merge target.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ current: string, sha: string, result: 'fast-forward' | 'merged' | 'up-to-date' }>} outcome.
 */
export async function mergeRevisionIntoCurrent(
  git,
  root,
  {
    targetRef,
    targetSha = null,
    allowSelfBranch = null,
    noBranchMessage = 'Merging needs a checked-out branch.',
  },
  signal,
) {
  // An unfinished merge belongs to the user; never touch it.
  if (await commitAt(git, root, 'MERGE_HEAD', signal) !== null) {
    throw new VcsError('merge-blocked', 'A merge is already in progress in this repository.')
  }
  const current = await currentBranch(git, root, signal)
  if (current === '') throw badRequest(noBranchMessage)
  if (allowSelfBranch !== null && current === allowSelfBranch) {
    return { current, sha: targetSha ?? '', result: 'up-to-date' }
  }
  const [resolvedTarget, before] = await Promise.all([
    targetSha !== null ? Promise.resolve(targetSha) : commitAt(git, root, targetRef, signal),
    commitAt(git, root, 'HEAD', signal),
  ])
  if (resolvedTarget === null) throw badRequest('That branch has no commit to merge.')
  if (before === resolvedTarget) return { current, sha: resolvedTarget, result: 'up-to-date' }

  await runAbortableOp(git, root, {
    stateHead: 'MERGE_HEAD',
    preflight: false,
    args: ['merge', '--no-edit', '--quiet', targetRef],
    abort: abortMergeIfStarted,
    onFailure: result => {
      throw new VcsError(
        'merge-blocked',
        'The merge was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
        redactDetail(result.stderr),
      )
    },
  }, signal)

  const after = await commitAt(git, root, 'HEAD', signal)
  const outcome = after === before ? 'up-to-date' : after === resolvedTarget ? 'fast-forward' : 'merged'
  return { current, sha: resolvedTarget, result: outcome }
}

/**
 * Rebase the checked-out branch onto one branch or commit id, aborting on conflict.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {{ targetArg: string, targetSha?: string | null, allowSelfBranch?: string | null, noBranchMessage?: string }} target - new base.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ current: string }>} the checked-out branch.
 */
export async function rebaseCurrentOntoRevision(
  git,
  root,
  {
    targetArg,
    targetSha = null,
    allowSelfBranch = null,
    noBranchMessage = 'Rebasing needs a checked-out branch.',
  },
  signal,
) {
  // Check REBASE_HEAD before currentBranch: a stopped rebase leaves HEAD detached.
  if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
    throw new VcsError('rebase-blocked', 'A rebase is already in progress in this repository.')
  }
  const current = await currentBranch(git, root, signal)
  if (current === '') throw badRequest(noBranchMessage)
  if (allowSelfBranch !== null && current === allowSelfBranch) return { current }
  if (targetSha !== null && await commitAt(git, root, 'HEAD', signal) === targetSha) {
    return { current }
  }

  await runAbortableOp(git, root, {
    stateHead: 'REBASE_HEAD',
    preflight: false,
    args: ['rebase', targetArg],
    abort: abortRebaseIfStarted,
    onFailure: result => {
      throw new VcsError(
        'rebase-blocked',
        'The rebase was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
        redactDetail(result.stderr),
      )
    },
  }, signal)
  return { current }
}
