/**
 * Pure rules for the timeline: the working tree as row 0, commits below it.
 *
 * The timeline is one list whose first row is the working tree and whose other
 * rows are the loaded commits in `--topo-order`. These helpers translate
 * between row indexes and timeline nodes and build the lane-graph input.
 */

import { WORKING_COPY, WORKTREE } from '../state.js'

/**
 * The lane-graph input.
 *
 * A backend with a separate working tree contributes a virtual first node
 * whose parent is HEAD; a backend whose working copy is a commit contributes
 * the commits as they came.
 * @param {object[]} commits - loaded commits in list order.
 * @param {string | null} head - the commit HEAD points to, or null without one.
 * @param {{ worktreeRow?: boolean }} [options] - layout choice.
 * @returns {object[]} nodes for `buildGraph`.
 */
export function graphInput(commits, head, { worktreeRow = true } = {}) {
  if (!worktreeRow) return [...commits]
  const worktree = { sha: WORKTREE, parents: head === null ? [] : [head], refs: [], worktree: true }
  return [worktree, ...commits]
}

/**
 * The commit HEAD points to, as far as the panel knows.
 * The status answer names it exactly; before that answers, a HEAD range
 * starts at HEAD by construction.
 * @param {{ branch?: { oid?: string | null } } | null} status - the working-tree answer.
 * @param {object[]} commits - loaded commits.
 * @param {string} range - 'HEAD' or 'all'.
 * @returns {string | null} the commit id, or null.
 */
export function headOf(status, commits, range) {
  const oid = status?.branch?.oid
  if (typeof oid === 'string' && oid !== '') return oid
  if (status?.branch?.unborn === true) return null
  return range === 'HEAD' ? commits[0]?.sha ?? null : null
}

/**
 * The node shown on one timeline row.
 * @param {object[]} commits - loaded commits.
 * @param {number} index - row index.
 * @param {{ worktreeRow?: boolean }} [options] - layout choice.
 * @returns {string | null} the node, or null past the end.
 */
export function nodeAt(commits, index, { worktreeRow = true, workingCopyNode = WORKING_COPY } = {}) {
  const commit = worktreeRow ? commits[index - 1] : commits[index]
  if (worktreeRow && index === 0) return WORKTREE
  if (commit === undefined || commit === null) return null
  return commit.workingCopy === true ? workingCopyNode : commit.sha
}

/**
 * The timeline row showing one node.
 * @param {Map<string, number>} commitIndex - commit id to commit index.
 * @param {string | null} node - the node.
 * @param {{ worktreeRow?: boolean }} [options] - layout choice.
 * @returns {number} the row index, or -1 when the node is not loaded.
 */
export function rowOf(commitIndex, node, { worktreeRow = true } = {}) {
  if (worktreeRow && node === WORKTREE) return 0
  if (node === null) return -1
  const index = commitIndex.get(node)
  if (index === undefined) return -1
  return worktreeRow ? index + 1 : index
}

/**
 * Choose the repository a Session opens by default: the persisted choice when
 * still listed, else the enclosing repository, else the first listed.
 * @param {Array<{ path: string, enclosing?: boolean, capabilities?: object }>} repositories - discovered list.
 * @param {string | null} [preferredPath] - previously chosen repository path.
 * @returns {{ path: string, enclosing?: boolean, capabilities?: object } | null} the chosen entry, or null.
 */
export function pickRepository(repositories, preferredPath = null) {
  if (!Array.isArray(repositories) || repositories.length === 0) return null
  return (preferredPath === null ? undefined : repositories.find(entry => entry.path === preferredPath))
    ?? repositories.find(entry => entry.enclosing === true)
    ?? repositories[0]
    ?? null
}

/**
 * What the working-tree row and header say about the uncommitted changes.
 * Untracked files have no line counts until their comparison loads.
 * @param {{ total?: number, groups?: Record<string, object[]> } | null} status - the working-tree answer.
 * @returns {{ changed: number, added: number, deleted: number }} the summary.
 */
export function worktreeSummary(status) {
  let added = 0
  let deleted = 0
  for (const group of ['staged', 'unstaged']) {
    for (const entry of status?.groups?.[group] ?? []) {
      if (typeof entry.added === 'number') added += entry.added
      if (typeof entry.deleted === 'number') deleted += entry.deleted
    }
  }
  return { changed: status?.total ?? 0, added, deleted }
}

/**
 * Normalize the active head identity from a `vcs.status` answer.
 * @param {object | null | undefined} status - `vcs.status` answer.
 * @returns {{ kind: 'workingCopy', changeId: string | null } | { kind: 'branch', name: string } | { kind: 'detached' } | { kind: 'unborn' } | null}
 */
export function workingHead(status) {
  if (status === null || status === undefined || typeof status !== 'object') return null
  if (status.capabilities?.workingCopy === 'commit' || (status.workingCopy !== null && typeof status.workingCopy === 'object')) {
    const raw = status.workingCopy?.changeId
    return {
      kind: 'workingCopy',
      changeId: typeof raw === 'string' && raw !== '' ? raw : null,
    }
  }
  const branch = status.branch
  if (branch === null || branch === undefined || typeof branch !== 'object') return null
  if (branch.unborn === true) return { kind: 'unborn' }
  if (branch.detached === true || typeof branch.name !== 'string' || branch.name === '') {
    return { kind: 'detached' }
  }
  return { kind: 'branch', name: branch.name }
}

/**
 * Head identity, changed-file count, and line totals for the repository's
 * current working state: the working-copy commit (`@`) when the backend models
 * it as a commit, or the staged and unstaged working-tree groups otherwise.
 * @param {object | null | undefined} status - `vcs.status` answer.
 * @returns {{ head: ReturnType<typeof workingHead>, changed: number, added: number, deleted: number } | null} totals, or null before status resolves.
 */
export function workingSummary(status) {
  if (status === null || status === undefined || typeof status !== 'object') return null
  const head = workingHead(status)
  const copy = status.workingCopy?.summary
  if (status.capabilities?.workingCopy === 'commit' || (copy !== null && typeof copy === 'object')) {
    if (copy === null || typeof copy !== 'object') return null
    return {
      head,
      changed: typeof copy.changed === 'number' ? copy.changed : 0,
      added: typeof copy.added === 'number' ? copy.added : 0,
      deleted: typeof copy.deleted === 'number' ? copy.deleted : 0,
    }
  }
  return { head, ...worktreeSummary(status) }
}
