/**
 * Jujutsu backend.
 *
 * Jujutsu's working copy is a commit (`@`), so the timeline has no synthetic
 * working-tree row: `@` is one ordinary commit row, selected by default. A
 * commit's files are compared against the automatic merge of its parents,
 * which is Jujutsu's own `jj diff -r <rev>` meaning.
 *
 * Reading `jj` snapshots the working copy. The backend does that once per
 * refresh, then runs every read with `--ignore-working-copy`, so a page with
 * several diff requests writes the working-copy state at most once. The panel
 * never creates, moves, or rewrites a commit or bookmark itself.
 */

import {
  badRequest,
  notFound,
  outputTooLarge,
  VcsError,
} from '../errors.js'
import {
  countRenderedLines,
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  fileHeaderCount,
  parseUnifiedDiff,
} from '../diff.js'
import {
  isJjBinaryDiff,
  JujutsuRunner,
  JJ_DETAIL_TEMPLATE,
  JJ_DIFF_ENTRY_TEMPLATE,
  JJ_LOG_TEMPLATE,
  JJ_SNAPSHOT_TEMPLATE,
  jjFilePattern,
  mergeJjFiles,
  parseJjCommit,
  parseJjEntry,
  parseJjRecords,
  parseJjStats,
} from '../jujutsu.js'
import { COMMIT_FILE_MAX } from '../commit.js'
import { LOG_PAGE_MAX, LOG_SKIP_MAX } from '../log.js'
import { WORKING_COPY_NODE } from '../nodes.js'
import { isFullSha, validateRelPath } from '../paths.js'
import { JUJUTSU_CAPABILITIES } from './capabilities.js'

/** Revision inputs: the working-copy commit or a hexadecimal commit id. */
const REVISION = /^[0-9a-fA-F]{7,64}$/u

/** Clamp a number into a range. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Accept the only revision values the client may send: `@` or an id.
 * @param {unknown} value - the requested revision.
 * @returns {string | undefined} the safe revision token.
 */
function validateRevision(value) {
  if (typeof value !== 'string') return undefined
  if (value === WORKING_COPY_NODE) return value
  return REVISION.test(value) ? value.toLowerCase() : undefined
}

/** The Jujutsu backend. */
export class JujutsuBackend {
  #observed = new Map()

  /**
   * @param {object} ctx - Host context carrying `subprocess`.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.runner = new JujutsuRunner(ctx)
  }

  /** Capabilities the client reads to choose its layout. */
  get capabilities() {
    return JUJUTSU_CAPABILITIES
  }

  /**
   * Fail with `vcs-missing` when this host has no jj.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<void>}
   */
  async require(signal) {
    if (await this.runner.resolve(signal) === null) {
      throw new VcsError('vcs-missing', 'jj is not available on this host.')
    }
  }

