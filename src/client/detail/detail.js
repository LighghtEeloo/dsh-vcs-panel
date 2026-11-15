/**
 * Pure rules for the detail pane shared by the working tree and commits.
 *
 * A selected node is normalized into file groups: a backend with a separate
 * working tree supplies staged and unstaged groups, with untracked files
 * merged into unstaged; a commit (or a working-copy commit) has one group. The
 * change tree renders the groups' rows and reads one comparison per file row,
 * so a file's row and its diff are one thing.
 */

import { buildNodeRows, summarizeEntries } from './tree.js'

/** Sections with more changed lines than this start folded. */
export const FOLD_LINES = 1000

/** Changed lines the tree renders unfolded before folding the rest. */
export const STREAM_BUDGET = 20_000

/** Diff requests in flight at once. */
export const MAX_PARALLEL = 4

/** Below this tree width the side-by-side layout renders as one column. */
export const SPLIT_MIN_WIDTH = 640

/** Rendered height of one diff line, in CSS pixels (FileDiff's row height). */
const LINE_HEIGHT = 22

/** Lines `FileDiff` renders at most per comparison. */
const MAX_LINES = 5000

/** Working-tree groups of a backend that stages, in display order. */
const WORKTREE_GROUPS = ['staged', 'unstaged']

/**
 * File groups of the working tree.
 *
 * Untracked files and directories join the unstaged group: the group answers
 * whether the change enters the next commit, and the answer is the same. The
 * `?` on their rows marks them as untracked, not their group.
 *
 * @param {{ groups?: Record<string, object[]> } | null} status - the working-tree answer.
 * @returns {Array<{ id: string, entries: object[], header: boolean }>} the non-empty groups.
 */
export function worktreeGroups(status) {
  const untracked = status?.groups?.untracked ?? []
  return [
    { id: 'staged', entries: status?.groups?.staged ?? [], header: true },
    { id: 'unstaged', entries: [...(status?.groups?.unstaged ?? []), ...untracked], header: true },
  ].filter(group => group.entries.length > 0)
}

/**
 * File groups of one commit.
 * @param {{ files?: object[] } | null} commit - the commit detail.
 * @returns {Array<{ id: string, entries: object[], header: boolean }>} one group, or none.
 */
export function commitGroups(commit) {
  const files = commit?.files ?? []
  return files.length === 0 ? [] : [{ id: 'commit', entries: files, header: false }]
}

/**
 * The comparison one file asks `vcs.diff` for. The scope comes from the file,
 * not from its group: an untracked file compares its whole content against the
 * index even though its row sits in the unstaged group.
 * @param {string} group - the file's group.
 * @param {{ path: string, status?: string, origPath?: string }} entry - the file.
 * @param {string | null} rev - the commit, for the commit group.
 * @returns {{ scope: string, path: string, oldPath?: string, rev?: string }} the target.
 */
export function diffTarget(group, entry, rev) {
  const scope = group === 'commit' ? 'commit' : (entry.status === '?' ? 'untracked' : group)
  const target = { scope, path: entry.path }
  if (entry.origPath !== undefined) target.oldPath = entry.origPath
  if (scope === 'commit') target.rev = rev
  return target
}

/**
 * The file sections one row list renders, in row order.
 * @param {object[]} rows - the visible rows.
 * @param {string | null} rev - the commit for the commit group.
 * @returns {Array<{ key: string, group: string, entry: object, target: object }>} the sections.
 */
export function sectionsFromRows(rows, rev) {
  const sections = []
  for (const row of rows) {
    if (row.kind !== 'file') continue
    sections.push({
      key: row.key,
      group: row.group,
      entry: row.entry,
      target: diffTarget(row.group, row.entry, rev),
    })
  }
  return sections
}

/**
 * The diff sections of a node as if every directory were expanded, in the
 * order they would render.
 *
 * The default folding budget is computed from this order, so collapsing or
 * expanding a directory does not change which other files start folded.
 * Untracked directories contribute only the children already loaded.
 *
 * @param {Array<{ id: string, entries: object[], header?: boolean }>} groups - the node's groups.
 * @param {Record<string, object[]>} dirChildren - loaded untracked children by directory key.
 * @param {string | null} rev - the commit for the commit group.
 * @returns {Array<{ key: string, group: string, entry: object, target: object }>} the sections.
 */
