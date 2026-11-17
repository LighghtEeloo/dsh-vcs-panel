/**
 * The branch actions menu: which actions apply to which branch, and which
 * localized labels describe them while they run.
 *
 * A branch that is not checked out can be checked out, renamed, deleted,
 * merged into the current branch, used as the new base of the current branch,
 * or pushed. Merge and rebase only appear while a named branch is checked out;
 * a detached HEAD has no "current branch" to move. The checked-out branch
 * itself is renamed or pushed: checking it out would be a no-op, deleting it
 * is refused by Git, and merging it into itself or rebasing it onto itself
 * changes nothing.
 */

/** Busy labels for the actions that report through the branch icon. */
export const BRANCH_BUSY_KEYS = {
  rename: 'branch.renaming',
  delete: 'branch.deleting',
  merge: 'branch.merging',
  rebase: 'branch.rebasing',
  push: 'branch.pushing',
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
 * Whether an action deletes something and is styled as destructive.
 * @param {string} action - action id.
 * @returns {boolean} whether it is destructive.
 */
export function isDestructiveAction(action) {
  return action === 'delete'
}
