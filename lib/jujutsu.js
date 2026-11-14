/**
 * Jujutsu command output: one template language, one JSON record per line.
 *
 * Jujutsu has no porcelain mode designed for machine consumption, but its
 * template language serializes values as JSON. Each command therefore emits
 * one self-contained JSON object per line, and this module is the only place
 * that knows the field names.
 */

import { CommandRunner } from './command.js'
import { isFullSha } from './paths.js'

/** Root commit id: every Jujutsu repository has the same empty root. */
const ZERO_SHA = '0'.repeat(40)

/** A Jujutsu template fragment that emits one JSON object followed by a newline. */
const NEWLINE = '\\n'

/**
 * Ref fields shared by every commit record.
 *
 * Local bookmarks, tracked/untracked remote bookmarks, and tags stay separate
 * here because they mean different things to the reader; the client decides
 * how many badges a row can hold.
 */
const REF_FIELDS = [
  '"localBookmarks" => local_bookmarks.map(|b| json({"name" => b.name(), "conflict" => b.conflict()}))',
  '"remoteBookmarks" => remote_bookmarks.map(|b| json({"name" => b.name(), "remote" => b.remote(), "tracked" => b.tracked()}))',
  '"tags" => tags.map(|b| json({"name" => b.name(), "remote" => b.remote()}))',
].join(', ')

/** Fields every timeline row needs. */
const COMMIT_FIELDS = [
  '"sha" => commit_id',
  '"changeId" => change_id.short()',
  '"parents" => parents.map(|p| p.commit_id())',
  '"author" => author.name()',
  '"authorTime" => author.timestamp().format("%s")',
  '"subject" => description.first_line()',
  '"workingCopy" => current_working_copy',
  '"empty" => empty',
  '"conflict" => conflict',
].join(', ')

/** Fields only the selected node's detail needs. */
const DETAIL_FIELDS = [
  '"description" => description',
  '"committer" => committer.name()',
  '"committerTime" => committer.timestamp().format("%s")',
].join(', ')

/** Per-file line counts and the node totals. */
const STAT_FIELDS = [
  '"changed" => diff.stat().files().len()',
  '"added" => diff.stat().total_added()',
  '"deleted" => diff.stat().total_removed()',
  '"stats" => diff.stat().files().map(|f| json({"path" => f.path(), "added" => f.lines_added(), "removed" => f.lines_removed(), "status" => f.status_char()}))',
].join(', ')

/** One commit row per line; no patch, no per-file stats. */
export const JJ_LOG_TEMPLATE = `json({${COMMIT_FIELDS}, ${REF_FIELDS}}) ++ "${NEWLINE}"`

/** One commit with its description and per-file stats; used by status and detail. */
export const JJ_DETAIL_TEMPLATE = `json({${COMMIT_FIELDS}, ${DETAIL_FIELDS}, ${STAT_FIELDS}, ${REF_FIELDS}}) ++ "${NEWLINE}"`

/** One changed file per line, with its source path for renames and copies. */
export const JJ_DIFF_ENTRY_TEMPLATE = [
  'json({',
  '"path" => self.target().path(),',
  '"source" => self.source().path(),',
  '"status" => self.status_char(),',
  '"fileType" => self.target().file_type(),',
  '"conflict" => self.target().conflict()',
  `}) ++ "${NEWLINE}"`,
].join(' ')

/** Resolve the working-copy commit id; running this also snapshots the working copy. */
export const JJ_SNAPSHOT_TEMPLATE = 'commit_id'

/**
 * The runner for `jj`.
 *
 * `--color=never` and `--no-pager` are fixed argv; reads add
 * `--ignore-working-copy` themselves so only the explicit snapshot command
 * writes the working-copy commit.
 */
export class JujutsuRunner extends CommandRunner {
  /**
   * @param {object} ctx - Host context carrying the subprocess capability.
   */
  constructor(ctx) {
    super(ctx, {
      command: 'jj',
      args: ['--color=never', '--no-pager'],
      env: {
        // No terminal prompt or pager can be triggered from a query string.
        JJ_EDITOR: 'true',
      },
    })
  }
}

/**
 * Parse a timestamp Jujutsu formatted as epoch seconds.
 * @param {unknown} value - the formatted value.
 * @returns {number} epoch milliseconds, or NaN.
 */
function seconds(value) {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return Number.NaN
  return Number(value) * 1000
}

/**
 * Parse the JSON strings Jujutsu's template language produces for a list.
 * @param {unknown} values - the list of JSON strings.
 * @returns {object[]} the decoded objects.
 */
function parseJsonList(values) {
  if (!Array.isArray(values)) return []
  const parsed = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    try {
      parsed.push(JSON.parse(value))
    } catch {
      // A record this version cannot read is skipped, not fatal.
    }
  }
  return parsed
}

/**
 * Turn the three Jujutsu ref lists into the panel's ref shape.
 *
 * Local bookmarks and tags keep their names. Remote refs are written
 * `name@remote`, matching Jujutsu's own display, because two remotes may point
 * at the same commit.
 * @param {object} record - one decoded commit record.
 * @returns {{ name: string, kind: 'bookmark' | 'remote' | 'tag', conflict?: true }[]} the refs.
 */
