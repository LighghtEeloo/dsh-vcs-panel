/**
 * The branch actions menu: which actions apply to which branch or remote
 * branch, and which localized labels describe them while they run.
 *
 * A local branch that is not checked out can be checked out, renamed, deleted,
 * merged into the current branch, used as the new base of the current branch,
 * or pushed. A remote branch can be checked out as a tracking local branch,
 * deleted on its remote, merged into the current branch, or pulled into it.
 * Merge, rebase, and pull only appear while a named branch is checked out; a
 * detached HEAD has no "current branch" to move. The checked-out branch itself
 * is renamed or pushed: checking it out would be a no-op, deleting it is
 * refused by Git, and merging it into itself or rebasing it onto itself changes
 * nothing.
 */

/** Busy labels for the actions that report through the branch icon. */
export const BRANCH_BUSY_KEYS = {
  rename: 'branch.renaming',
  delete: 'branch.deleting',
  merge: 'branch.merging',
  rebase: 'branch.rebasing',
  push: 'branch.pushing',
  'checkout-remote': 'top.switching',
  'delete-remote': 'branch.deleting',
  'merge-remote': 'branch.merging',
  'pull-remote': 'branch.pulling',
}

/**
 * Actions the menu offers for one branch, in display order.
 * @param {{ current: boolean, currentBranch: string | null }} target - the branch and the checked-out branch.
 * @returns {string[]} action ids.
 */
export function branchActions({ current, currentBranch }) {
  if (current) return ['rename', 'push']
  const actions = ['checkout', 'rename', 'delete']
  if (currentBranch !== null) actions.push('merge', 'rebase')
  actions.push('push')
  return actions
}

/**
 * Actions the remote-branch menu offers, in display order.
 *
 * Checkout and deleting the remote branch always apply. Merge and pull move
 * the checked-out branch, so they only appear while a named branch is checked
 * out; a detached HEAD has no "current branch" to receive them.
 *
 * @param {{ currentBranch: string | null }} target - the checked-out branch.
 * @returns {string[]} action ids.
 */
export function remoteBranchActions({ currentBranch }) {
  const actions = ['checkout-remote', 'delete-remote']
  if (currentBranch !== null) actions.push('merge-remote', 'pull-remote')
  return actions
}

/**
 * Whether an action removes a ref and is styled as destructive.
 * @param {string} action - branch, remote-branch, or tag action id.
 * @returns {boolean} whether it is destructive.
 */
export function isDestructiveAction(action) {
  return action === 'delete' || action === 'delete-remote'
}
