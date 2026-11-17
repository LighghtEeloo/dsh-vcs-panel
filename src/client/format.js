/**
 * Pure display helpers shared by the Changes and History panes.
 *
 * Git data arrives normalized (epoch milliseconds, repository-relative POSIX
 * paths, single-letter statuses); this module turns it into strings and tree
 * shapes without touching the DOM.
 */

/** Status letters the panel renders, in the order they are listed. */
const STATUS_KEYS = {
  M: 'status.modified',
  A: 'status.added',
  D: 'status.deleted',
  R: 'status.renamed',
  C: 'status.copied',
  U: 'status.conflict',
  '?': 'status.untracked',
}

/**
 * Translation key for one Git status letter.
 * @param {string} status - single-letter status.
 * @returns {string} locale key.
 */
export function statusKey(status) {
  return STATUS_KEYS[status] ?? 'status.changed'
}

/**
 * Split a path into its directory and base name.
 * @param {string} path - repository-relative path.
 * @returns {{ dir: string, base: string }} the two halves.
 */
export function splitPath(path) {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return { dir: '', base: path }
  return { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) }
}

/**
 * Shorten a commit id to Git's usual seven characters.
 * @param {string} sha - a commit id.
 * @returns {string} the short id.
 */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : ''
}

/**
 * Shorten a change id for a dense row; the detail shows the full short id.
 * @param {string} changeId - a change id.
 * @returns {string} the prefix.
 */
export function shortChangeId(changeId) {
  return typeof changeId === 'string' ? changeId.slice(0, 8) : ''
}

/**
 * Format a count with the active locale's digit grouping.
 * @param {number} value - the count.
 * @param {string} [locale] - BCP 47 locale; browser default when omitted.
 * @returns {string} the formatted number.
 */
export function formatCount(value, locale) {
  try {
    return new Intl.NumberFormat(locale).format(value)
  } catch {
    return String(value)
  }
}

/**
 * Format an instant as a date and a time.
 * @param {number} ms - epoch milliseconds.
 * @param {string} [locale] - BCP 47 locale; browser default when omitted.
 * @returns {string} the localized instant.
 */
export function formatDateTime(ms, locale) {
  if (!Number.isFinite(ms)) return ''
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
  } catch {
    try {
      return new Date(ms).toISOString()
    } catch {
      return ''
    }
  }
}

/** Pick a relative-time unit from an elapsed second count. */
function relativeUnit(seconds) {
  if (seconds < 60) return ['second', Math.max(1, Math.round(seconds))]
  if (seconds < 3600) return ['minute', Math.round(seconds / 60)]
  if (seconds < 86400) return ['hour', Math.round(seconds / 3600)]
  return ['day', Math.round(seconds / 86400)]
}

/**
 * Format a commit time the way a history list reads it: relative while recent,
 * absolute once it leaves the last week.
 * @param {number} ms - epoch milliseconds.
 * @param {number} [now] - current time, for tests.
 * @param {string} [locale] - BCP 47 locale.
 * @returns {string} the short, stable time text.
 */
export function formatCommitTime(ms, now = Date.now(), locale) {
  if (!Number.isFinite(ms)) return ''
  const seconds = Math.max(0, (now - ms) / 1000)
  if (seconds < 7 * 86400) {
    const [unit, value] = relativeUnit(seconds)
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(-value, unit)
    } catch {
      // Fall through to an absolute format when RelativeTimeFormat is unavailable.
    }
  }
  return formatDateTime(ms, locale)
}

/**
 * The number of changed lines a file row states, or nulls when unknown.
 * @param {{ added?: number, deleted?: number } | null} entry - one file entry.
 * @returns {{ added: number | null, deleted: number | null }} the counts.
 */
export function lineCounts(entry) {
  if (entry === null || entry === undefined) return { added: null, deleted: null }
  return {
    added: typeof entry.added === 'number' ? entry.added : null,
    deleted: typeof entry.deleted === 'number' ? entry.deleted : null,
  }
}