export function streamSections(groups, dirChildren, rev) {
  const dirs = {}
  for (const key of Object.keys(dirChildren ?? {})) dirs[key] = true
  return sectionsFromRows(buildNodeRows(groups, { dirChildren, dirs, collapsed: {} }), rev)
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
 * Which file rows start folded, and why.
 *
 * A file over {@link FOLD_LINES} changed lines folds on its own. The others
 * unfold in order until their changed lines pass {@link STREAM_BUDGET}; the
 * rest fold so one large node cannot render an unbounded page. Changed lines
 * stand in for rendered lines, which also include a few lines of context.
 *
 * @param {Array<{ key: string, entry: object }>} sections - sections in full expansion order.
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
 * Whether one file is folded: the user's choice, else the default.
 * @param {string} key - the file row key.
 * @param {Map<string, string>} defaults - from {@link defaultFolds}.
 * @param {Record<string, boolean>} folds - the user's fold choices.
 * @returns {boolean} true when folded.
 */
export function isFolded(key, defaults, folds) {
  const chosen = folds?.[key]
  return typeof chosen === 'boolean' ? chosen : defaults.has(key)
}

/**
 * Whether any file of the node is currently unfolded, which decides whether
 * the toolbar button collapses or expands.
 * @param {Array<{ key: string }>} sections - every file section of the node.
 * @param {Map<string, string>} defaults - from {@link defaultFolds}.
 * @param {Record<string, boolean>} folds - the user's fold choices.
 * @returns {boolean} true when at least one file is unfolded.
 */
export function hasUnfoldedFile(sections, defaults, folds) {
  return sections.some(section => !isFolded(section.key, defaults, folds))
}

/**
 * The fold choices that collapse every file of the node.
 * @param {Array<{ key: string }>} sections - every file section of the node.
 * @returns {Record<string, boolean>} one fold choice per file.
 */
export function allFileFolds(sections) {
  const folds = {}
  for (const section of sections) folds[section.key] = true
  return folds
}

/**
 * The comparison a commit row states in its toolbar.
 * @param {{ parents?: string[] } | null} commit - the commit node or detail.
 * @param {{ changeId?: boolean } | null} capabilities - the backend's capability object.
 * @returns {{ kind: 'parent' | 'merge' | 'root' | 'autoMerge', parent?: string }} the comparison.
 */
export function comparisonBase(commit, capabilities) {
  const parents = commit?.parents ?? []
  if (parents.length === 0) return { kind: 'root' }
  // Jujutsu compares a merge against its parents' automatic merge, not
  // against the first parent alone; a backend with change ids works that way.
  if (capabilities?.changeId === true) return { kind: 'autoMerge', parent: parents[0] }
  if (parents.length > 1) return { kind: 'merge', parent: parents[0] }
  return { kind: 'parent', parent: parents[0] }
}

/**
 * Placeholder height for a file whose comparison has not loaded, so the
 * tree's scroll height is close to its final height from the start.
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
 * The row a scroll offset is reading: the last one whose top is at or above
 * the offset.
 * @param {number[]} tops - row top offsets in row order (ascending).
 * @param {number} offset - the scroll offset.
 * @returns {number} the row index, or -1 without rows.
 */
export function rowAt(tops, offset) {
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

/**
 * The next or previous file row that is not folded, starting after `from`.
 * Hunk jumps cross file boundaries this way and skip files whose comparison is
 * collapsed, so they never land on content the reader cannot see.
 * @param {object[]} rows - the visible rows.
 * @param {number} from - the index to start from (exclusive).
 * @param {number} step - 1 for forward, -1 for backward.
 * @param {(row: object) => boolean} folded - whether one file row is folded.
 * @returns {number} the row index, or -1 when no such row exists.
 */
export function nextFileRow(rows, from, step, folded) {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) {
    const row = rows[index]
    if (row.kind !== 'file') continue
    if (folded(row)) continue
    return index
  }
  return -1
}

/**
 * What one commit's toolbar says about the work behind it.
 * @param {object[] | null | undefined} files - the commit's changed files.
 * @returns {{ count: number, added: number, deleted: number }} the summary.
 */
export function commitSummary(files) {
  return summarizeEntries(files ?? [])
}
