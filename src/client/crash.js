/**
 * Diagnostic record for an unexpected VCS view failure.
 *
 * The Conversation view is a DSH slot entry: when its render or lifecycle
 * throws, DSH's slot boundary removes ("abdicates") the entry for the rest of
 * the page, which looks like a blank view. The panel's own boundary catches the
 * failure first, shows a retry surface, and keeps the details here so the next
 * occurrence can be inspected without the browser console.
 */

/** `sessionStorage` key of the most recent recorded failure. */
export const CRASH_STORAGE_KEY = 'vcs:last-error'

/** Longest stack or component stack kept in the record, in characters. */
const STACK_LIMIT = 12_000

/**
 * The one-line description of a caught error.
 * @param {unknown} error - the caught value.
 * @returns {string} `Name: message`, or a stringified value.
 */
export function describeCrash(error) {
  if (error === null || error === undefined) return 'Unknown error'
  if (typeof error === 'string') return error
  const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
  const message = typeof error.message === 'string' ? error.message : String(error)
  return `${name}: ${message}`
}

/** Trim one potentially long stack. */
function limit(value) {
  if (typeof value !== 'string') return ''
  return value.length <= STACK_LIMIT ? value : `${value.slice(0, STACK_LIMIT)}\n…`
}

/**
 * Record a caught failure.
 *
 * Writing is best-effort: an unavailable or full `sessionStorage` costs only
 * the diagnostic, never the fallback surface.
 *
 * @param {Storage | undefined} storage - a `sessionStorage`-compatible store.
 * @param {unknown} error - the caught error.
 * @param {{ componentStack?: string } | undefined} info - React's error info.
 * @param {number} [now] - epoch milliseconds, for tests.
 * @returns {{ time: number, message: string, stack: string, componentStack: string }} the record.
 */
export function recordCrash(storage, error, info, now = Date.now()) {
  const record = {
    time: now,
    message: describeCrash(error),
    stack: limit(error?.stack),
    componentStack: limit(info?.componentStack),
  }
  try {
    storage?.setItem(CRASH_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // A diagnostic is optional; the fallback still renders.
  }
  return record
}
