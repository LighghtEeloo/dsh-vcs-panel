/**
 * Git tag operations: delete one local tag and push one tag to a remote.
 *
 * These are the writes behind the tag actions menu. Deleting removes only the
 * local ref; a tag already pushed stays on its remote. Pushing sends exactly
 * the named tag to a remote this repository lists, without `--force`, so a
 * remote tag that has moved is refused rather than overwritten. argv is fixed
 * strings plus values already checked by the route and by this module; no
 * value is ever read from a shell.
 */

import { REMOTE_TIMEOUT_MS } from './command.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import { redactDetail, UNSAFE_NAME } from './git-utils.js'

/** Most remotes a tag push dialog lists. */
export const REMOTE_MAX = 500

/** A remote name safe as a positional argument and readable in the dialog. */
const SAFE_REMOTE = /^[^\u0000-\u0020\u007f]+$/u

/**
 * Check that one local tag exists before a write names it.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} tag - the tag name.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
async function requireGitTag(git, root, tag, signal) {
  // `check-ref-format` rejects revision syntax (`@{…}`, `..`) that `git tag`
  // would otherwise expand, keeping the write on one exact ref.
  const checked = await git.run(['check-ref-format', `refs/tags/${tag}`], { cwd: root, signal })
  if (checked.exitCode !== 0) {
    throw badRequest('That is not a valid tag name.')
  }
  const exists = await git.run(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: root, signal })
  if (exists.lossy) throw outputTooLarge()
  if (exists.exitCode !== 0) {
    throw new VcsError('tag-missing', 'That tag no longer exists.')
  }
}

/**
 * List the remotes this repository has configured.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ remotes: string[], truncated: boolean }>} the listing.
 */
export async function listGitRemotes(git, root, signal) {
  const result = await git.run(['remote'], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) {
    throw new VcsError('tag-failed', 'The remotes could not be read.', redactDetail(result.stderr))
  }
  const remotes = result.stdout.split('\n')
    .map(name => name.trim())
    .filter(name => name !== '' && SAFE_REMOTE.test(name) && !UNSAFE_NAME.test(name))
  const truncated = remotes.length > REMOTE_MAX
  return { remotes: truncated ? remotes.slice(0, REMOTE_MAX) : remotes, truncated }
}

/**
 * Delete one local tag. A tag on a remote is untouched.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} tag - an existing tag, checked here.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ tag: string }>} the deleted tag.
 */
export async function deleteGitTag(git, root, tag, signal) {
  await requireGitTag(git, root, tag, signal)
  const result = await git.run(['tag', '--delete', tag], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw new VcsError('tag-failed', 'The tag could not be deleted.', redactDetail(result.stderr))
  }
  return { tag }
}

/**
 * Push one local tag to a remote, without force.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} tag - an existing tag, checked here.
 * @param {string} remote - one of the repository's remotes, checked here.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ tag: string, remote: string, pushed: boolean }>} where it went.
 */
export async function pushGitTag(git, root, tag, remote, signal) {
  await requireGitTag(git, root, tag, signal)
  const listed = await listGitRemotes(git, root, signal)
  if (!listed.remotes.includes(remote)) {
    throw new VcsError('remote-missing', 'That remote is not available.')
  }

  const result = await git.run(
    ['push', '--porcelain', remote, `refs/tags/${tag}:refs/tags/${tag}`],
    { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    const refused = result.stdout.split('\n').find(line => line.startsWith('!')) ?? ''
    throw new VcsError(
      'tag-push-failed',
      'The remote did not accept the tag.',
      redactDetail(`${result.stderr}\n${refused}`),
    )
  }
  // Porcelain starts with a `To <remote>` header and ends with `Done`; the
  // ref lines between them start with a flag, '=' meaning already up to date.
  const output = result.stdout.split('\n')
    .filter(line => line !== '' && line !== 'Done' && !line.startsWith('To '))
  return {
    tag,
    remote,
    pushed: output.some(line => !line.startsWith('=')),
  }
}
