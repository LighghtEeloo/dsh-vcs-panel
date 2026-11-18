/**
 * Helpers shared by Git's write operations.
 *
 * A remote or ref value reaches a later argv, so it is checked here once:
 * options, control characters, and refs outside `refs/heads/` are refused.
 * `redactDetail` keeps credentials out of the Host log.
 */

import { REMOTE_TIMEOUT_MS } from './command.js'
import { outputTooLarge, VcsError } from './errors.js'

/** Names that would read as an option or carry control characters are refused. */
export const UNSAFE_NAME = /^-|[\u0000-\u001f\u007f]/u

/** An upstream ref a push may target. */
export const MERGE_REF = /^refs\/heads\/[^\u0000-\u001f\u007f]+$/u

/** Most remotes a listing exposes. */
export const REMOTE_MAX = 500

/** A remote name safe as a positional argument and readable in the dialog. */
const SAFE_REMOTE = /^[^\u0000-\u0020\u007f]+$/u

/** The newest stderr lines kept for the Host log. */
const DETAIL_LINES = 3

/**
 * Reduce a failed command's stderr to a short diagnostic safe for the Host
 * log: the last few lines, with any URL credentials removed.
 * @param {string} stderr - the captured stderr tail.
 * @returns {string} the diagnostic.
 */
export function redactDetail(stderr) {
  return stderr
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-DETAIL_LINES)
    .join(' | ')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1***@')
}

/**
 * Read safe configured remote names in git's own order.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @param {{ errorCode?: string, errorMessage?: string }} [options] - failure mapping.
 * @returns {Promise<string[]>} safe remote names.
 */
async function readSafeRemotes(
  git,
  root,
  signal,
  { errorCode = 'internal', errorMessage = 'The remotes could not be read.' } = {},
) {
  const result = await git.run(['remote'], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) {
    throw new VcsError(errorCode, errorMessage, redactDetail(result.stderr))
  }
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(name => name !== '' && SAFE_REMOTE.test(name) && !UNSAFE_NAME.test(name))
}

/**
 * List the remotes this repository has configured, capped at {@link REMOTE_MAX}.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ remotes: string[], truncated: boolean }>} the listing.
 */
export async function listGitRemotes(git, root, signal) {
  const remotes = await readSafeRemotes(git, root, signal, { errorCode: 'tag-failed' })
  const truncated = remotes.length > REMOTE_MAX
  return { remotes: truncated ? remotes.slice(0, REMOTE_MAX) : remotes, truncated }
}

/**
 * Configured remote names, longest first so `origin/feature` wins over an
 * `origin` remote when a remote-tracking ref is split.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string[]>} safe remote names.
 */
export async function remoteNames(git, root, signal) {
  const remotes = await readSafeRemotes(git, root, signal)
  return remotes.sort((first, second) => second.length - first.length)
}

/**
 * Read one git config value.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} key - config key.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string | null>} the value, or null when unset.
 */
export async function configValue(git, root, key, signal) {
  const result = await git.run(['config', '--get', key], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) return null
  const value = result.stdout.trim()
  return value === '' ? null : value
}

/**
 * Read and validate one local branch's configured upstream remote and merge ref.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {string} branch - local branch name.
 * @param {AbortSignal} signal - cancellation.
 * @param {{ allowLocal?: boolean, missingMessage?: string, invalidMessage?: string }} [options] - validation options.
 * @returns {Promise<{ remote: string, merge: string }>} the validated upstream config.
 */
export async function readBranchUpstream(
  git,
  root,
  branch,
  signal,
  {
    allowLocal = false,
    missingMessage = 'This branch has no upstream to sync with.',
    invalidMessage = missingMessage,
  } = {},
) {
  const [remote, merge] = await Promise.all([
    configValue(git, root, `branch.${branch}.remote`, signal),
    configValue(git, root, `branch.${branch}.merge`, signal),
  ])
  if (remote === null || merge === null || (!allowLocal && remote === '.')) {
    throw new VcsError('no-upstream', missingMessage)
  }
  if (UNSAFE_NAME.test(remote) || !MERGE_REF.test(merge)) {
    throw new VcsError('no-upstream', invalidMessage)
  }
  return { remote, merge }
}

/**
 * Run `git push --porcelain` with a remote timeout and structured error/result parsing.
 * @param {import('./git.js').GitRunner} git - command runner.
 * @param {string} root - repository root.
 * @param {{ remote: string, args: string[], errorCode?: string, errorMessage?: string }} target - push destination and refspecs.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ pushed: boolean }>} whether any ref changed on the remote.
 */
export async function runPorcelainPush(
  git,
  root,
  {
    remote,
    args,
    errorCode = 'remote-failed',
    errorMessage = 'The remote did not accept the push.',
  },
  signal,
) {
  const result = await git.run(
    ['push', '--porcelain', remote, ...args],
    { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    // `--porcelain` marks the refused ref with `!` and its reason.
    const refused = result.stdout.split('\n').find(line => line.startsWith('!')) ?? ''
    throw new VcsError(errorCode, errorMessage, redactDetail(`${result.stderr}\n${refused}`))
  }
  // Porcelain starts with a `To <remote>` header and ends with `Done`; the
  // ref lines between them start with a flag, '=' meaning already up to date.
  const output = result.stdout.split('\n')
    .filter(line => line !== '' && line !== 'Done' && !line.startsWith('To '))
  return { pushed: output.some(line => !line.startsWith('=')) }
}
