/**
 * Pure helpers over loaded commit rows and one commit's detail.
 *
 * The History list and the commit pane both read these answers; keeping them
 * here lets the components stay layout code and the rules stay testable.
 */

import { WORKING_COPY } from '../state.js'

/**
 * The part of a commit message below its subject.
 *
 * Git's `%s` is the first paragraph with its lines joined, so the body starts
 * after the first blank line; a message without one has no body. Blank lines
 * that open the body and trailing whitespace are dropped, indentation inside
 * the body is kept.
 *
 * @param {unknown} message - the full message (`%B`).
 * @returns {string} the body, or '' when the message is only a subject.
 */
export function messageBody(message) {
  if (typeof message !== 'string') return ''
  const separator = /\r?\n[ \t]*\r?\n/u.exec(message)
  if (separator === null) return ''
  return message
    .slice(separator.index + separator[0].length)
    .replace(/^(?:[ \t]*\r?\n)+/u, '')
    .trimEnd()
}

/**
 * Whether the loaded commits name more than one author; with a single author
 * the per-row author column repeats one name and is left out.
 * @param {Array<{ author: string }>} commits - loaded commit rows.
 * @returns {boolean} true when at least two authors appear.
 */
export function hasSeveralAuthors(commits) {
  const first = commits[0]?.author
  return commits.some(commit => commit.author !== first)
}

/**
 * Index loaded commits by full id.
 *
 * A backend whose working copy is a commit also maps the stable `@` token to
 * that row, so selecting the working copy does not store an id that changes
 * every time the working copy is rewritten.
 * @param {Array<{ sha: string, workingCopy?: boolean }>} commits - loaded commit rows in list order.
 * @returns {Map<string, number>} commit id or working-copy token to row index.
 */
export function indexCommits(commits, workingCopyNode = WORKING_COPY) {
  const index = new Map(commits.map((commit, position) => [commit.sha, position]))
  commits.forEach((commit, position) => {
    if (commit.workingCopy === true && workingCopyNode !== null && workingCopyNode !== undefined) {
      index.set(workingCopyNode, position)
    }
  })
  return index
}

/**
 * Walk parent links from `head` across loaded commits.
 * `complete` is true when `head` is loaded and every encountered parent is also
 * present in `commits`, meaning no unloaded history can hide an ancestor link.
 * @param {Array<{ sha: string, parents?: string[] }>} commits - loaded commit rows.
 * @param {string | null} head - the commit id HEAD points to.
 * @returns {{ reachable: Set<string>, complete: boolean }} reachable commit ids and completeness.
 */
export function reachableCommits(commits, head) {
  const reachable = new Set()
  if (typeof head !== 'string' || head === '' || !Array.isArray(commits) || commits.length === 0) {
    return { reachable, complete: false }
  }
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  if (!bySha.has(head)) return { reachable, complete: false }

  const stack = [head]
  let complete = true
  while (stack.length > 0) {
    const sha = stack.pop()
    if (reachable.has(sha)) continue
    const commit = bySha.get(sha)
    if (commit === undefined) {
      complete = false
      continue
    }
    reachable.add(sha)
    for (const parent of commit.parents ?? []) {
      if (!reachable.has(parent)) stack.push(parent)
    }
  }
  return { reachable, complete }
}

/**
 * Classify whether one commit is an ancestor of `head`, strictly off the current
 * branch, or uncertain due to an incomplete history frontier.
 * @param {Array<{ sha: string, parents?: string[] }>} commits - loaded commits in topo order.
 * @param {Map<string, number>} commitIndex - sha-to-index map.
 * @param {string | null} head - the HEAD commit id.
 * @param {string} sha - candidate commit id.
 * @param {{ reachable: Set<string>, complete: boolean }} [reachability] - precomputed reachability from `head`.
 * @returns {'on-branch' | 'off-branch' | 'unknown'} the commit's relation to `HEAD`.
 */
export function commitBranchRelation(
  commits,
  commitIndex,
  head,
  sha,
  reachability = reachableCommits(commits, head),
) {
  if (typeof sha !== 'string' || sha === '') return 'unknown'
  if (typeof head !== 'string' || head === '' || !commitIndex.has(head)) return 'unknown'
  if (reachability.reachable.has(sha)) return 'on-branch'
  const shaIndex = commitIndex.get(sha)
  if (reachability.complete || (shaIndex !== undefined && shaIndex < commitIndex.get(head))) {
    return 'off-branch'
  }
  return 'unknown'
}
