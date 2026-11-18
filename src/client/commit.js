/**
 * The commit actions menu: which actions apply to one commit, visual grouping,
 * destructiveness, dialog mapping, and the busy labels reported while working.
 *
 * Tagging and creating a branch only add a ref. Checkout is offered unless
 * the commit is already HEAD. Picking, reverting, dropping, merging,
 * rebasing, and resetting move or rewrite the checked-out branch, so they
 * need a named branch. Drop is omitted for multi-parent/root commits or when
 * the loaded graph shows the commit is off the current branch; cherry-pick,
 * merge, and rebase are omitted for commits already reachable from HEAD.
 */

/** Visual group, destructiveness, label key, and dialog kind per commit action. */
export const COMMIT_ACTION_META = Object.freeze({
  'add-tag': { group: 0, destructive: false, labelKey: 'commit.addTag', dialogKind: 'tag' },
  'create-branch': { group: 0, destructive: false, labelKey: 'commit.createBranch', dialogKind: 'branch' },
  checkout: { group: 1, destructive: false, labelKey: 'commit.checkout', dialogKind: 'checkout' },
  'cherry-pick': { group: 1, destructive: false, labelKey: 'commit.cherryPick', dialogKind: 'cherry-pick' },
  revert: { group: 1, destructive: false, labelKey: 'commit.revert', dialogKind: 'revert' },
  drop: { group: 1, destructive: true, labelKey: 'commit.drop', dialogKind: 'drop' },
  merge: { group: 2, destructive: false, labelKey: 'commit.merge', dialogKind: 'merge' },
  rebase: { group: 2, destructive: false, labelKey: 'commit.rebase', dialogKind: 'rebase' },
  reset: { group: 2, destructive: true, labelKey: 'commit.reset', dialogKind: 'reset' },
})

/** Busy labels for the commit actions. */
export const COMMIT_BUSY_KEYS = Object.freeze({
  tag: 'commit.tagging',
  branch: 'commit.creatingBranch',
  checkout: 'commit.checkingOut',
  'cherry-pick': 'commit.cherryPicking',
  revert: 'commit.reverting',
  drop: 'commit.dropping',
  merge: 'commit.merging',
  rebase: 'commit.rebasing',
  reset: 'commit.resetting',
})

/**
 * Actions the menu offers for one commit, in display order.
 * @param {{ commit: object, currentBranch: string | null, head: string | null, relation?: 'on-branch' | 'off-branch' | 'unknown' }} target - the commit, branch state, and reachability relation.
 * @returns {string[]} action ids.
 */
export function commitActions({ commit, currentBranch, head, relation = 'unknown' }) {
  const actions = ['add-tag', 'create-branch']
  const atHead = typeof head === 'string' && head !== '' && commit.sha === head
  if (!atHead) actions.push('checkout')
  if (currentBranch !== null) {
    if (!atHead && relation !== 'on-branch') actions.push('cherry-pick')
    actions.push('revert')
  }
  if (
    currentBranch !== null
    && relation !== 'off-branch'
    && Array.isArray(commit.parents)
    && commit.parents.length === 1
  ) {
    actions.push('drop')
  }
  if (currentBranch !== null && !atHead) {
    if (relation !== 'on-branch') actions.push('merge', 'rebase')
    actions.push('reset')
  }
  return actions
}

/**
 * Whether an action rewrites history or can discard changes.
 * @param {string} action - commit action id.
 * @returns {boolean} whether it is destructive.
 */
export function isDestructiveCommitAction(action) {
  return COMMIT_ACTION_META[action]?.destructive === true
}
