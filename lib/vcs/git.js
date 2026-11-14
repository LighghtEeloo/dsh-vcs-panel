/**
 * Git backend: status, one file's comparison, history, and commit detail.
 *
 * Every route reads. The runner states the fixed safety flags in `../git.js`;
 * argv here is built from fixed strings plus values already validated by the
 * handler or by this module, never from a shell.
 */

import {
  badRequest,
  notFound,
  outputTooLarge,
  VcsError,
} from '../errors.js'
import {
  COMMIT_FILE_MAX,
  COMMIT_FORMAT,
  mergeCommitFiles,
  parseCommitMetadata,
  parseNameStatusZ,
} from '../commit.js'
import {
  countRenderedLines,
  decodeFileContent,
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  fileHeaderCount,
  isBinaryDiff,
  parseUnifiedDiff,
  syntheticNewFile,
} from '../diff.js'
import { GitRunner } from '../git.js'
import { LOG_FORMAT, LOG_PAGE_MAX, LOG_SKIP_MAX, parseLog, parseRefNames } from '../log.js'
import { WORKING_TREE_NODE } from '../nodes.js'
import { EMPTY_TREE, isFullSha, validateRelPath, validateSha } from '../paths.js'
import { buildStatusGroups, parseNumstat, parsePorcelainV2 } from '../status.js'
import { containPath } from '../contain.js'
import { GIT_CAPABILITIES } from './capabilities.js'

/** Most entries one expanded untracked directory lists. */
const UNTRACKED_MAX = 500

/** The four comparisons the diff route serves for Git. */
const SCOPES = new Set(['staged', 'unstaged', 'untracked', 'commit'])

/**
 * Prefix a repository-relative path with git's `literal` pathspec magic.
 * Without it a path that starts with `:` would be read as pathspec magic
 * (glob or exclude), which can widen the match far beyond the named file.
 * @param {string} path - a validated repository-relative path.
 * @returns {string} the literal pathspec.
 */
function literalPathspec(path) {
  return `:(literal)${path}`
}

/**
 * Clamp a number into a range.
 * @param {number} value - the number.
 * @param {number} min - lowest accepted value.
 * @param {number} max - highest accepted value.
 * @returns {number} the clamped value.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Ask which of a directory's direct children git ignores, in one batch.
 * @param {GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string[]} paths - repository-relative child paths.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<Set<string>>} the ignored paths.
 */
async function ignoredPaths(git, root, paths, signal) {
  if (paths.length === 0) return new Set()
  const result = await git.run(['check-ignore', '-z', '--stdin', '--'], {
    cwd: root,
    signal,
    stdin: `${paths.join(String.fromCharCode(0))}${String.fromCharCode(0)}`,
  })
  // 0 means "some paths matched", 1 means "none matched"; both are answers.
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new VcsError('internal', 'Ignored paths could not be checked.')
  }
  return new Set(result.stdout.split(String.fromCharCode(0)).filter(value => value !== ''))
}

/** The Git backend. */
export class GitBackend {
  /**
   * @param {object} ctx - Host context carrying `fs` and `subprocess`.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.git = new GitRunner(ctx)
  }

  /** Capabilities the client reads to choose its layout. */
  get capabilities() {
    return GIT_CAPABILITIES
  }

  /**
   * Fail with `vcs-missing` when this host has no git.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<void>}
   */
  async require(signal) {
    if (await this.git.resolve(signal) === null) {
      throw new VcsError('vcs-missing', 'git is not available on this host.')
    }
  }

