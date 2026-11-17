/**
 * Git commit operations: tag, branch, checkout, cherry-pick, revert, drop,
 * merge, rebase, and reset, all aimed at one commit.
 *
 * These are the writes behind the commit actions menu. They follow the same
 * shape as the branch actions: an operation changes one named ref or the
 * checked-out branch, a conflict is aborted before the error is reported, and
 * a refused operation leaves the repository as it was. Tagging and creating a
 * branch only add a ref; checkout detaches HEAD; cherry-pick and revert add a
 * commit; merge adds a merge or fast-forwards; rebase and drop rewrite the
 * checked-out branch; reset moves it and chooses how much of the index and
 * working tree to keep. Nothing is force-pushed.
 *
 * argv is fixed strings plus values already checked by the route and by this
 * module; no value is ever read from a shell.
 */

import { badRequest, notFound, VcsError } from './errors.js'
import { redactDetail } from './git-utils.js'
import {
  abortCherryPickIfStarted,
  abortMergeIfStarted,
  abortRebaseIfStarted,
  abortRevertIfStarted,
  commitAt,
  currentBranch,
} from './ref-utils.js'

/** Reset modes a commit reset may choose. */
export const RESET_MODES = new Set(['soft', 'mixed', 'hard'])

/** Whether stderr says the working tree or index blocked the command. */
function workingTreeBlocked(stderr) {
  return /local changes|would be overwritten|untracked working tree files|uncommitted changes|index contains|unstaged changes/iu.test(stderr)
}

/**
 * Resolve one request revision to a full commit id.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - hexadecimal commit id.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>} the resolved commit id.
 */
async function requireCommit(git, root, rawSha, signal) {
  const sha = await commitAt(git, root, rawSha, signal)
  if (sha === null) throw notFound('That commit is not available.')
  return sha
}

/**
 * The checked-out branch, or a refusal when HEAD is detached.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>} the branch name.
 */
async function requireCurrentBranch(git, root, signal) {
  const branch = await currentBranch(git, root, signal)
  if (branch === '') throw badRequest('This action needs a checked-out branch.')
  return branch
}

/** Whether a full ref exists. */
async function refExists(git, root, ref, signal) {
  const result = await git.run(['rev-parse', '-q', '--verify', ref], { cwd: root, signal })
  return result.exitCode === 0
}

/**
 * Split one `<commit> <parent>...` line into the commit and its parents.
 * @param {string} stdout - `git rev-list --parents -n 1` output.
 * @returns {{ sha: string, parents: string[] } | null} the parsed line.
 */
function parseParents(stdout) {
  const line = stdout.trim().split('\n')[0] ?? ''
  const [sha, ...parents] = line.split(/\s+/u).filter(part => part !== '')
  if (sha === undefined) return null
  return { sha, parents }
}

/**
 * Map a failed checkout to the stable error.
 * @param {string} stderr - the command's stderr tail.
 * @returns {VcsError} the route error.
 */
function checkoutFailure(stderr) {
  if (workingTreeBlocked(stderr) || /already checked out/iu.test(stderr)) {
    return new VcsError(
      'checkout-blocked',
      'Git refused to check out the commit because local changes would be overwritten.',
      redactDetail(stderr),
    )
  }
  return new VcsError('commit-failed', 'The commit could not be checked out.', redactDetail(stderr))
}

/**
 * Map a failed work-tree operation to the stable error.
 * @param {string} stderr - the command's stderr tail.
 * @param {string} fallback - message for an unclassified failure.
 * @returns {VcsError} the route error.
 */
function workTreeFailure(stderr, fallback) {
  if (workingTreeBlocked(stderr)) {
    return new VcsError(
      'commit-blocked',
      'Git refused the operation because local changes would be overwritten or another operation is in progress.',
      redactDetail(stderr),
    )
  }
  return new VcsError('commit-failed', fallback, redactDetail(stderr))
}

/**
 * Create one tag at a commit. A message makes the tag annotated.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} tag - the new tag name, already checked by the route.
 * @param {string} rawSha - the commit to tag.
 * @param {string} message - optional annotation message.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ tag: string, sha: string }>} the tag and its commit.
 */