/** Stable Host error codes mapped to localized copy. */
const ERROR_KEYS = {
  'no-session': 'error.noSession',
  'no-cwd': 'error.noCwd',
  'not-a-repo': 'error.notARepo',
  'not-found': 'error.notFound',
  timeout: 'error.timeout',
  'output-too-large': 'error.outputTooLarge',
  network: 'error.network',
  'bad-request': 'error.badRequest',
  internal: 'error.internal',
  forbidden: 'error.forbidden',
  busy: 'error.busy',
  'no-upstream': 'error.noUpstream',
  diverged: 'error.diverged',
  'pull-blocked': 'error.pullBlocked',
  'remote-failed': 'error.remoteFailed',
  'switch-blocked': 'error.switchBlocked',
  'switch-failed': 'error.switchFailed',
  'branch-invalid': 'error.branchInvalid',
  'branch-exists': 'error.branchExists',
  'branch-unmerged': 'error.branchUnmerged',
  'branch-in-use': 'error.branchInUse',
  'merge-blocked': 'error.mergeBlocked',
  'rebase-blocked': 'error.rebaseBlocked',
  'branch-failed': 'error.branchFailed',
}

/**
 * Localized text for one API failure, falling back to the Host message.
 * @param {Function} t - the panel's translate function.
 * @param {{ code?: string, message?: string } | null} error - the failure.
 * @returns {string} browser-facing copy.
 */
export function errorMessage(t, error) {
  const key = ERROR_KEYS[error?.code]
  if (key !== undefined) return t(key)
  return error?.message ?? t('error.internal')
}

/**
 * Localized outcome of one sync: what moved, and to or from which upstream.
 * @param {Function} t - the panel's translate function.
 * @param {{ upstream?: string, pulled?: number, pushed?: number }} result - the sync answer.
 * @param {string} [locale] - BCP 47 locale for the count.
 * @returns {string} browser-facing copy.
 */
export function syncMessage(t, result, locale) {
  const upstream = typeof result?.upstream === 'string' ? result.upstream : ''
  const pushed = Number.isSafeInteger(result?.pushed) ? result.pushed : 0
  const pulled = Number.isSafeInteger(result?.pulled) ? result.pulled : 0
  if (pushed === 1) return t('sync.pushedOne', { upstream })
  if (pushed > 1) return t('sync.pushedMany', { upstream, count: formatCount(pushed, locale) })
  if (pulled === 1) return t('sync.pulledOne', { upstream })
  if (pulled > 1) return t('sync.pulledMany', { upstream, count: formatCount(pulled, locale) })
  return t('sync.level', { upstream })
}

/**
 * Localized outcome of one branch switch: the branch now checked out.
 * @param {Function} t - the panel's translate function.
 * @param {{ branch?: unknown } | null} result - the switch answer.
 * @param {string} requested - the branch the user picked, for a malformed answer.
 * @returns {string} browser-facing copy.
 */
export function switchMessage(t, result, requested) {
  const branch = typeof result?.branch === 'string' && result.branch !== '' ? result.branch : requested
  return t('switch.done', { branch })
}

/**
 * Localized outcome of one branch action: what changed and where.
 * @param {Function} t - the panel's translate function.
 * @param {'rename'|'delete'|'merge'|'rebase'|'push'} action - the action that ran.
 * @param {string} branch - the branch the user chose.
 * @param {object | null} result - the Host answer.
 * @returns {string} browser-facing copy.
 */
export function branchOpMessage(t, action, branch, result) {
  const current = typeof result?.current === 'string' && result.current !== '' ? result.current : branch
  if (action === 'rename') {
    const from = typeof result?.from === 'string' && result.from !== '' ? result.from : branch
    const to = typeof result?.branch === 'string' && result.branch !== '' ? result.branch : branch
    return t('branch.renamed', { from, branch: to })
  }
  if (action === 'delete') return t('branch.deleted', { branch })
  if (action === 'merge') {
    if (result?.result === 'fast-forward') return t('branch.fastForwarded', { current, branch })
    if (result?.result === 'up-to-date') return t('branch.upToDate', { current, branch })
    return t('branch.merged', { current, branch })
  }
  if (action === 'rebase') return t('branch.rebased', { current, branch })
  const upstream = typeof result?.upstream === 'string' && result.upstream !== '' ? result.upstream : branch
  return result?.pushed === false
    ? t('branch.pushLevel', { branch, upstream })
    : t('branch.pushed', { branch, upstream })
}
