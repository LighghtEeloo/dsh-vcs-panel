/** Git's registered working trees, with stale or foreign directories excluded. */

import { isAbsolute } from 'node:path'

import { canonicalDirectory } from './contain.js'
import { outputTooLarge } from './errors.js'
import { isFullSha, sameRepoPath } from './paths.js'

const BRANCH_PREFIX = 'branch refs/heads/'

/** Read complete NUL-delimited records without unquoting paths or reasons. */
export function* parseGitWorktrees(stdout) {
  const records = stdout.split('\0\0')
  records.pop() // The last split is outside a complete record.
  for (const record of records) {
    const [first, ...fields] = record.split('\0')
    if (!first.startsWith('worktree ')) continue
    const path = first.slice('worktree '.length)
    if (!isAbsolute(path) || fields.some(field => field === 'bare' || field === 'prunable' || field.startsWith('prunable '))) continue
    const branch = fields.find(field => field.startsWith(BRANCH_PREFIX))?.slice(BRANCH_PREFIX.length) || null
    const oid = fields.find(field => field.startsWith('HEAD '))?.slice(5)
    const head = isFullSha(oid) && !/^0+$/u.test(oid) ? oid : null
    yield { path, branch, head }
  }
}

/** Git must see this exact directory as a working tree, not a containing repo. */
export async function gitCommonDirAt(git, root, signal) {
  const result = await git.run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: root, signal })
  if (result.lossy || result.exitCode !== 0 || !result.stdout.endsWith('\n')) return null
  // Both paths may contain newlines. The known root tells us how many lines
  // its value occupies; everything after that separator is the common dir.
  const rootLines = root.split('\n').length
  const lines = result.stdout.slice(0, -1).split('\n')
  const topLevel = lines.slice(0, rootLines).join('\n')
  const commonDir = lines.slice(rootLines).join('\n')
  return isAbsolute(topLevel) && isAbsolute(commonDir) && sameRepoPath(topLevel, root) ? commonDir : null
}

/**
 * Yield the anchor first, then its live siblings. A listed path alone is not proof:
 * Git can keep listing a stale registration after another repo takes its place.
 * Resolve candidates from Git's list, never from the browser's requested path.
 */
export async function* discoverGitWorktrees(ctx, git, root, signal, { paths = null, commonDir = null } = {}) {
  const result = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) return

  const entries = [...parseGitWorktrees(result.stdout)]
  const anchor = entries.find(entry => sameRepoPath(entry.path, root))
  const matches = path => paths === null || paths.some(requested => sameRepoPath(path, requested))
  if (anchor !== undefined && matches(root)) yield { ...anchor, path: root }
  for (const entry of entries) {
    if (sameRepoPath(entry.path, root)) continue
    const path = await canonicalDirectory(ctx, entry.path, signal)
    if (path === null || !matches(path)) continue
    if (sameRepoPath(path, root)) {
      if (anchor === undefined) yield { ...entry, path: root }
      continue
    }

    commonDir ??= await gitCommonDirAt(git, root, signal)
    if (commonDir === null) return
    const candidateCommonDir = await gitCommonDirAt(git, path, signal)
    if (candidateCommonDir !== null && sameRepoPath(candidateCommonDir, commonDir)) yield { ...entry, path }
  }
}
