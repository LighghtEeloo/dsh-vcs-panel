/**
 * Pure rules for the timeline: the working tree as row 0, commits below it.
 *
 * The timeline is one list whose first row is the working tree and whose other
 * rows are the loaded commits in `--topo-order`. These helpers translate
 * between row indexes and timeline nodes and build the lane-graph input.
 */

import { WORKTREE } from '../state.js'

/**
 * The lane-graph input: the working-tree node, then the commits.
 * @param {object[]} commits - loaded commits in list order.
 * @param {string | null} head - the commit HEAD points to, or null without one.
 * @returns {object[]} nodes for `buildGraph`.
 */
export function graphInput(commits, head) {
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
 * @returns {string | null} the node, or null past the end.
 */
export function nodeAt(commits, index) {
  if (index === 0) return WORKTREE
  return commits[index - 1]?.sha ?? null
}

/**
 * The timeline row showing one node.
 * @param {Map<string, number>} commitIndex - commit id to commit index.
 * @param {string | null} node - the node.
 * @returns {number} the row index, or -1 when the node is not loaded.
 */
export function rowOf(commitIndex, node) {
  if (node === WORKTREE) return 0
  if (node === null) return -1
  const index = commitIndex.get(node)
  return index === undefined ? -1 : index + 1
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