  /**
   * Working-tree status and the three file groups.
   * @param {string} root - repository root.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object>} branch, groups, totals, and the default node.
   */
  async status(root, signal) {
    const statusResult = await this.git.run(
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'],
      { cwd: root, signal },
    )
    if (statusResult.lossy) throw outputTooLarge()
    if (statusResult.exitCode !== 0) {
      throw new VcsError('internal', 'The repository status could not be read.')
    }
    const parsed = parsePorcelainV2(statusResult.stdout)

    const [staged, unstaged] = await Promise.all([
      this.git.run(['--no-pager', 'diff', '--numstat', '-z', '--cached'], {
        cwd: root,
        signal,
      }),
      this.git.run(['--no-pager', 'diff', '--numstat', '-z'], {
        cwd: root,
        signal,
      }),
    ])
    if (staged.lossy || unstaged.lossy) throw outputTooLarge()

    const grouped = buildStatusGroups(
      parsed.entries,
      parseNumstat(staged.stdout),
      parseNumstat(unstaged.stdout),
    )
    const defaultNode = grouped.total > 0
      ? WORKING_TREE_NODE
      : (parsed.branch.oid ?? WORKING_TREE_NODE)
    return {
      branch: parsed.branch,
      groups: grouped.groups,
      truncated: grouped.truncated,
      total: grouped.total,
      defaultNode,
    }
  }

  /**
   * Direct children of one untracked directory.
   * @param {string} root - repository root.
   * @param {unknown} raw - the directory path, slash-suffixed.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object>} the listing.
   */
  async untracked(root, raw, signal) {
    if (typeof raw !== 'string' || !raw.endsWith('/')) {
      throw badRequest('path must be a directory path ending with /.')
    }
    const rel = validateRelPath(raw.slice(0, -1))
    if (rel === undefined) throw badRequest('path must be a repository-relative directory.')

    const target = await containPath(this.ctx, root, rel, signal)
    const info = await this.ctx.fs.stat(target, signal).catch(() => undefined)
    if (info === undefined) throw notFound('That directory is not present.')
    if (info.type !== 'directory') throw badRequest('That path is not a directory.')

    let listing
    try {
      listing = await this.ctx.fs.listDir(target, signal)
    } catch {
      throw notFound('That directory could not be read.')
    }

    const childPaths = listing.map(entry => `${rel}/${entry.name}`)
    const ignored = await ignoredPaths(this.git, root, childPaths, signal)

    const entries = []
    for (const entry of listing) {
      const entryPath = `${rel}/${entry.name}`
      if (ignored.has(entryPath)) continue
      entries.push({
        name: entry.name,
        path: entryPath,
        type: entry.type === 'directory' ? 'directory' : 'file',
      })
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const truncated = entries.length > UNTRACKED_MAX
    return {
      path: `${rel}/`,
      entries: truncated ? entries.slice(0, UNTRACKED_MAX) : entries,
      truncated,
    }
  }

  /**
   * Resolve `rev` for a commit diff into the two commits to compare.
   *
   * The id is hexadecimal and resolved to a full commit before it is used in
   * any further argv, so a request value never becomes an option or a revision
   * expression beyond `rev-parse --verify`.
   *
   * @param {unknown} rawRev - the request value.
   * @param {string} root - repository root.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ from: string, to: string }>} the comparison.
   */
  async resolveDiffCommit(rawRev, root, signal) {
    const rev = validateSha(rawRev)
    if (rev === undefined) throw badRequest('rev must be a hexadecimal commit id.')
    const resolved = await this.git.run(['rev-parse', '--verify', `${rev}^{commit}`], {
      cwd: root,
      signal,
    })
    if (resolved.exitCode !== 0 || resolved.lossy) throw notFound('That commit is not available.')
    const to = resolved.stdout.trim()
    if (!isFullSha(to)) throw notFound('That commit is not available.')

    const parentsResult = await this.git.run(['rev-list', '--parents', '-n', '1', to], {
      cwd: root,
      signal,
    })
    if (parentsResult.exitCode !== 0) {
      throw new VcsError('internal', 'The commit parents could not be read.')
    }
    const [, ...parents] = parentsResult.stdout.trim().split(' ').filter(value => value !== '')
    // A root commit has nothing to compare against, so it diffs from the empty
    // tree: every file in it renders as added.
    return { from: parents.length > 0 ? parents[0] : EMPTY_TREE, to }
  }

  /**
   * Ask whether git's numstat calls the requested comparison binary.
   * @param {string} root - repository root.
   * @param {'staged' | 'unstaged' | 'commit'} scope - the comparison.
   * @param {{ from: string, to: string } | undefined} range - commit range when scope is commit.
   * @param {string[]} paths - pathspec arguments.
   * @param {string} rel - repository-relative file path.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<boolean>} true when the comparison is binary.
   */
  async binaryFromNumstat(root, scope, range, paths, rel, signal) {
    const args = ['--no-pager', 'diff', '--numstat', '-z', '--no-color']
    if (scope === 'staged') args.push('--cached')
    if (range !== undefined) args.push(range.from, range.to)
    args.push('--', ...paths.map(literalPathspec))
    const result = await this.git.run(args, { cwd: root, signal })
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) return false
    return parseNumstat(result.stdout).get(rel)?.binary === true
  }

