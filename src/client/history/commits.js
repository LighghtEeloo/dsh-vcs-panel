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
