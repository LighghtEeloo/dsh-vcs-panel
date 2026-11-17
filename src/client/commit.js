/**
 * The commit actions menu: which actions apply to one commit, and the busy
 * labels they report while the Host works.
 *
 * Tagging and creating a branch only add a ref. Checkout is offered unless
 * the commit is already HEAD. Picking, reverting, dropping, merging,
 * rebasing, and resetting move or rewrite the checked-out branch, so they
 * need a named branch. Drop is only offered for a single-parent commit;
 * merge, rebase, and reset are hidden for HEAD itself.
 */

/** Busy labels for the commit actions. */
export const COMMIT_BUSY_KEYS = {
  tag: 'commit.tagging',
  branch: 'commit.creatingBranch',
  checkout: 'commit.checkingOut',
  'cherry-pick': 'commit.cherryPicking',
  revert: 'commit.reverting',
  drop: 'commit.dropping',
  merge: 'commit.merging',
  rebase: 'commit.rebasing',
  reset: 'commit.resetting',
}

/**
 * Actions the menu offers for one commit, in display order.
 * @param {{ commit: object, currentBranch: string | null, head: string | null }} target - the commit and branch state.
 * @returns {string[]} action ids.
 */
export function commitActions({ commit, currentBranch, head }) {
  const actions = ['add-tag', 'create-branch']
  const atHead = typeof head === 'string' && head !== '' && commit.sha === head
  if (!atHead) actions.push('checkout')
  if (currentBranch !== null) {
    if (!atHead) actions.push('cherry-pick')
    actions.push('revert')
  }
  if (currentBranch !== null && Array.isArray(commit.parents) && commit.parents.length === 1) {
    actions.push('drop')
  }
  if (currentBranch !== null && !atHead) {
    actions.push('merge', 'rebase', 'reset')
  }
  return actions
}

/**
 * Whether an action rewrites history or can discard changes.
 * @param {string} action - commit action id.
 * @returns {boolean} whether it is destructive.
 */
export function isDestructiveCommitAction(action) {
  return action === 'drop' || action === 'reset'
}