  /**
   * Reject a request whose path names a directory or a broad pathspec rather
   * than the single file the view renders.
   * @param {string} type - the object type git reported.
   * @returns {void}
   */
  refuseDirectory(type) {
    if (type === 'tree') throw badRequest('The path names a directory, not a file.')
  }

  /**
   * Confirm that a path is present on the commit side of a commit comparison.
   * @param {string} root - repository root.
   * @param {string} rev - full commit id.
   * @param {string} rel - repository-relative file path.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<'blob' | 'tree' | 'absent'>} the object type.
   */
  async commitPathType(root, rev, rel, signal) {
    const result = await this.git.run(['cat-file', '-t', `${rev}:${rel}`], { cwd: root, signal })
    if (result.exitCode !== 0) return 'absent'
    const type = result.stdout.trim()
    return type === 'blob' || type === 'tree' ? type : 'absent'
  }

  /**
   * Confirm that a path is tracked in the index.
   * @param {string} root - repository root.
   * @param {string} rel - repository-relative file path.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<boolean>} true when the index knows the path.
   */
  async trackedInIndex(root, rel, signal) {
    const result = await this.git.run(['ls-files', '-z', '--', literalPathspec(rel)], {
      cwd: root,
      signal,
    })
    if (result.exitCode !== 0 || result.lossy) return false
    return result.stdout !== ''
  }

