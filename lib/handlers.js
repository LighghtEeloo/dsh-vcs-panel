/**
 * The six read-only routes of the panel.
 *
 * Every handler takes one authenticated `Request` and answers with a JSON
 * `Response`. `createHandlers` exists apart from the Cordis wiring so tests can
 * drive the routes with a fake host context, and so `apply` stays thin.
 */

import { join } from 'node:path'

import {
  badRequest,
  errorResponse,
  json,
  notFound,
  outputTooLarge,
  VcsError,
} from './errors.js'
import { COMMIT_FILE_MAX, COMMIT_FORMAT, mergeCommitFiles, parseCommitMetadata, parseNameStatusZ } from './commit.js'
import {
  countRenderedLines,
  decodeFileContent,
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  fileHeaderCount,
  isBinaryDiff,
  parseUnifiedDiff,
  syntheticNewFile,
} from './diff.js'
import { GitRunner } from './git.js'
import { LOG_FORMAT, LOG_PAGE_MAX, LOG_SKIP_MAX, parseLog, parseRefNames } from './log.js'
import { EMPTY_TREE, isFullSha, sameRepoPath, validateRelPath, validateSha } from './paths.js'
import { discoverRepositories } from './repositories.js'
import { buildStatusGroups, parseNumstat, parsePorcelainV2 } from './status.js'

/** Most entries one expanded untracked directory lists. */
const UNTRACKED_MAX = 500

/** The four comparisons the diff route serves. */
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
 * Read an optional integer query value.
 * @param {string | null} value - the query value.
 * @param {number} fallback - value when the query omits it.
 * @returns {number | undefined} the number, or undefined when malformed.
 */
function readInteger(value, fallback) {
  if (value === null) return fallback
  if (!/^-?\d+$/u.test(value)) return undefined
  return Number(value)
}

/**
 * Ask which of a directory's direct children git ignores, in one batch.
 * @param {import('./git.js').GitRunner} git - command runner.
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

/**
 * Build the route handlers bound to one host context.
 *
 * @param {object} ctx - Host context carrying `sessions`, `fs`, and `subprocess`.
 * @returns {{ repositories: Function, status: Function, untracked: Function, diff: Function, log: Function, commit: Function }}
 *   one request handler per route.
 */
