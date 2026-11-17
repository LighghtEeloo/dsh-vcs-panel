/**
 * What the client may assume about one version control model.
 *
 * Capabilities are data, not a backend id: the panel reads `workingCopy`,
 * `staging`, `changeId`, `snapshots`, `sync`, `branchSwitch`, `branchOps`,
 * `tagOps`, and `ranges` to choose between the working-tree row and a
 * working-copy commit, between staged/unstaged groups and one changes group,
 * whether to offer branch sync, branch actions, and tag actions, and between
 * history ranges. A future backend only has to state the same answers; the
 * client needs no new branch on its name.
 */

/** Git: a working tree beside HEAD, an index, and refs. */
export const GIT_CAPABILITIES = Object.freeze({
  id: 'git',
  name: 'Git',
  /** The working tree is a virtual row above the commits. */
  workingCopy: 'row',
  /** No commit stands for the working copy. */
  workingCopyNode: null,
  /** The status has staged, unstaged, and untracked groups. */
  staging: true,
  /** Untracked directories can be expanded on demand. */
  untracked: true,
  /** Commits have a stable change id beside their commit id. */
  changeId: false,
  /** The branch reports ahead/behind counts. */
  aheadBehind: true,
  /** Reading may write backend bookkeeping; git reads do not. */
  snapshots: false,
  /** The branch can sync with its upstream: fetch, then fast-forward or push. */
  sync: true,
  /** Local branches can be listed and checked out from the header. */
  branchSwitch: true,
  /** The header's branch menu can rename, delete, merge, rebase, and push. */
  branchOps: true,
  /** Tag badges can delete a local tag and push it to a remote. */
  tagOps: true,
  ranges: Object.freeze([
    { value: 'HEAD', label: 'history.head', title: 'history.headTitle' },
    { value: 'all', label: 'history.all', title: 'history.allTitle' },
  ]),
  defaultRange: 'HEAD',
})

/** Jujutsu: the working copy is a commit, and history is a revset. */
export const JUJUTSU_CAPABILITIES = Object.freeze({
  id: 'jujutsu',
  name: 'Jujutsu',
  /** The working-copy commit (`@`) is an ordinary timeline row. */
  workingCopy: 'commit',
  /** The stable node token for the working-copy commit. */
  workingCopyNode: '@',
  /** Every working-copy change belongs to one changes group, not an index. */
  staging: false,
  untracked: false,
  changeId: true,
  aheadBehind: false,
  /** Jujutsu snapshots the working copy as part of reading its state. */
  snapshots: true,
  /** Bookmark sync is not offered; `jj git push` stays in the terminal. */
  sync: false,
  /** A bookmark is not a branch: switching would move the working-copy commit. */
  branchSwitch: false,
  /** Bookmark operations have no branch ref to act on. */
  branchOps: false,
  /** Tags are read-only here; `jj git tag` is left to the terminal. */
  tagOps: false,
  ranges: Object.freeze([
    { value: '@', label: 'history.workingCopy', title: 'history.workingCopyTitle' },
    { value: 'all', label: 'history.all', title: 'history.allTitle' },
  ]),
  defaultRange: '@',
})
