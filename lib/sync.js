/**
 * Git branch sync: the write behind the header's Sync button.
 *
 * Sync brings the checked-out branch level with its configured upstream
 * without creating, merging, or rewriting commits: it fetches the upstream
 * remote, then either fast-forwards the branch or pushes it. A branch that has
 * diverged from its upstream is left alone, and nothing is ever forced, so a
 * failed or refused sync leaves the repository as it was or simply further
 * along the same line.
 *
 * Every argv is fixed strings plus values read back from git itself (branch
 * name, remote, merge ref), each checked before it reaches a later command.
 */

import { REMOTE_TIMEOUT_MS } from './command.js'
import { badRequest, VcsError } from './errors.js'
import { configValue, MERGE_REF, redactDetail, UNSAFE_NAME } from './git-utils.js'

/**
 * The checked-out branch and the upstream it tracks, from git's own config.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ branch: string, remote: string, merge: string }>} the tracking pair.
 * @throws {VcsError} `no-upstream` for a detached HEAD or an untracked branch.
 */
async function trackingBranch(git, root, signal) {
  const symbolic = await git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal })
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : ''
  if (branch === '') throw new VcsError('no-upstream', 'Sync needs a checked-out branch.')

  const verified = await git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: root, signal })
  if (verified.exitCode !== 0) throw badRequest('The branch has no commits to sync.')

  const remote = await configValue(git, root, `branch.${branch}.remote`, signal)
  const merge = await configValue(git, root, `branch.${branch}.merge`, signal)
  if (remote === null || merge === null) {
    throw new VcsError('no-upstream', 'This branch has no upstream to sync with.')
  }
  if (UNSAFE_NAME.test(remote) || !MERGE_REF.test(merge)) {
    throw new VcsError('no-upstream', 'This branch has an upstream sync cannot use.')
  }
  return { branch, remote, merge }
}

/**
 * Commits on each side of `HEAD...@{upstream}`.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ upstream: string, ahead: number, behind: number }>} the upstream name and counts.
 */
async function divergence(git, root, signal) {
  const named = await git.run(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd: root, signal },
  )
  if (named.exitCode !== 0) {
    throw new VcsError('no-upstream', 'The upstream branch is not available on the remote.')
  }
  const upstream = named.stdout.trim()

  const counted = await git.run(
    ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
    { cwd: root, signal },
  )
  const match = counted.exitCode === 0 ? /^(\d+)\s+(\d+)\s*$/u.exec(counted.stdout) : null
  if (match === null) throw new VcsError('internal', 'The branch could not be compared with its upstream.')
  return { upstream, ahead: Number(match[1]), behind: Number(match[2]) }
}

/**
 * Sync the checked-out branch with its upstream.
 *
 * Order: fetch the upstream remote, compare, then exactly one of
 * fast-forward (behind only), push (ahead only), or nothing (level).
 *
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation; the Host lifetime, not the browser request.
 * @returns {Promise<{ upstream: string, pulled: number, pushed: number }>} what moved.
 */
export async function syncGitBranch(git, root, signal) {
  const { branch, remote, merge } = await trackingBranch(git, root, signal)

  // A branch tracking another local branch (`remote = .`) has nothing to fetch.
  if (remote !== '.') {
    const fetched = await git.run(['fetch', '--quiet', remote], {
      cwd: root,
      signal,
      timeoutMs: REMOTE_TIMEOUT_MS,
    })
    if (fetched.exitCode !== 0) {
      throw new VcsError(
        'remote-failed',
        'The remote could not be fetched.',
        redactDetail(fetched.stderr),
      )
    }
  }

  const { upstream, ahead, behind } = await divergence(git, root, signal)
  if (ahead > 0 && behind > 0) {
    throw new VcsError('diverged', 'The branch and its upstream have diverged.')
  }

  if (behind > 0) {
    const merged = await git.run(['merge', '--ff-only', '--quiet', '@{upstream}'], {
      cwd: root,
      signal,
    })
    if (merged.exitCode !== 0) {
      throw new VcsError(
        'pull-blocked',
        'The branch could not be fast-forwarded.',
        redactDetail(merged.stderr),
      )
    }
    return { upstream, pulled: behind, pushed: 0 }
  }

  if (ahead > 0) {
    const pushed = await git.run(
      ['push', '--porcelain', remote, `refs/heads/${branch}:${merge}`],
      { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS },
    )
    if (pushed.exitCode !== 0) {
      // Sync fetched first and found the branch strictly ahead, so a refusal
      // here is the remote or one of its hooks declining, a race with another
      // pusher, or the transport failing; none of them changed local state.
      // `--porcelain` marks the refused ref with `!` and its reason.
      const refused = pushed.stdout.split('\n').find(line => line.startsWith('!')) ?? ''
      throw new VcsError(
        'remote-failed',
        'The remote did not accept the push.',
        redactDetail(`${pushed.stderr}\n${refused}`),
      )
    }
    return { upstream, pulled: 0, pushed: ahead }
  }

  return { upstream, pulled: 0, pushed: 0 }
}
