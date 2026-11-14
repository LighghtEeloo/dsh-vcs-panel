/**
 * The one place backend commands are started.
 *
 * argv is always built by the caller from fixed strings plus validated values,
 * never through a shell; the environment is scrubbed so a repository's own
 * configuration cannot redirect output, open an editor, or take a lock; and
 * every command has a deadline and a bound on captured stdout.
 */

import { abortError, outputTooLarge, timeoutError, VcsError } from './errors.js'

/** Milliseconds one backend command may run before the request is abandoned. */
export const TIMEOUT_MS = 30_000
/** Ceiling on one command's captured stdout. */
export const OUTPUT_MAX_BYTES = 8 * 1024 * 1024
/** Retained stderr tail; enough for diagnostics, never forwarded verbatim. */
export const STDERR_TAIL_BYTES = 16 * 1024
/** How long a terminated child gets to exit before being killed. */
export const TERMINATE_GRACE_MS = 2_000

/**
 * Run one external command to completion inside one directory.
 *
 * `run` reports the exit code and both output streams; it throws only when the
 * command could not be run or observed at all. Callers decide whether a
 * nonzero exit is a legitimate answer (an empty repository, for example).
 */
export class CommandRunner {
  #executable
  #command
  #prefixArgs
  #env

  /**
   * @param {object} ctx - Host context carrying the subprocess capability.
   * @param {{ command: string, args?: string[], env?: Record<string, string> }} options - executable and fixed prefix.
   */
  constructor(ctx, { command, args = [], env = {} }) {
    this.ctx = ctx
    this.#command = command
    this.#prefixArgs = args
    this.#env = env
  }

  /** The resolved executable, or null when this host does not have it. */
  get executable() {
    return this.#executable ?? null
  }

  /**
   * Locate the executable once; a host without it is remembered as such.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string | null>} the executable path, or null.
   */
  async resolve(signal) {
    if (this.#executable !== undefined) return this.#executable
    try {
      this.#executable = await this.ctx.subprocess.resolveExecutable(this.#command, undefined, signal)
    } catch {
      this.#executable = null
    }
    return this.#executable
  }

  /**
   * Run one command.
   *
   * stdin is either ignored or fed a complete string; stdout and stderr are
   * collected, with stdout capped at `options.maxBytes` (8 MB by default).
   * A capped stdout is reported through `lossy` instead of being silently
   * shortened, so a caller can answer with a stable "oversized" state.
   *
   * @param {string[]} args - command arguments, already option-safe.
   * @param {object} options - run options.
   * @param {string} options.cwd - directory to run in.
   * @param {AbortSignal} [options.signal] - request cancellation.
   * @param {string} [options.stdin] - complete standard input.
   * @param {number} [options.maxBytes] - stdout cap.
   * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, lossy: boolean }>}
   * @throws {VcsError} on timeout, cancellation, overflow, or spawn failure.
   */
  async run(args, options) {
    if (options.signal?.aborted) throw abortError()
    const executable = this.#executable ?? await this.resolve(options.signal)
    if (executable === null) {
      throw new VcsError('vcs-missing', `${this.#command} is not available on this host.`)
    }

    const deadline = AbortSignal.timeout(TIMEOUT_MS)
    const signal = options.signal === undefined
      ? deadline
      : AbortSignal.any([options.signal, deadline])

    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [executable, ...this.#prefixArgs, ...args],
        cwd: options.cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
          stdout: { maxBytes: options.maxBytes ?? OUTPUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal,
        // A backend's environment is scrubbed so a repository's own config
        // cannot redirect output, prompt, or take a lock. Each backend states
        // exactly what its commands may inherit.
        env: {
          LC_ALL: 'C',
          ...this.#env,
          ...options.env,
        },
      })
    } catch {
      if (deadline.aborted) throw timeoutError()
      if (options.signal?.aborted) throw abortError()
      throw new VcsError('internal', `The ${this.#command} command could not be started.`)
    }

    let outcome
    try {
      outcome = await handle.done
    } catch {
      if (deadline.aborted) throw timeoutError()
      if (options.signal?.aborted) throw abortError()
      throw new VcsError('internal', `The ${this.#command} command could not be completed.`)
    }

    // A request abort is the browser leaving; it must not become a JSON error.
    if (options.signal?.aborted) throw abortError()
    if (deadline.aborted) throw timeoutError()

    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, lossy: stdout.lossy === true }
  }

  /**
   * Run one command that must succeed and stay inside the output cap.
   * @param {string[]} args - command arguments.
   * @param {object} options - as {@link CommandRunner.run}.
   * @returns {Promise<{ stdout: string, stderr: string }>} its output.
   * @throws {VcsError} when the command fails or the output overflowed.
   */
  async ok(args, options) {
    const result = await this.run(args, options)
    if (result.exitCode !== 0) {
      throw new VcsError('internal', `The ${this.#command} command did not complete.`)
    }
    if (result.lossy) throw outputTooLarge()
    return result
  }
}
