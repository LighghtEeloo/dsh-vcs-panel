/**
 * Helpers shared by Git's write operations.
 *
 * A remote or ref value reaches a later argv, so it is checked here once:
 * options, control characters, and refs outside `refs/heads/` are refused.
 * `redactDetail` keeps credentials out of the Host log.
 */

import { outputTooLarge } from './errors.js'

/** Names that would read as an option or carry control characters are refused. */
export const UNSAFE_NAME = /^-|[\u0000-\u001f\u007f]/u

/** An upstream ref a push may target. */
export const MERGE_REF = /^refs\/heads\/[^\u0000-\u001f\u007f]+$/u

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
