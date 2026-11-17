/**
 * Git branch operations: rename, delete, merge, rebase, and push one branch.
 *
 * These are the writes behind the branch actions menu. Each operation changes
 * exactly the ref the menu names and leaves every other ref alone: rename and
 * delete never touch a commit, merge only moves the checked-out branch forward
 * or adds one merge commit, rebase rewrites only the checked-out branch, and
 * push never forces. A merge or rebase that conflicts is aborted before the
 * error is reported, so a refused operation leaves the repository as it was.
 *
 * argv is fixed strings plus values already validated by the route and checked
 * against the local branch list; no value is ever read from a shell.
 */

import { REMOTE_TIMEOUT_MS } from './command.js'
import { badRequest, VcsError } from './errors.js'
import { configValue, MERGE_REF, redactDetail, UNSAFE_NAME } from './git-utils.js'

/** The symbolic name of the checked-out branch, or an empty string when HEAD is detached. */
async function currentBranch(git, root, signal) {
  const result = await git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal })
  return result.exitCode === 0 ? result.stdout.trim() : ''
}

/**
 * Resolve one revision to a commit id.
 * @returns {Promise<string | null>} the id, or null when it does not resolve.
 */
async function commitAt(git, root, revision, signal) {
  const result = await git.run(['rev-parse', '-q', '--verify', `${revision}^{commit}`], { cwd: root, signal })
  if (result.exitCode !== 0) return null
  const id = result.stdout.trim()
  return id === '' ? null : id
}

/** A local branch's ref exists. */
async function refExists(git, root, name, signal) {
  const result = await git.run(['rev-parse', '-q', '--verify', `refs/heads/${name}`], { cwd: root, signal })
  return result.exitCode === 0
}

/**
 * Undo a merge this panel started, and only that one.
 *
 * A conflict, a hook, or a deadline can leave a merge half applied. The abort
 * restores the index and working tree the merge had touched; when the command
 * never reached a merge state there is nothing to undo.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
async function abortMergeIfStarted(git, root, signal) {
  try {
    if (await commitAt(git, root, 'MERGE_HEAD', signal) !== null) {
      await git.run(['merge', '--abort'], { cwd: root, signal })
    }
  } catch {
    // The original failure is the answer; a failed cleanup cannot improve it.
  }
}

/**
 * Undo a rebase this panel started, and only that one.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
async function abortRebaseIfStarted(git, root, signal) {
  try {
    if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
      await git.run(['rebase', '--abort'], { cwd: root, signal })
    }
  } catch {
    // The original failure is the answer; a failed cleanup cannot improve it.
  }
}

/**
 * Classify a failed branch command into one stable error.
 * @param {string} stderr - the command's stderr tail.
 * @param {string} fallback - message for an unclassified failure.
 * @param {{ deletion?: boolean }} [context] - whether the command was a delete.
 * @returns {VcsError} the route error.
 */
function branchFailure(stderr, fallback, { deletion = false } = {}) {
  if (deletion && /not fully merged/iu.test(stderr)) {
    return new VcsError(
      'branch-unmerged',
      'This branch is not fully merged. Delete it anyway to remove its commits.',
      redactDetail(stderr),
    )
  }
  if (deletion && /checked out at/iu.test(stderr)) {
    return new VcsError(
      'branch-in-use',
      'This branch is checked out and cannot be deleted.',
      redactDetail(stderr),
    )
  }
  if (/already exists/iu.test(stderr)) {
    return new VcsError('branch-exists', 'A branch with that name already exists.', redactDetail(stderr))
  }
  if (/not a valid branch name|invalid branch name/iu.test(stderr)) {
    return new VcsError('branch-invalid', 'That name is not a valid branch name.', redactDetail(stderr))
  }
  return new VcsError('branch-failed', fallback, redactDetail(stderr))
}

/**
 * Rename one local branch, preserving its upstream configuration.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - the existing local branch, already checked by the backend.
 * @param {string} name - the new name, already checked by the route.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ from: string, branch: string }>} the two names.
 */
export async function renameGitBranch(git, root, branch, name, signal) {
  if (branch === name) return { from: branch, branch }
  // The full ref is checked, not `--branch`: `--branch` also expands `@{…}`
  // syntax, which would let a revision expression through as a new name.
  const checked = await git.run(['check-ref-format', `refs/heads/${name}`], { cwd: root, signal })
  if (checked.exitCode !== 0) {
    throw new VcsError('branch-invalid', 'That name is not a valid branch name.')
  }
  if (await refExists(git, root, name, signal)) {
    throw new VcsError('branch-exists', 'A branch with that name already exists.')
  }
  const result = await git.run(['branch', '-m', branch, name], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw branchFailure(result.stderr, 'The branch could not be renamed.')
  }
  return { from: branch, branch: name }
}