export function parseJjRefs(record) {
  const refs = []
  for (const bookmark of parseJsonList(record.localBookmarks)) {
    if (typeof bookmark.name !== 'string' || bookmark.name === '') continue
    refs.push({
      name: bookmark.name,
      kind: 'bookmark',
      ...(bookmark.conflict === true ? { conflict: true } : {}),
    })
  }
  for (const bookmark of parseJsonList(record.remoteBookmarks)) {
    if (typeof bookmark.name !== 'string' || bookmark.name === '') continue
    const name = typeof bookmark.remote === 'string' && bookmark.remote !== ''
      ? `${bookmark.name}@${bookmark.remote}`
      : bookmark.name
    refs.push({
      name,
      kind: 'remote',
      ...(bookmark.conflict === true ? { conflict: true } : {}),
    })
  }
  for (const tag of parseJsonList(record.tags)) {
    if (typeof tag.name !== 'string' || tag.name === '') continue
    const name = typeof tag.remote === 'string' && tag.remote !== ''
      ? `${tag.name}@${tag.remote}`
      : tag.name
    refs.push({ name, kind: 'tag' })
  }
  return refs
}

/**
 * Parse one decoded commit record into a timeline node.
 * @param {object} record - one decoded JSON object.
 * @returns {object | undefined} the commit, or undefined for a malformed record.
 */
export function parseJjCommit(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (!isFullSha(record.sha)) return undefined
  const parents = Array.isArray(record.parents)
    ? record.parents.filter(parent => isFullSha(parent) && parent !== ZERO_SHA)
    : []
  const commit = {
    sha: record.sha,
    changeId: typeof record.changeId === 'string' ? record.changeId : undefined,
    parents,
    refs: parseJjRefs(record),
    author: typeof record.author === 'string' ? record.author : '',
    authorTime: seconds(record.authorTime),
    subject: typeof record.subject === 'string' ? record.subject : '',
    workingCopy: record.workingCopy === true,
    empty: record.empty === true,
    conflict: record.conflict === true,
  }
  if (typeof record.committer === 'string') commit.committer = record.committer
  if (record.committerTime !== undefined) commit.committerTime = seconds(record.committerTime)
  if (typeof record.description === 'string') commit.message = record.description.replace(/\n+$/u, '')
  return commit
}

/**
 * Parse the per-file stats list a detail template emits.
 * @param {unknown} values - the list of JSON strings.
 * @returns {Map<string, { added: number, removed: number, status: string }>} stats by target path.
 */
export function parseJjStats(values) {
  const stats = new Map()
  for (const entry of parseJsonList(values)) {
    if (typeof entry.path !== 'string' || entry.path === '') continue
    stats.set(entry.path, {
      added: Number.isInteger(entry.added) ? entry.added : 0,
      removed: Number.isInteger(entry.removed) ? entry.removed : 0,
      status: typeof entry.status === 'string' ? entry.status : 'M',
    })
  }
  return stats
}

/**
 * Parse one changed-file record.
 * @param {object} record - one decoded JSON object.
 * @returns {object | undefined} the entry, or undefined when malformed.
 */
export function parseJjEntry(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (typeof record.path !== 'string' || record.path === '') return undefined
  const status = typeof record.status === 'string' && record.status !== '' ? record.status : 'M'
  return {
    path: record.path,
    source: typeof record.source === 'string' && record.source !== '' ? record.source : undefined,
    status,
    fileType: typeof record.fileType === 'string' ? record.fileType : '',
    conflict: record.conflict === true,
  }
}

/**
 * Pair changed-file entries with their line counts.
 * @param {object[]} entries - parsed entries.
 * @param {Map<string, { added: number, removed: number }>} stats - counts by target path.
 * @returns {object[]} the view's FileEntry rows.
 */
export function mergeJjFiles(entries, stats) {
  return entries.map(entry => {
    const measured = stats.get(entry.path)
    const status = entry.conflict ? 'U' : entry.status
    const renamed = (status === 'R' || status === 'C') && entry.source !== undefined && entry.source !== entry.path
    return {
      path: entry.path,
      status,
      ...(renamed ? { origPath: entry.source } : {}),
      added: measured?.added ?? 0,
      deleted: measured?.removed ?? 0,
      binary: false,
      ...(entry.conflict ? { conflict: true } : {}),
    }
  })
}

/**
 * Escape one repository-relative path as a Jujutsu `file:` fileset.
 *
 * The path is passed as its own argv element (no shell), so only the fileset's
 * string literal needs escaping. Backslashes and control characters were
 * already rejected by `validateRelPath`.
 * @param {string} path - validated repository-relative path.
 * @returns {string} the exact-path fileset.
 */
export function jjFilePattern(path) {
  return `file:"${path.replace(/"/gu, '\\"')}"`
}

/**
 * Whether a Jujutsu `--git` patch carries binary content.
 *
 * Jujutsu prints binary files as a textual patch with the raw bytes rather
 * than a "Binary files differ" marker like git. Undecodable bytes arrive as
 * U+FFFD and a NUL byte survives decoding, so either means this is not text
 * the view can render.
 * @param {string} text - the diff output.
 * @returns {boolean} true when the comparison is binary.
 */
export function isJjBinaryDiff(text) {
  return text.includes('\u0000') || text.includes('\uFFFD') || /^Binary files .* differ$/mu.test(text)
}

/**
 * Split template output into decoded JSON records.
 * @param {string} text - newline-separated JSON objects.
 * @returns {object[]} the records.
 */
export function parseJjRecords(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') records.push(value)
    } catch {
      // Skip a record this version cannot read.
    }
  }
  return records
}