  /**
   * Present one untracked file as a wholly new text or binary file.
   * @param {string} rel - repository-relative file path.
   * @param {object} target - resolved filesystem target.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object>} the diff answer.
   */
  async untrackedDiff(rel, target, signal) {
    const info = await this.ctx.fs.stat(target, signal).catch(() => undefined)
    if (info === undefined) throw notFound('That file is not present.')
    if (info.type !== 'file') throw badRequest('That path is not a file.')
    if (info.size !== undefined && info.size > DIFF_MAX_BYTES) {
      return { kind: 'oversized', path: rel }
    }

    let bytes
    try {
      bytes = await this.ctx.fs.readBytes(target, signal, DIFF_MAX_BYTES + 1)
    } catch (error) {
      const text = `${error?.code ?? ''} ${error?.message ?? ''}`
      if (/TOO_LARGE|too large/iu.test(text)) return { kind: 'oversized', path: rel }
      throw notFound('That file is no longer available.')
    }
    if (bytes.byteLength > DIFF_MAX_BYTES) return { kind: 'oversized', path: rel }

    const decoded = decodeFileContent(bytes)
    if (decoded.binary) return { kind: 'binary', path: rel }
    const comparison = syntheticNewFile(decoded.text)
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

  /**
   * One file comparison.
   * @param {string} root - repository root.
   * @param {{ scope: unknown, path: unknown, oldPath: unknown, rev: unknown }} target - comparison target.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object>} the comparison state.
   */
  async diff(root, target, signal) {
    const scope = target.scope
    if (typeof scope !== 'string' || !SCOPES.has(scope)) {
      throw badRequest('scope is unstaged, staged, untracked, or commit.')
    }
    const rel = validateRelPath(target.path)
    if (rel === undefined) throw badRequest('path must be a repository-relative file path.')
    const rawOldPath = target.oldPath
    const oldPath = rawOldPath === null || rawOldPath === undefined ? undefined : validateRelPath(rawOldPath)
    if (rawOldPath !== null && rawOldPath !== undefined && oldPath === undefined) {
      throw badRequest('oldPath must be a repository-relative file path.')
    }

    const resolvedTarget = await containPath(this.ctx, root, rel, signal)
    if (scope === 'untracked') return this.untrackedDiff(rel, resolvedTarget, signal)
    if (oldPath !== undefined) await containPath(this.ctx, root, oldPath, signal)
    // A rename is only detected when both sides are named; one path reads as a
    // brand-new or deleted file instead.
    const paths = oldPath === undefined || oldPath === rel ? [rel] : [oldPath, rel]

    let range
    if (scope === 'commit') {
      const resolved = await this.resolveDiffCommit(target.rev, root, signal)
      range = { from: resolved.from, to: resolved.to }
    }

    const current = await this.ctx.fs.stat(resolvedTarget, signal).catch(() => undefined)
    if (range === undefined && current?.type === 'directory') {
      throw badRequest('That path is a directory, not a file.')
    }

    const args = ['--no-pager', 'diff', '--no-ext-diff', '--no-color', '-U3']
    if (scope === 'staged') args.push('--cached')
    if (range !== undefined) args.push(range.from, range.to)
    args.push('--', ...paths.map(literalPathspec))
    const output = await this.git.run(args, {
      cwd: root,
      signal,
      maxBytes: DIFF_MAX_BYTES + 1,
    })
    if (output.lossy || Buffer.byteLength(output.stdout, 'utf8') > DIFF_MAX_BYTES) {
      return { kind: 'oversized', path: rel }
    }
    if (output.exitCode !== 0) {
      throw new VcsError('internal', 'The comparison could not be read.')
    }
    if (fileHeaderCount(output.stdout) > 1) {
      throw badRequest('The path matches more than one file.')
    }
    if (isBinaryDiff(output.stdout)) return { kind: 'binary', path: rel }

    const comparison = parseUnifiedDiff(output.stdout)
    if (comparison.hunks.length === 0) {
      if (await this.binaryFromNumstat(root, scope, range, paths, rel, signal)) {
        return { kind: 'binary', path: rel }
      }
      if (range !== undefined) {
        const type = await this.commitPathType(root, range.to, rel, signal)
        this.refuseDirectory(type)
        if (type !== 'blob') throw notFound('That file is not part of the commit.')
      } else if (scope === 'staged') {
        if (!(await this.trackedInIndex(root, rel, signal))) {
          throw notFound('That file is not staged.')
        }
      } else {
        const fresh = await this.ctx.fs.stat(resolvedTarget, signal).catch(() => undefined)
        if (fresh === undefined) throw notFound('That file is not present.')
        if (fresh.type === 'directory') throw badRequest('That path is a directory, not a file.')
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

  /**
   * One page of commits.
   * @param {string} root - repository root.
   * @param {{ ref: unknown, limit: number, skip: number }} page - page selection.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ commits: object[], truncated: boolean, nextSkip: number | null }>} the page.
   */
  async log(root, page, signal) {
    const ref = typeof page.ref === 'string' ? page.ref : 'HEAD'
    if (ref !== 'HEAD' && ref !== 'all') throw badRequest('ref is HEAD or all.')
    const limit = clamp(page.limit, 1, LOG_PAGE_MAX)
    const skip = clamp(page.skip, 0, LOG_SKIP_MAX)

    const args = [
      '--no-pager',
      'log',
      '--no-color',
      '--topo-order',
      '--decorate=full',
      `--format=${LOG_FORMAT}`,
      `--max-count=${limit}`,
      `--skip=${skip}`,
    ]
    args.push(ref === 'all' ? '--all' : 'HEAD')
    const result = await this.git.run(args, { cwd: root, signal })
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) {
      // An unborn branch has no HEAD to walk; that is an empty history, not a
      // failure. Every other complaint is a real read failure.
      if (ref === 'HEAD' && /unknown revision|does not have any commits|bad revision|ambiguous argument/iu.test(result.stderr)) {
        return { commits: [], truncated: false, nextSkip: null }
      }
      throw new VcsError('internal', 'The history could not be read.')
    }

    const commits = parseLog(result.stdout)
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
   * @param {unknown} rawSha - full or abbreviated commit id.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ commit: object, truncated: boolean }>} the commit.
   */
  async commit(root, rawSha, signal) {
    const sha = validateSha(rawSha)
    if (sha === undefined) throw badRequest('sha must be a hexadecimal commit id.')
    const resolved = await this.git.run(['rev-parse', '--verify', `${sha}^{commit}`], {
      cwd: root,
      signal,
    })
    if (resolved.exitCode !== 0 || resolved.lossy) throw notFound('That commit is not available.')
    const full = resolved.stdout.trim()
    if (!isFullSha(full)) throw notFound('That commit is not available.')

    const metadataResult = await this.git.run(
      ['--no-pager', 'show', '-s', '--no-color', `--format=${COMMIT_FORMAT}`, full],
      { cwd: root, signal },
    )
    if (metadataResult.lossy) throw outputTooLarge()
    if (metadataResult.exitCode !== 0) {
      throw new VcsError('internal', 'The commit metadata could not be read.')
    }
    const metadata = parseCommitMetadata(metadataResult.stdout)
    if (metadata === undefined) {
      throw new VcsError('internal', 'The commit metadata could not be read.')
    }

    const refsResult = await this.git.run(
      ['for-each-ref', '--format=%(refname)', `--points-at=${full}`],
      { cwd: root, signal },
    )
    if (refsResult.lossy) throw outputTooLarge()
    if (refsResult.exitCode !== 0) {
      throw new VcsError('internal', 'The commit refs could not be read.')
    }

    // A merge commit has no default diff in diff-tree; the design compares a
    // selected file against the first parent, so that comparison is explicit.
    // `--no-ext-diff` keeps a repository-configured external diff program out
    // of every comparison, matching the diff route.
    const base = ['diff-tree', '--no-ext-diff', '--no-commit-id', '-r', '-M', '-z']
    const tree = metadata.parents.length > 1
      ? [metadata.parents[0], full]
      : ['--root', full]
    const [names, counts] = await Promise.all([
      this.git.run([...base, '--name-status', ...tree], { cwd: root, signal }),
      this.git.run([...base, '--numstat', ...tree], { cwd: root, signal }),
    ])
    if (names.lossy || counts.lossy) throw outputTooLarge()
    if (names.exitCode !== 0 || counts.exitCode !== 0) {
      throw new VcsError('internal', 'The commit files could not be read.')
    }

    const files = mergeCommitFiles(parseNameStatusZ(names.stdout), parseNumstat(counts.stdout))
    const truncated = files.length > COMMIT_FILE_MAX
    return {
      commit: {
        sha: metadata.sha,
        parents: metadata.parents,
        refs: parseRefNames(refsResult.stdout),
        author: metadata.author,
        authorTime: metadata.authorTime,
        committer: metadata.committer,
        committerTime: metadata.committerTime,
        subject: metadata.subject,
        message: metadata.message,
        files: truncated ? files.slice(0, COMMIT_FILE_MAX) : files,
      },
      truncated,
    }
  }
}
