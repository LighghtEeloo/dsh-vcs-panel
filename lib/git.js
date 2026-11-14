/**
 * Git process configuration.
 *
 * The generic runner in `command.js` owns deadlines, output caps, and abort
 * handling; this module only states what makes a Git invocation safe and
 * deterministic.
 */

import { CommandRunner } from './command.js'

/**
 * Run `git <args>` with fixed safety flags.
 *
 * `GIT_CONFIG_COUNT=0` clears ambient config overrides, no optional lock is
 * taken, and no prompt is possible. Repository-local config is still read, as
 * git itself does; `--no-ext-diff` is added by each comparison call site.
 */
export class GitRunner extends CommandRunner {
  /**
   * @param {object} ctx - Host context carrying the subprocess capability.
   */
  constructor(ctx) {
    super(ctx, {
      command: 'git',
      args: ['-c', 'core.quotepath=false'],
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    })
  }
}