export function createHandlers(ctx) {
  const git = new GitRunner(ctx)

  /**
   * Resolve the session a request addresses to its working directory.
   * The client sends a session identity rather than a path, so the browser
   * cannot aim this plugin at an arbitrary directory.
   * @param {URLSearchParams} query - the request query.
   * @returns {Promise<string>} the session working directory.
   * @throws {VcsError} when the session or its directory is missing.
   */
  async function requireCwd(query) {
    const sessionId = query.get('sessionId')
    if (sessionId === null || sessionId === '') throw badRequest('sessionId is required.')
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new VcsError('no-session', 'This session is no longer available.')
    }
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new VcsError('no-cwd', 'This session has no working directory.')
    }
    return cwd
  }

  /**
   * Fail with the stable `git-missing` code when this host has no git.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<void>}
   */
  async function requireGit(signal) {
    if (await git.resolve(signal) === null) {
      throw new VcsError('git-missing', 'git is not available on this host.')
    }
  }

  /**
   * Resolve the request's repository query against what discovery offers,
   * never against the string alone.
   * @param {URLSearchParams} query - the request query.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ root: string, name: string, signal: AbortSignal }>} the repository.
   */
  async function requireRepository(query, signal) {
    const cwd = await requireCwd(query)
    await requireGit(signal)
    const repoQuery = query.get('repo')
    if (repoQuery === null || repoQuery === '') throw badRequest('repo is required.')
    const discovered = await discoverRepositories(ctx, git, cwd, signal)
    const match = discovered.repositories.find(repo => sameRepoPath(repo.path, repoQuery))
    if (match === undefined) {
      throw new VcsError('not-a-repo', 'The requested repository is not available in this session.')
    }
    return { root: match.path, name: match.name, signal }
  }

  /**
   * Resolve one repository-relative path, requiring its canonical target to sit
   * inside the canonical repository root.
   * @param {string} root - canonical repository root.
   * @param {string} rel - validated repository-relative path.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object>} the resolved target.
   */
  async function contain(root, rel, signal) {
    let repoTarget
    try {
      repoTarget = await ctx.fs.resolve(root, { signal })
    } catch {
      throw new VcsError('internal', 'The repository could not be opened.')
    }
    let target
    try {
      target = await ctx.fs.resolve(join(root, rel), { signal })
    } catch {
      throw badRequest('The path does not resolve inside the repository.')
    }
    if (!ctx.fs.contains(repoTarget, target)) {
      throw badRequest('The path is outside the repository.')
    }
    return target
  }

  /** Handle `GET /api/vcs.repositories`. */
  async function repositories(request) {
    const query = new URL(request.url).searchParams
    const cwd = await requireCwd(query)
    await requireGit(request.signal)
    const found = await discoverRepositories(ctx, git, cwd, request.signal)
    return json(found)
  }

  /** Handle `GET /api/vcs.status`. */
  async function status(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)

    const statusResult = await git.run(
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'],
      { cwd: repo.root, signal: request.signal },
    )
    if (statusResult.lossy) throw outputTooLarge()
    if (statusResult.exitCode !== 0) {
      throw new VcsError('internal', 'The repository status could not be read.')
    }
    const parsed = parsePorcelainV2(statusResult.stdout)

    const [staged, unstaged] = await Promise.all([
      git.run(['--no-pager', 'diff', '--numstat', '-z', '--cached'], {
        cwd: repo.root,
        signal: request.signal,
      }),
      git.run(['--no-pager', 'diff', '--numstat', '-z'], {
        cwd: repo.root,
        signal: request.signal,
      }),
    ])
    if (staged.lossy || unstaged.lossy) throw outputTooLarge()

    const grouped = buildStatusGroups(
      parsed.entries,
      parseNumstat(staged.stdout),
      parseNumstat(unstaged.stdout),
    )
    return json({
      repo: { path: repo.root, name: repo.name },
      branch: parsed.branch,
      groups: grouped.groups,
      truncated: grouped.truncated,
      total: grouped.total,
    })
  }

  /** Handle `GET /api/vcs.untracked`. */
  async function untracked(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)

    const raw = query.get('path')
    if (typeof raw !== 'string' || !raw.endsWith('/')) {
      throw badRequest('path must be a directory path ending with /.')
    }
    const rel = validateRelPath(raw.slice(0, -1))
    if (rel === undefined) throw badRequest('path must be a repository-relative directory.')

    const target = await contain(repo.root, rel, request.signal)
    const info = await ctx.fs.stat(target, request.signal).catch(() => undefined)
    if (info === undefined) throw notFound('That directory is not present.')
    if (info.type !== 'directory') throw badRequest('That path is not a directory.')

    let listing
    try {
      listing = await ctx.fs.listDir(target, request.signal)
    } catch {
      throw notFound('That directory could not be read.')
    }

    const childPaths = listing.map(entry => `${rel}/${entry.name}`)
    const ignored = await ignoredPaths(git, repo.root, childPaths, request.signal)

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
    return json({
      path: `${rel}/`,
      entries: truncated ? entries.slice(0, UNTRACKED_MAX) : entries,
      truncated,
    })
  }

  /**
   * Resolve `rev` for a commit diff into the two commits to compare.
   *
   * The id is hexadecimal and resolved to a full commit before it is used in
   * any further argv, so a request value never becomes an option or a revision
   * expression beyond `rev-parse --verify`.
   *
   * @param {URLSearchParams} query - the request query.
   * @param {object} repo - resolved repository.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ from: string, to: string }>} the comparison.
   */
  async function resolveDiffCommit(query, repo, signal) {
    const rev = validateSha(query.get('rev'))
    if (rev === undefined) throw badRequest('rev must be a hexadecimal commit id.')
    const resolved = await git.run(['rev-parse', '--verify', `${rev}^{commit}`], {
      cwd: repo.root,
      signal,
    })
    if (resolved.exitCode !== 0 || resolved.lossy) throw notFound('That commit is not available.')
    const to = resolved.stdout.trim()
    if (!isFullSha(to)) throw notFound('That commit is not available.')

    const parentsResult = await git.run(['rev-list', '--parents', '-n', '1', to], {
      cwd: repo.root,
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
   * @param {string} rel - repository-relative file path.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<boolean>} true when the comparison is binary.
   */
  async function binaryFromNumstat(root, scope, range, paths, rel, signal) {
    const args = ['--no-pager', 'diff', '--numstat', '-z', '--no-color']
    if (scope === 'staged') args.push('--cached')
    if (range !== undefined) args.push(range.from, range.to)
    args.push('--', ...paths.map(literalPathspec))
    const result = await git.run(args, { cwd: root, signal })
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
  function refuseDirectory(type) {
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
  async function commitPathType(root, rev, rel, signal) {
    const result = await git.run(['cat-file', '-t', `${rev}:${rel}`], { cwd: root, signal })
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
  async function trackedInIndex(root, rel, signal) {
    const result = await git.run(['ls-files', '-z', '--', literalPathspec(rel)], {
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
  async function untrackedDiff(rel, target, signal) {
    const info = await ctx.fs.stat(target, signal).catch(() => undefined)
    if (info === undefined) throw notFound('That file is not present.')
    if (info.type !== 'file') throw badRequest('That path is not a file.')
    if (info.size !== undefined && info.size > DIFF_MAX_BYTES) {
      return json({ kind: 'oversized', path: rel })
    }

    let bytes
    try {
      bytes = await ctx.fs.readBytes(target, signal, DIFF_MAX_BYTES + 1)
    } catch (error) {
      const text = `${error?.code ?? ''} ${error?.message ?? ''}`
      if (/TOO_LARGE|too large/iu.test(text)) return json({ kind: 'oversized', path: rel })
      throw notFound('That file is no longer available.')
    }
    if (bytes.byteLength > DIFF_MAX_BYTES) return json({ kind: 'oversized', path: rel })

    const decoded = decodeFileContent(bytes)
    if (decoded.binary) return json({ kind: 'binary', path: rel })
    const comparison = syntheticNewFile(decoded.text)
    if (countRenderedLines(comparison.hunks) > DIFF_MAX_LINES) {
      return json({ kind: 'oversized', path: rel })
    }
    return json({
      kind: 'text',
      path: rel,
      before: comparison.before,
      after: comparison.after,
      hunks: comparison.hunks,
    })
  }

  /** Handle `GET /api/vcs.diff`. */
  async function diff(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)

    const scope = query.get('scope') ?? 'unstaged'
    if (!SCOPES.has(scope)) throw badRequest('scope is unstaged, staged, untracked, or commit.')
    const rel = validateRelPath(query.get('path'))
    if (rel === undefined) throw badRequest('path must be a repository-relative file path.')
    const rawOldPath = query.get('oldPath')
    const oldPath = rawOldPath === null ? undefined : validateRelPath(rawOldPath)
    if (rawOldPath !== null && oldPath === undefined) {
      throw badRequest('oldPath must be a repository-relative file path.')
    }

    const target = await contain(repo.root, rel, request.signal)
    if (scope === 'untracked') return untrackedDiff(rel, target, request.signal)
    if (oldPath !== undefined) await contain(repo.root, oldPath, request.signal)
    // A rename is only detected when both sides are named; one path reads as a
    // brand-new or deleted file instead.
    const paths = oldPath === undefined || oldPath === rel ? [rel] : [oldPath, rel]

    let range
    if (scope === 'commit') {
      const resolved = await resolveDiffCommit(query, repo, request.signal)
      range = { from: resolved.from, to: resolved.to }
    }

    const current = await ctx.fs.stat(target, request.signal).catch(() => undefined)
    if (range === undefined && current?.type === 'directory') {
      throw badRequest('That path is a directory, not a file.')
    }

    const args = ['--no-pager', 'diff', '--no-ext-diff', '--no-color', '-U3']
    if (scope === 'staged') args.push('--cached')
    if (range !== undefined) args.push(range.from, range.to)
    args.push('--', ...paths.map(literalPathspec))
    const output = await git.run(args, {
      cwd: repo.root,
      signal: request.signal,
      maxBytes: DIFF_MAX_BYTES + 1,
    })
    if (output.lossy || Buffer.byteLength(output.stdout, 'utf8') > DIFF_MAX_BYTES) {
      return json({ kind: 'oversized', path: rel })
    }
    if (output.exitCode !== 0) {
      throw new VcsError('internal', 'The comparison could not be read.')
    }
    if (fileHeaderCount(output.stdout) > 1) {
      throw badRequest('The path matches more than one file.')
    }
    if (isBinaryDiff(output.stdout)) return json({ kind: 'binary', path: rel })

    const comparison = parseUnifiedDiff(output.stdout)
    if (comparison.hunks.length === 0) {
      if (await binaryFromNumstat(repo.root, scope, range, paths, rel, request.signal)) {
        return json({ kind: 'binary', path: rel })
      }
      if (range !== undefined) {
        const type = await commitPathType(repo.root, range.to, rel, request.signal)
        refuseDirectory(type)
        if (type !== 'blob') throw notFound('That file is not part of the commit.')
      } else if (scope === 'staged') {
        if (!(await trackedInIndex(repo.root, rel, request.signal))) {
          throw notFound('That file is not staged.')
        }
      } else {
        const fresh = await ctx.fs.stat(target, request.signal).catch(() => undefined)
        if (fresh === undefined) throw notFound('That file is not present.')
        if (fresh.type === 'directory') throw badRequest('That path is a directory, not a file.')
      }
    }
    if (countRenderedLines(comparison.hunks) > DIFF_MAX_LINES) {
      return json({ kind: 'oversized', path: rel })
    }
    return json({
      kind: 'text',
      path: rel,
      before: comparison.before,
      after: comparison.after,
      hunks: comparison.hunks,
    })
  }

  /** Handle `GET /api/vcs.log`. */
  async function log(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)

    const ref = query.get('ref') ?? 'HEAD'
    if (ref !== 'HEAD' && ref !== 'all') throw badRequest('ref is HEAD or all.')
    const limitValue = readInteger(query.get('limit'), LOG_PAGE_MAX)
    const skipValue = readInteger(query.get('skip'), 0)
    if (limitValue === undefined) throw badRequest('limit must be an integer.')
    if (skipValue === undefined) throw badRequest('skip must be an integer.')
    const limit = clamp(limitValue, 1, LOG_PAGE_MAX)
    const skip = clamp(skipValue, 0, LOG_SKIP_MAX)

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
    const result = await git.run(args, { cwd: repo.root, signal: request.signal })
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) {
      // An unborn branch has no HEAD to walk; that is an empty history, not a
      // failure. Every other complaint is a real read failure.
      if (ref === 'HEAD' && /unknown revision|does not have any commits|bad revision|ambiguous argument/iu.test(result.stderr)) {
        return json({ commits: [], truncated: false, nextSkip: null })
      }
      throw new VcsError('internal', 'The history could not be read.')
    }

    const commits = parseLog(result.stdout)
    const truncated = skip + commits.length >= LOG_SKIP_MAX
    return json({
      commits,
      truncated,
      nextSkip: commits.length === 0 ? null : skip + commits.length,
    })
  }

  /** Handle `GET /api/vcs.commit`. */
  async function commit(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)

    const sha = validateSha(query.get('sha'))
    if (sha === undefined) throw badRequest('sha must be a hexadecimal commit id.')
    const resolved = await git.run(['rev-parse', '--verify', `${sha}^{commit}`], {
      cwd: repo.root,
      signal: request.signal,
    })
    if (resolved.exitCode !== 0 || resolved.lossy) throw notFound('That commit is not available.')
    const full = resolved.stdout.trim()
    if (!isFullSha(full)) throw notFound('That commit is not available.')

    const metadataResult = await git.run(
      ['--no-pager', 'show', '-s', '--no-color', `--format=${COMMIT_FORMAT}`, full],
      { cwd: repo.root, signal: request.signal },
    )
    if (metadataResult.lossy) throw outputTooLarge()
    if (metadataResult.exitCode !== 0) {
      throw new VcsError('internal', 'The commit metadata could not be read.')
    }
    const metadata = parseCommitMetadata(metadataResult.stdout)
    if (metadata === undefined) {
      throw new VcsError('internal', 'The commit metadata could not be read.')
    }

    const refsResult = await git.run(
      ['for-each-ref', '--format=%(refname)', `--points-at=${full}`],
      { cwd: repo.root, signal: request.signal },
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
      git.run([...base, '--name-status', ...tree], { cwd: repo.root, signal: request.signal }),
      git.run([...base, '--numstat', ...tree], { cwd: repo.root, signal: request.signal }),
    ])
    if (names.lossy || counts.lossy) throw outputTooLarge()
    if (names.exitCode !== 0 || counts.exitCode !== 0) {
      throw new VcsError('internal', 'The commit files could not be read.')
    }

    const files = mergeCommitFiles(parseNameStatusZ(names.stdout), parseNumstat(counts.stdout))
    const truncated = files.length > COMMIT_FILE_MAX
    return json({
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
    })
  }

  /**
   * Turn a thrown route failure into its JSON answer, except for a cancelled
   * request, which keeps its abort so the transport can drop it.
   * @param {Function} handler - the route implementation.
   * @returns {(request: Request) => Promise<Response>} the guarded handler.
   */
  function wrap(handler) {
    return async function route(request) {
      try {
        return await handler(request)
      } catch (error) {
        if (request.signal?.aborted) throw error
        if (error instanceof VcsError) return errorResponse(error)
        try {
          ctx.logger?.warn?.(
            `dsh-vcs-panel: ${error instanceof Error ? error.message : String(error)}`,
          )
        } catch {
          // A broken logger must not replace the answer.
        }
        return errorResponse(error)
      }
    }
  }

  return {
    repositories: wrap(repositories),
    status: wrap(status),
    untracked: wrap(untracked),
    diff: wrap(diff),
    log: wrap(log),
    commit: wrap(commit),
  }
}
