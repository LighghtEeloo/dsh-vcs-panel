/**
 * Ref helpers shared by the Git write operations.
 *
 * These answer the two questions every write asks first: which branch is
 * checked out, and whether a revision resolves to a commit. The merge and
 * rebase aborts undo only the operation this panel started, so a value that
 * was already in the repository is never touched.
 */

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
export async function abortMergeIfStarted(git, root, signal) {
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
export async function abortRebaseIfStarted(git, root, signal) {
  try {
    if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
      await git.run(['rebase', '--abort'], { cwd: root, signal })
    }
  } catch {
    // The original failure is the answer; a failed cleanup cannot improve it.
  }
}

/**
 * Undo a cherry-pick this panel started, and only that one.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
export async function abortCherryPickIfStarted(git, root, signal) {
  try {
    if (await commitAt(git, root, 'CHERRY_PICK_HEAD', signal) !== null) {
      await git.run(['cherry-pick', '--abort'], { cwd: root, signal })
    }
  } catch {
    // The original failure is the answer; a failed cleanup cannot improve it.
  }
}

/**
 * Undo a revert this panel started, and only that one.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
export async function abortRevertIfStarted(git, root, signal) {
  try {
    if (await commitAt(git, root, 'REVERT_HEAD', signal) !== null) {
      await git.run(['revert', '--abort'], { cwd: root, signal })
    }
  } catch {
    // The original failure is the answer; a failed cleanup cannot improve it.
  }
}
