/**
 * Stable route errors: one code for the client to branch on and one HTTP status
 * for the transport to send. Messages are written for a browser: they never
 * carry a host absolute path, a raw backend command, or a stack trace.
 */

/** The status the transport sends for each stable error code. */
export const ERROR_STATUS = Object.freeze({
  'bad-request': 400,
  'no-session': 409,
  'no-cwd': 409,
  'not-a-repo': 400,
  'vcs-missing': 503,
  'not-found': 404,
  timeout: 503,
  'output-too-large': 413,
  internal: 500,
})

/** Responses are read per request; a cached copy would show stale state. */
const NO_STORE = Object.freeze({ 'cache-control': 'no-store' })

/** One route failure the wrapper can translate into its JSON shape. */
export class VcsError extends Error {
  /**
   * @param {string} code - one of the keys of {@link ERROR_STATUS}.
   * @param {string} message - browser-safe explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'VcsError'
    this.code = Object.hasOwn(ERROR_STATUS, code) ? code : 'internal'
  }
}

/** An abbreviation for a bad-request failure. */
export function badRequest(message) {
  return new VcsError('bad-request', message)
}

/** An abbreviation for a missing-resource failure. */
export function notFound(message) {
  return new VcsError('not-found', message)
}

/** An abbreviation for a stdout-overflow failure. */
export function outputTooLarge() {
  return new VcsError('output-too-large', 'The command output exceeded the size limit for this view.')
}

/** An abbreviation for a command that outlived its deadline. */
export function timeoutError() {
  return new VcsError('timeout', 'The command took too long to answer.')
}

/** The abort error a cancelled request keeps instead of becoming a JSON answer. */
export function abortError() {
  return new DOMException('The request was aborted.', 'AbortError')
}

/**
 * A JSON success answer.
 * @param {unknown} value - the payload.
 * @param {number} status - the HTTP status.
 * @returns {Response} the response.
 */
export function json(value, status = 200) {
  return Response.json(value, { status, headers: NO_STORE })
}

/**
 * Translate one failure into the stable `{ error: { code, message } }` shape.
 * Unknown failures collapse to `internal`; their own text stays in the log.
 * @param {unknown} error - the caught failure.
 * @returns {Response} the JSON error answer.
 */
export function errorResponse(error) {
  const code = error instanceof VcsError ? error.code : 'internal'
  const message = error instanceof VcsError
    ? error.message
    : 'The version control request could not be completed.'
  return json({ error: { code, message } }, ERROR_STATUS[code])
}