export async function addGitTag(git, root, tag, rawSha, message, signal) {
  const checked = await git.run(['check-ref-format', `refs/tags/${tag}`], { cwd: root, signal })
  if (checked.exitCode !== 0) {
    throw new VcsError('tag-invalid', 'That is not a valid tag name.')
  }
  if (await refExists(git, root, `refs/tags/${tag}`, signal)) {
    throw new VcsError('tag-exists', 'A tag with that name already exists.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  const args = message === ''
    ? ['tag', tag, sha]
    : ['tag', '--annotate', '--message', message, tag, sha]
  const result = await git.run(args, { cwd: root, signal })
  if (result.exitCode !== 0) {
    const stderr = result.stderr
    if (/already exists/iu.test(stderr)) {
      throw new VcsError('tag-exists', 'A tag with that name already exists.', redactDetail(stderr))
    }
    throw new VcsError('tag-failed', 'The tag could not be created.', redactDetail(stderr))
  }
  return { tag, sha }
}

/**
 * Create one local branch at a commit without checking it out.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - the new branch name, already checked by the route.
 * @param {string} rawSha - the commit the branch points at.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ branch: string, sha: string }>} the branch and its commit.
 */
export async function createGitBranch(git, root, branch, rawSha, signal) {
  const checked = await git.run(['check-ref-format', `refs/heads/${branch}`], { cwd: root, signal })
  if (checked.exitCode !== 0) {
    throw new VcsError('branch-invalid', 'That name is not a valid branch name.')
  }
  if (await refExists(git, root, `refs/heads/${branch}`, signal)) {
    throw new VcsError('branch-exists', 'A branch with that name already exists.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  const result = await git.run(['branch', branch, sha], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw new VcsError('branch-failed', 'The branch could not be created.', redactDetail(result.stderr))
  }
  return { branch, sha }
}

/**
 * Check out one commit with a detached HEAD.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - the commit to check out.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sha: string }>} the checked-out commit.
 */
export async function checkoutGitCommit(git, root, rawSha, signal) {
  const sha = await requireCommit(git, root, rawSha, signal)
  const result = await git.run(['switch', '--detach', '--quiet', sha], { cwd: root, signal })
  if (result.exitCode !== 0) throw checkoutFailure(result.stderr)
  return { sha }
}

/**
 * Cherry-pick one commit onto the checked-out branch.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - the commit to pick.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sha: string, current: string }>} the picked commit and branch.
 */
export async function cherryPickGitCommit(git, root, rawSha, signal) {
  const current = await requireCurrentBranch(git, root, signal)
  if (await commitAt(git, root, 'CHERRY_PICK_HEAD', signal) !== null) {
    throw new VcsError('commit-blocked', 'Another cherry-pick is already in progress.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  let result
  try {
    result = await git.run(['cherry-pick', sha], { cwd: root, signal })
  } catch (error) {
    await abortCherryPickIfStarted(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    const started = await commitAt(git, root, 'CHERRY_PICK_HEAD', signal) !== null
    await abortCherryPickIfStarted(git, root, signal)
    if (started) {
      throw new VcsError(
        'commit-conflict',
        'The cherry-pick hit a conflict and was aborted; the branch was left unchanged.',
        redactDetail(result.stderr),
      )
    }
    throw workTreeFailure(result.stderr, 'The commit could not be cherry-picked.')
  }
  return { sha, current }
}

/**
 * Revert one commit on the checked-out branch.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - the commit to revert.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sha: string, current: string }>} the reverted commit and branch.
 */
export async function revertGitCommit(git, root, rawSha, signal) {
  const current = await requireCurrentBranch(git, root, signal)
  if (await commitAt(git, root, 'REVERT_HEAD', signal) !== null) {
    throw new VcsError('commit-blocked', 'Another revert is already in progress.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  let result
  try {
    result = await git.run(['revert', '--no-edit', sha], { cwd: root, signal })
  } catch (error) {
    await abortRevertIfStarted(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    const started = await commitAt(git, root, 'REVERT_HEAD', signal) !== null
    await abortRevertIfStarted(git, root, signal)
    if (started) {
      throw new VcsError(
        'commit-conflict',
        'The revert hit a conflict and was aborted; the branch was left unchanged.',
        redactDetail(result.stderr),
      )
    }
    throw workTreeFailure(result.stderr, 'The commit could not be reverted.')
  }
  return { sha, current }
}

/**
 * Drop one commit from the checked-out branch by rebasing its descendants
 * onto its parent. The commit must be a single-parent ancestor of HEAD.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - the commit to drop.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sha: string, current: string }>} the dropped commit and branch.
 */
export async function dropGitCommit(git, root, rawSha, signal) {
  const current = await requireCurrentBranch(git, root, signal)
  if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
    throw new VcsError('commit-blocked', 'A rebase is already in progress in this repository.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)

  const ancestor = await git.run(['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, signal })
  if (ancestor.exitCode !== 0) {
    throw new VcsError('commit-not-on-branch', 'That commit is not on the checked-out branch.')
  }
  const parentsResult = await git.run(['rev-list', '--parents', '-n', '1', sha], { cwd: root, signal })
  const parsed = parseParents(parentsResult.stdout)
  if (parsed === null || parsed.parents.length !== 1) {
    throw new VcsError(
      'commit-blocked',
      'Only a commit with one parent can be dropped from the branch.',
      redactDetail(parentsResult.stderr),
    )
  }

  let result
  try {
    result = await git.run(
      ['rebase', '--onto', parsed.parents[0], sha, current],
      { cwd: root, signal },
    )
  } catch (error) {
    await abortRebaseIfStarted(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    const started = await commitAt(git, root, 'REBASE_HEAD', signal) !== null
    await abortRebaseIfStarted(git, root, signal)
    if (started) {
      throw new VcsError(
        'commit-conflict',
        'The drop hit a conflict and was aborted; the branch was left unchanged.',
        redactDetail(result.stderr),
      )
    }
    throw workTreeFailure(result.stderr, 'The commit could not be dropped.')
  }
  return { sha, current }
}

/**
 * Merge one commit into the checked-out branch.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - the commit to merge.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sha: string, current: string, result: 'fast-forward' | 'merged' | 'up-to-date' }>} what happened.
 */
export async function mergeGitCommit(git, root, rawSha, signal) {
  if (await commitAt(git, root, 'MERGE_HEAD', signal) !== null) {
    throw new VcsError('merge-blocked', 'A merge is already in progress in this repository.')
  }
  const current = await requireCurrentBranch(git, root, signal)
  const sha = await requireCommit(git, root, rawSha, signal)
  const before = await commitAt(git, root, 'HEAD', signal)
  if (before === sha) return { sha, current, result: 'up-to-date' }

  let result
  try {
    result = await git.run(['merge', '--no-edit', '--quiet', sha], { cwd: root, signal })
  } catch (error) {
    await abortMergeIfStarted(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    await abortMergeIfStarted(git, root, signal)
    throw new VcsError(
      'merge-blocked',
      'The merge was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
      redactDetail(result.stderr),
    )
  }

  const after = await commitAt(git, root, 'HEAD', signal)
  const outcome = after === before ? 'up-to-date' : after === sha ? 'fast-forward' : 'merged'
  return { sha, current, result: outcome }
}

/**
 * Rebase the checked-out branch onto one commit.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - the new base commit.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sha: string, current: string }>} the commit and branch.
 */
export async function rebaseGitCommit(git, root, rawSha, signal) {
  if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
    throw new VcsError('rebase-blocked', 'A rebase is already in progress in this repository.')
  }
  const current = await requireCurrentBranch(git, root, signal)
  const sha = await requireCommit(git, root, rawSha, signal)
  if (await commitAt(git, root, 'HEAD', signal) === sha) return { sha, current }

  let result
  try {
    result = await git.run(['rebase', sha], { cwd: root, signal })
  } catch (error) {
    await abortRebaseIfStarted(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    await abortRebaseIfStarted(git, root, signal)
    throw new VcsError(
      'rebase-blocked',
      'The rebase was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
      redactDetail(result.stderr),
    )
  }
  return { sha, current }
}

/**
 * Move the checked-out branch to one commit with the chosen reset mode.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} rawSha - the commit to reset to.
 * @param {'soft'|'mixed'|'hard'} mode - how much of the index and tree to reset.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sha: string, current: string, mode: string }>} the moved branch.
 */
export async function resetGitCommit(git, root, rawSha, mode, signal) {
  if (!RESET_MODES.has(mode)) throw badRequest('mode must be soft, mixed, or hard.')
  const current = await requireCurrentBranch(git, root, signal)
  const sha = await requireCommit(git, root, rawSha, signal)
  const result = await git.run(['reset', `--${mode}`, sha], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw new VcsError('commit-failed', 'The branch could not be reset.', redactDetail(result.stderr))
  }
  return { sha, current, mode }
}
