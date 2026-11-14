/**
 * Pure rules for the detail pane shared by the working tree and commits.
 *
 * A selected node is normalized into file groups: the working tree has the
 * staged, unstaged, and untracked groups; a commit has one group of changed
 * files. The file navigation draws those groups as trees, and the diff stream
 * walks the same trees fully expanded, so both list files in the same order.
 */

import { buildRows } from './tree.js'

/** Sections with more changed lines than this start folded. */
export const FOLD_LINES = 1000

/** Changed lines the stream renders unfolded before folding the rest. */
export const STREAM_BUDGET = 20_000

/** Diff requests in flight at once. */
export const MAX_PARALLEL = 4

/** Rendered height of one diff line, in CSS pixels (FileDiff's row height). */
const LINE_HEIGHT = 22

/** Lines `FileDiff` renders at most per comparison. */
const MAX_LINES = 5000

/** Status groups of the working tree, in display order. */
const WORKTREE_GROUPS = ['staged', 'unstaged', 'untracked']

/**
 * File groups of the working tree.
 * @param {{ groups?: Record<string, object[]> } | null} status - the working-tree answer.
 * @returns {Array<{ id: string, entries: object[] }>} the non-empty groups.
 */
export function worktreeGroups(status) {
  return WORKTREE_GROUPS
    .map(id => ({ id, entries: status?.groups?.[id] ?? [] }))
    .filter(group => group.entries.length > 0)
}

/**
 * File groups of one commit.
 * @param {{ files?: object[] } | null} commit - the commit detail.
 * @returns {Array<{ id: string, entries: object[] }>} one group, or none.
 */
export function commitGroups(commit) {
  const files = commit?.files ?? []
  return files.length === 0 ? [] : [{ id: 'commit', entries: files }]
}

/** The key one diff section is stored and addressed under. */
export function sectionKey(group, path) {
  return `${group}|${path}`
}

/**
 * The comparison one file asks `vcs.diff` for.
 * @param {string} group - the file's group.
 * @param {{ path: string, origPath?: string }} entry - the file.
 * @param {string | null} rev - the commit, for the commit group.
 * @returns {{ scope: string, path: string, oldPath?: string, rev?: string }} the target.
 */
export function diffTarget(group, entry, rev) {
  const target = { scope: group, path: entry.path }
  if (entry.origPath !== undefined) target.oldPath = entry.origPath
  if (group === 'commit') target.rev = rev
  return target
}

/**
 * The diff sections of a node, in navigation order.
 *
 * Every directory counts as expanded here: folding a folder in the navigation
 * hides its rows there, not its comparisons. Untracked folders contribute
 * only the children already loaded.
 *
 * @param {Array<{ id: string, entries: object[] }>} groups - the node's file groups.
 * @param {Record<string, object[]>} dirChildren - loaded untracked children by directory key.
 * @param {string | null} rev - the commit for the commit group.
 * @returns {Array<{ key: string, group: string, entry: object, target: object }>} the sections.
 */
export function streamSections(groups, dirChildren, rev) {
  const dirs = {}
  for (const key of Object.keys(dirChildren ?? {})) dirs[key] = true
  const sections = []
  for (const group of groups) {
    const rows = buildRows(group.id, group.entries, { dirChildren, dirs, collapsed: {} })
    for (const row of rows) {
      if (row.kind !== 'file') continue
      sections.push({
        key: sectionKey(group.id, row.path),
        group: group.id,
        entry: row.entry,
        target: diffTarget(group.id, row.entry, rev),
      })
    }
  }
  return sections
}

/**
 * Changed lines one file states, or 0 when unknown (untracked files, binaries).
 * @param {{ added?: number, deleted?: number, binary?: boolean }} entry - the file.
 * @returns {number} added plus deleted lines.
 */
export function changedLines(entry) {
  if (entry?.binary === true) return 0
  const added = typeof entry?.added === 'number' ? entry.added : 0
  const deleted = typeof entry?.deleted === 'number' ? entry.deleted : 0
  return added + deleted
}

/**
 * Which sections start folded, and why.
 *
 * A section over {@link FOLD_LINES} changed lines folds on its own. The others
 * unfold in order until their changed lines pass {@link STREAM_BUDGET}; the
 * rest fold so one large node cannot render an unbounded page. Changed lines
 * stand in for rendered lines, which also include a few lines of context.
 *
 * @param {Array<{ key: string, entry: object }>} sections - sections in stream order.
 * @returns {Map<string, 'large' | 'budget'>} folded section keys with their reason.
 */
export function defaultFolds(sections) {
  const folds = new Map()
  let rendered = 0
  for (const section of sections) {
    const lines = changedLines(section.entry)
    if (lines > FOLD_LINES) {
      folds.set(section.key, 'large')
      continue
    }
    if (rendered >= STREAM_BUDGET) {
      folds.set(section.key, 'budget')
      continue
    }
    rendered += lines
  }
  return folds
}

/**
 * Whether one section is folded: the user's choice, else the default.
 * @param {string} key - the section key.
 * @param {Map<string, string>} defaults - from {@link defaultFolds}.
 * @param {Record<string, boolean>} folds - the user's fold choices.
 * @returns {boolean} true when folded.
 */
export function isFolded(key, defaults, folds) {
  const chosen = folds?.[key]
  return typeof chosen === 'boolean' ? chosen : defaults.has(key)
}

/**
 * Placeholder height for a section whose comparison has not loaded, so the
 * stream's scroll height is close to its final height from the start.
 * @param {object} entry - the file.
 * @returns {number} the estimated body height in CSS pixels.
 */
export function estimateHeight(entry) {
  if (entry?.binary === true) return 56
  const lines = changedLines(entry)
  if (lines === 0) return 120
  // Changed lines plus roughly one hunk header and six context lines per 20 lines.
  const rows = Math.min(MAX_LINES, lines + Math.ceil(lines / 20) * 7)
  return rows * LINE_HEIGHT + 24
}

/**
 * The section a scroll offset is reading: the last one whose top is at or
 * above the offset.
 * @param {number[]} tops - section top offsets in stream order (ascending).
 * @param {number} offset - the stream's scroll offset.
 * @returns {number} the section index, or -1 without sections.
 */
export function sectionAt(tops, offset) {
  if (tops.length === 0) return -1
  let low = 0
  let high = tops.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (tops[middle] <= offset) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}