/**
 * Delete one local branch. `force` is only reached after the confirmation
 * dialog has shown that the branch is not fully merged.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - the local branch, already checked by the backend.
 * @param {boolean} force - delete even when Git would keep an unmerged branch.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ branch: string }>} the deleted branch.
 */
export async function deleteGitBranch(git, root, branch, force, signal) {
  const result = await git.run(['branch', force ? '-D' : '-d', branch], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw branchFailure(result.stderr, 'The branch could not be deleted.', { deletion: true })
  }
  return { branch }
}

/**
 * Merge one local branch into the checked-out branch.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - the source branch, already checked by the backend.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ branch: string, current: string, result: 'fast-forward' | 'merged' | 'up-to-date' }>} what happened.
 */
export async function mergeGitBranch(git, root, branch, signal) {
  // An unfinished merge belongs to the user; never touch it.
  if (await commitAt(git, root, 'MERGE_HEAD', signal) !== null) {
    throw new VcsError('merge-blocked', 'A merge is already in progress in this repository.')
  }

  const current = await currentBranch(git, root, signal)
  if (current === '') throw badRequest('Merging needs a checked-out branch.')
  if (current === branch) return { branch, current, result: 'up-to-date' }

  const target = await commitAt(git, root, `refs/heads/${branch}`, signal)
  if (target === null) throw badRequest('That branch has no commit to merge.')
  const before = await commitAt(git, root, 'HEAD', signal)

  let result
  try {
    result = await git.run(['merge', '--no-edit', '--quiet', branch], { cwd: root, signal })
  } catch (error) {
    // A deadline or a failed spawn can leave a merge in progress; undo the
    // one this command started, then report the original failure.
    await abortMergeIfStarted(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    // A conflicted or refused merge may have written the index and working
    // tree; undo only the merge this command started so the branch is exactly
    // where it was.
    await abortMergeIfStarted(git, root, signal)
    throw new VcsError(
      'merge-blocked',
      'The merge was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
      redactDetail(result.stderr),
    )
  }

  const after = await commitAt(git, root, 'HEAD', signal)
  const outcome = after === before ? 'up-to-date' : after === target ? 'fast-forward' : 'merged'
  return { branch, current, result: outcome }
}

/**
 * Rebase the checked-out branch onto another local branch.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - the new base, already checked by the backend.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ branch: string, current: string }>} the branch and its new base.
 */
export async function rebaseGitBranch(git, root, branch, signal) {
  // An unfinished rebase belongs to the user; never touch it. This comes
  // before the checked-out branch check because a stopped rebase has a
  // detached HEAD and no branch to read.
  if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
    throw new VcsError('rebase-blocked', 'A rebase is already in progress in this repository.')
  }

  const current = await currentBranch(git, root, signal)
  if (current === '') throw badRequest('Rebasing needs a checked-out branch.')
  if (current === branch) return { branch, current }

  let result
  try {
    result = await git.run(['rebase', branch], { cwd: root, signal })
  } catch (error) {
    await abortRebaseIfStarted(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    // A conflict stops the rebase with a detached HEAD and a dirty tree. Abort
    // only the rebase this command started, restoring the branch tip so a
    // reported conflict leaves history intact.
    await abortRebaseIfStarted(git, root, signal)
    throw new VcsError(
      'rebase-blocked',
      'The rebase was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
      redactDetail(result.stderr),
    )
  }
  return { branch, current }
}

/**
 * Push one local branch to its configured upstream. Unlike sync this does not
 * fetch or fast-forward: the menu action only sends the branch.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - the local branch, already checked by the backend.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ branch: string, upstream: string, pushed: boolean }>} where it went.
 */
export async function pushGitBranch(git, root, branch, signal) {
  const tip = await commitAt(git, root, `refs/heads/${branch}`, signal)
  if (tip === null) throw badRequest('The branch has no commits to push.')

  const remote = await configValue(git, root, `branch.${branch}.remote`, signal)
  const merge = await configValue(git, root, `branch.${branch}.merge`, signal)
  if (remote === null || merge === null || remote === '.'
    || UNSAFE_NAME.test(remote) || !MERGE_REF.test(merge)) {
    throw new VcsError('no-upstream', 'This branch has no upstream to push to.')
  }

  const result = await git.run(
    ['push', '--porcelain', remote, `refs/heads/${branch}:${merge}`],
    { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    const refused = result.stdout.split('\n').find(line => line.startsWith('!')) ?? ''
    throw new VcsError(
      'remote-failed',
      'The remote did not accept the push.',
      redactDetail(`${result.stderr}\n${refused}`),
    )
  }
  // Porcelain starts with a `To <remote>` header and ends with `Done`; the
  // ref lines between them start with a flag, '=' meaning already up to date.
  const output = result.stdout.split('\n')
    .filter(line => line !== '' && line !== 'Done' && !line.startsWith('To '))
  return {
    branch,
    upstream: `${remote}/${merge.slice('refs/heads/'.length)}`,
    pushed: output.some(line => !line.startsWith('=')),
  }
}