  /**
   * Snapshot the working copy for a group of reads.
   *
   * Jujutsu snapshots as part of every command unless `--ignore-working-copy`
   * is given. Status is the refresh path, so it asks for a fresh snapshot;
   * every other read reuses the last one, and concurrent callers share the
   * in-flight snapshot. That keeps writes to one per refresh, not one per
   * route request.
   * @param {string} root - repository root.
   * @param {AbortSignal} signal - cancellation.
   * @param {{ fresh?: boolean }} [options] - whether to force a new snapshot.
   * @returns {Promise<void>}
   */
  async #observe(root, signal, { fresh = false } = {}) {
    const cached = this.#observed.get(root)
    if (cached !== undefined) {
      if (cached.pending || !fresh) {
        await cached.promise
        return
      }
    }
    const entry = { pending: true, promise: this.#snapshot(root, signal) }
    this.#observed.set(root, entry)
    try {
      await entry.promise
      entry.pending = false
    } catch (error) {
      if (this.#observed.get(root) === entry) this.#observed.delete(root)
      throw error
    }
  }

  /**
   * Run the one command that snapshots the working copy.
   * @param {string} root - repository root.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<void>}
   */
  async #snapshot(root, signal) {
    const result = await this.runner.run(
      ['log', '--no-graph', '-r', WORKING_COPY_NODE, '-T', JJ_SNAPSHOT_TEMPLATE],
      { cwd: root, signal },
    )
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) {
      throw new VcsError('internal', 'The working copy could not be read.')
    }
  }

  /**
   * Run one read command without snapshotting again.
   * @param {string[]} args - jj arguments after the fixed prefix.
   * @param {object} options - run options.
   * @returns {Promise<object>} the command result.
   */
  async #read(args, options) {
    return this.runner.run(['--ignore-working-copy', ...args], options)
  }

  /**
   * Read one commit's detail record.
   * @param {string} root - repository root.
   * @param {string} rev - `@` or a validated revision.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ commit: object, record: object }>} the parsed commit and its raw record.
   */
  async #readDetail(root, rev, signal) {
    const result = await this.#read(
      ['log', '--no-graph', '-r', rev, '-T', JJ_DETAIL_TEMPLATE],
      { cwd: root, signal },
    )
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) throw notFound('That commit is not available.')
    const records = parseJjRecords(result.stdout)
    if (records.length === 0) throw notFound('That commit is not available.')
    if (records.length > 1) throw badRequest('The revision names more than one commit.')
    const commit = parseJjCommit(records[0])
    if (commit === undefined || !isFullSha(commit.sha)) {
      throw new VcsError('internal', 'The commit metadata could not be read.')
    }
    return { commit, record: records[0] }
  }

  /**
   * Read the changed-file entries of one commit.
   * @param {string} root - repository root.
   * @param {string} rev - `@` or a full commit id.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object[]>} the entries.
   */
  async #readEntries(root, rev, signal) {
    const result = await this.#read(
      ['diff', '-r', rev, '-T', JJ_DIFF_ENTRY_TEMPLATE],
      { cwd: root, signal },
    )
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) {
      throw new VcsError('internal', 'The commit files could not be read.')
    }
    return parseJjRecords(result.stdout)
      .map(parseJjEntry)
      .filter(entry => entry !== undefined)
  }

  /**
   * Working-copy facts for the header, timeline, and default selection.
   * @param {string} root - repository root.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object>} the status payload.
   */
  async status(root, signal) {
    await this.#observe(root, signal, { fresh: true })
    const { commit, record } = await this.#readDetail(root, WORKING_COPY_NODE, signal)
    const changed = Number.isInteger(record.changed) ? record.changed : 0
    const added = Number.isInteger(record.added) ? record.added : 0
    const deleted = Number.isInteger(record.deleted) ? record.deleted : 0
    return {
      branch: null,
      workingCopy: {
        node: WORKING_COPY_NODE,
        commitId: commit.sha,
        changeId: commit.changeId,
        parents: commit.parents,
        refs: commit.refs,
        subject: commit.subject,
        author: commit.author,
        authorTime: commit.authorTime,
        empty: commit.empty,
        conflict: commit.conflict,
        summary: { changed, added, deleted },
      },
      groups: {},
      total: changed,
      truncated: false,
      defaultNode: WORKING_COPY_NODE,
    }
  }

  /**
   * One page of history.
   * @param {string} root - repository root.
   * @param {{ ref: unknown, limit: number, skip: number }} page - page selection.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ commits: object[], truncated: boolean, nextSkip: number | null }>} the page.
   */
  async log(root, page, signal) {
    const ref = typeof page.ref === 'string' ? page.ref : WORKING_COPY_NODE
    if (ref !== WORKING_COPY_NODE && ref !== 'all') {
      throw badRequest('ref is @ or all.')
    }
    const limit = clamp(page.limit, 1, LOG_PAGE_MAX)
    const skip = clamp(page.skip, 0, LOG_SKIP_MAX)
    const cap = Math.min(skip + limit, LOG_SKIP_MAX)
    if (cap <= skip) return { commits: [], truncated: false, nextSkip: null }

    await this.#observe(root, signal)
    const revset = ref === 'all' ? 'all() ~ root()' : '::@ ~ root()'
    const result = await this.#read(
      ['log', '--no-graph', '-r', revset, '-n', String(cap), '-T', JJ_LOG_TEMPLATE],
      { cwd: root, signal },
    )
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) {
      throw new VcsError('internal', 'The history could not be read.')
    }

    const commits = parseJjRecords(result.stdout)
      .map(parseJjCommit)
      .filter(commit => commit !== undefined)
      .slice(skip, skip + limit)
    const truncated = skip + commits.length >= LOG_SKIP_MAX
    return {
      commits,
      truncated,
      nextSkip: commits.length === 0 ? null : skip + commits.length,
    }
  }

  /**
   * One commit's metadata and changed files.
   * @param {string} root - repository root.
   * @param {unknown} rawRev - `@` or a commit id.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ commit: object, truncated: boolean }>} the commit.
   */
  async commit(root, rawRev, signal) {
    const rev = validateRevision(rawRev)
    if (rev === undefined) throw badRequest('sha must be @ or a hexadecimal commit id.')

    await this.#observe(root, signal)
    const { commit, record } = await this.#readDetail(root, rev, signal)
    const entries = await this.#readEntries(root, commit.sha, signal)
    const files = mergeJjFiles(entries, parseJjStats(record.stats))
    const truncated = files.length > COMMIT_FILE_MAX
    return {
      commit: {
        ...commit,
        message: commit.message ?? '',
        files: truncated ? files.slice(0, COMMIT_FILE_MAX) : files,
      },
      truncated,
    }
  }

  /**
   * One file's comparison within a commit, or in the working-copy commit.
   * @param {string} root - repository root.
   * @param {{ scope: unknown, path: unknown, oldPath: unknown, rev: unknown }} target - comparison target.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object>} the comparison state.
   */
  async diff(root, target, signal) {
    if (target.scope !== 'commit') {
      throw badRequest('scope is commit for Jujutsu.')
    }
    const rev = validateRevision(target.rev)
    if (rev === undefined) throw badRequest('rev must be @ or a hexadecimal commit id.')
    const rel = validateRelPath(target.path)
    if (rel === undefined) throw badRequest('path must be a repository-relative file path.')

    await this.#observe(root, signal)
    const output = await this.#read(
      ['diff', '--git', '-r', rev, '--', jjFilePattern(rel)],
      { cwd: root, signal, maxBytes: DIFF_MAX_BYTES + 1 },
    )
    if (output.lossy || Buffer.byteLength(output.stdout, 'utf8') > DIFF_MAX_BYTES) {
      return { kind: 'oversized', path: rel }
    }
    if (output.exitCode !== 0) throw notFound('That comparison is not available.')
    if (fileHeaderCount(output.stdout) > 1) {
      throw badRequest('The path matches more than one file.')
    }
    if (isJjBinaryDiff(output.stdout)) return { kind: 'binary', path: rel }

    const comparison = parseUnifiedDiff(output.stdout)
    if (comparison.hunks.length === 0) {
      // An empty patch means either "no change" or "not in this commit"; list
      // the commit's files to tell them apart without touching the working tree.
      const listed = await this.#read(
        ['file', 'list', '-r', rev, '--', jjFilePattern(rel)],
        { cwd: root, signal },
      )
      if (listed.lossy) throw outputTooLarge()
      if (listed.exitCode !== 0) {
        throw new VcsError('internal', 'The comparison could not be read.')
      }
      if (listed.stdout.trim() === '') throw notFound('That file is not part of the commit.')
      return {
        kind: 'text',
        path: rel,
        before: true,
        after: true,
        hunks: [],
      }
    }
    if (countRenderedLines(comparison.hunks) > DIFF_MAX_LINES) {
      return { kind: 'oversized', path: rel }
    }
    return {
      kind: 'text',
      path: rel,
      before: comparison.before,
      after: comparison.after,
      hunks: comparison.hunks,
    }
  }
}
