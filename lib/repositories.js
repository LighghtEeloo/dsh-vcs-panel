/**
 * Repository discovery for one session working directory.
 *
 * The answer is also the allowlist every other route checks its `repo` query
 * against, so the paths come back canonical: comparing these strings is what
 * stops a request from naming a directory discovery never offered.
 *
 * A repository is a directory carrying one of the registered markers. The
 * marker is checked with `lstat`, so a `.git` file (a linked worktree or a
 * submodule) and a `.jj` workspace are found without being read through.
 */

import { dirname, join } from 'node:path'

import { VcsError } from './errors.js'
import { repositoryName } from './paths.js'
import { VCS_MARKERS } from './vcs/index.js'

/** Most repositories one session is offered. */
export const REPOSITORY_MAX = 50

/** Directories that are never worth one lstat each during discovery. */
const REPOSITORY_SCAN_IGNORED = new Set(['node_modules'])

/** How far the upward marker walk may go before giving up. */
const ENCLOSING_MAX_DEPTH = 64

/**
 * Canonicalize a path through the filesystem capability.
 * @param {object} ctx - plugin context.
 * @param {string} path - absolute path.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string | undefined>} the real path, or undefined.
 */
async function canonicalPath(ctx, path, signal) {
  try {
    const target = await ctx.fs.resolve(path, { signal })
    return ctx.fs.processPath(target)
  } catch {
    return undefined
  }
}

/**
 * Which registered backend marks this directory as a repository root.
 * @param {object} ctx - plugin context.
 * @param {string} directory - absolute directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string | undefined>} the backend id, if any.
 */
async function markerAt(ctx, directory, signal) {
  for (const marker of VCS_MARKERS) {
    try {
      // lstat does not follow the final component, so a `.git` symlink or a
      // gitfile (worktree, submodule) is found without being read through.
      const found = await ctx.fs.lstat(join(directory, marker.marker), {}, signal)
      if (found !== undefined && found !== null) return marker.vcs
    } catch {
      // Try the next marker.
    }
  }
  return undefined
}

/**
 * The nearest enclosing repository root, walking up from the working directory.
 * @param {object} ctx - plugin context.
 * @param {string} canonicalCwd - canonical working directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ path: string, vcs: string } | undefined>} the root and backend.
 */
async function enclosingRepository(ctx, canonicalCwd, signal) {
  let directory = canonicalCwd
  for (let depth = 0; depth < ENCLOSING_MAX_DEPTH; depth += 1) {
    const vcs = await markerAt(ctx, directory, signal)
    if (vcs !== undefined) {
      const path = await canonicalPath(ctx, directory, signal)
      return path === undefined ? undefined : { path, vcs }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Locate the nearest repository enclosing a working directory, without scanning
 * child directories. Returns `null` when the directory is outside any
 * repository or cannot be resolved.
 *
 * @param {object} ctx - plugin context with the filesystem capability.
 * @param {string} cwd - absolute session working directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ path: string, vcs: string } | null>} the enclosing root and backend, or null.
 */
export async function findEnclosingRepository(ctx, cwd, signal) {
  const cwdTarget = await ctx.fs.resolve(cwd, { signal }).catch(() => undefined)
  if (cwdTarget === undefined) return null
  const canonicalCwd = ctx.fs.processPath(cwdTarget)
  return (await enclosingRepository(ctx, canonicalCwd, signal)) ?? null
}

/**
 * Every repository this session may point at: the one enclosing the working
 * directory first, then the working directory's direct children that carry a
 * marker.
 *
 * One level only, so a repository buried deeper stays out until something asks
 * for it. A child whose canonical path leaves the working directory is refused,
 * so a symlinked directory cannot widen the allowlist.
 *
 * @param {object} ctx - plugin context with the filesystem capability.
 * @param {string} cwd - absolute session working directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ repositories: { path: string, name: string, enclosing: boolean, vcs: string }[], cwd: string, truncated: boolean }>}
 * @throws {VcsError} when the session working directory cannot be resolved.
 */
export async function discoverRepositories(ctx, cwd, signal) {
  const cwdTarget = await ctx.fs.resolve(cwd, { signal }).catch(() => undefined)
  if (cwdTarget === undefined) {
    throw new VcsError('no-cwd', 'The session working directory is not available.')
  }
  const canonicalCwd = ctx.fs.processPath(cwdTarget)

  const repositories = []
  const seen = new Set()

  /**
   * @param {string | undefined} path - canonical root.
   * @param {boolean} enclosing - whether this is the working directory's own repository.
   * @param {string} vcs - the backend that owns the root.
   */
  const add = (path, enclosing, vcs) => {
    if (path === undefined || seen.has(path)) return
    seen.add(path)
    repositories.push({ path, name: repositoryName(path), enclosing, vcs })
  }

  const enclosing = await enclosingRepository(ctx, canonicalCwd, signal)
  if (enclosing !== undefined) add(enclosing.path, true, enclosing.vcs)

  let entries
  try {
    entries = await ctx.fs.listDir(cwdTarget, signal)
  } catch {
    // A listing that failed is an empty child scan, not an error: the enclosing
    // repository is still a valid answer.
    return { repositories, cwd: canonicalCwd, truncated: false }
  }

  let truncated = false
  for (const entry of entries) {
    if (entry.type !== 'directory' || REPOSITORY_SCAN_IGNORED.has(entry.name)) continue
    if (!ctx.fs.contains(cwdTarget, entry.target)) continue

    const vcs = await markerAt(ctx, entry.target.displayPath, signal)
    if (vcs === undefined) continue

    const path = ctx.fs.processPath(entry.target)
    if (seen.has(path)) continue
    if (repositories.length >= REPOSITORY_MAX) {
      truncated = true
      break
    }
    add(path, false, vcs)
  }

  return { repositories, cwd: canonicalCwd, truncated }
}
