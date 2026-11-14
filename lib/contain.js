/**
 * Filesystem containment for one repository-relative path.
 *
 * Every path that reaches the filesystem is resolved after symlinks and must
 * stay inside the canonical repository root. A backend that reads a path from
 * history (a deleted file, a commit's tree) does not call this: history paths
 * never touch the current working tree.
 */

import { join } from 'node:path'

import { badRequest, VcsError } from './errors.js'

/**
 * Resolve one repository-relative path, requiring its canonical target to sit
 * inside the canonical repository root.
 * @param {object} ctx - plugin context with the filesystem capability.
 * @param {string} root - canonical repository root.
 * @param {string} rel - validated repository-relative path.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<object>} the resolved target.
 */
export async function containPath(ctx, root, rel, signal) {
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
