/**
 * Repository discovery for one session working directory.
 *
 * The answer is also the allowlist every other route checks its `repo` query
 * against, so the paths come back canonical: comparing these strings is what
 * stops a request from naming a directory discovery never offered.
 */

import { join } from 'node:path'

import { VcsError } from './errors.js'
import { repositoryName } from './paths.js'

/** Most repositories one session is offered. */
export const REPOSITORY_MAX = 50

/** Directories that are never worth one lstat each during discovery. */
const REPOSITORY_SCAN_IGNORED = new Set(['node_modules'])

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
 * Every repository this session may point at: the one enclosing the working
 * directory first, then the working directory's direct children that carry a
 * `.git` entry.
 *
 * One level only, so a repository buried deeper stays out until something asks
 * for it. A `.git` symlink is found without being read through, and a child
 * whose canonical path leaves the working directory is refused, so a symlinked
 * directory cannot widen the allowlist.
 *
 * @param {object} ctx - plugin context with the filesystem capability.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} cwd - absolute session working directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ repositories: { path: string, name: string, enclosing: boolean }[], cwd: string, truncated: boolean }>}
 * @throws {VcsError} when the session working directory cannot be resolved.
 */
export async function discoverRepositories(ctx, git, cwd, signal) {
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
   */
  const add = (path, enclosing) => {
    if (path === undefined || seen.has(path)) return
    seen.add(path)
    repositories.push({ path, name: repositoryName(path), enclosing })
  }

  // Walking up is the only git call discovery needs: the enclosing repository
  // may be an ancestor, not the working directory itself.
  const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: canonicalCwd, signal })
  if (top.exitCode === 0 && top.stdout.trim() !== '') {
    add(await canonicalPath(ctx, top.stdout.trim(), signal), true)
  }

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

    let marker
    try {
      // lstat does not follow the final component, so a `.git` symlink or a
      // gitfile (worktree, submodule) is found without being read through.
      marker = await ctx.fs.lstat(join(entry.target.displayPath, '.git'), {}, signal)
    } catch {
      marker = undefined
    }
    if (marker === undefined) continue
    if (!ctx.fs.contains(cwdTarget, entry.target)) continue

    const path = ctx.fs.processPath(entry.target)
    if (seen.has(path)) continue
    if (repositories.length >= REPOSITORY_MAX) {
      truncated = true
      break
    }
    add(path, false)
  }

  return { repositories, cwd: canonicalCwd, truncated }
}
