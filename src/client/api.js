/**
 * Browser data layer for the Host routes: the reads and the one sync write.
 *
 * One instance serves one Session: every request carries the Session identity
 * and the repository the panel currently shows. Requests are cancellable with
 * an AbortSignal, and a non-2xx answer becomes an {@link ApiError} carrying the
 * Host's stable code so views can distinguish "missing" from "failed".
 */

/** A failed Host request with its stable error code. */
export class ApiError extends Error {
  /**
   * @param {string} code - Host error code.
   * @param {string} message - message safe to render.
   * @param {number} status - HTTP status.
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * Build the query string for one request.
 * @param {Record<string, string | number | undefined | null>} params - query values.
 * @returns {string} the query string including the leading `?`.
 */
export function queryString(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** Whether an async failure came from an AbortSignal cancellation. */
function isAborted(error, signal) {
  return error?.name === 'AbortError' || signal?.aborted === true
}

/** Normalize a cancelled request to an `AbortError`. */
function toAbortError(error) {
  if (error?.name === 'AbortError') return error
  return new DOMException('The request was aborted.', 'AbortError')
}

/**
 * Create the Session-scoped API.
 * @param {string} sessionId - the open Conversation Session.
 * @param {object} [options] - injection seam for tests.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {string} [options.base] - URL prefix; empty means relative to the app.
 * @returns {object} the route methods.
 */
export function createApi(sessionId, { fetchImpl = globalThis.fetch, base = '' } = {}) {
  /**
   * Decode one Host answer, turning a non-2xx status into an {@link ApiError}.
   * @param {Response} response - the transport answer.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} the decoded body.
   */
  async function decode(response, signal) {
    let body = null
    let bodyFailed = false
    try {
      body = await response.json()
    } catch (error) {
      if (isAborted(error, signal)) throw toAbortError(error)
      // A body-less failure still carries its HTTP status.
      bodyFailed = true
    }
    if (signal?.aborted === true) throw toAbortError(signal.reason)
    if (!response.ok) {
      const error = body?.error
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const message = typeof error?.message === 'string' ? error.message : `Request failed (${response.status}).`
      throw new ApiError(code, message, response.status)
    }
    if (bodyFailed || body === null || typeof body !== 'object') {
      throw new ApiError('internal', 'The version control response could not be read.', response.status)
    }
    return body
  }

  /**
   * One JSON read.
   * @param {string} path - exact Host route path.
   * @param {Record<string, string | number | undefined | null>} params - query values.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<unknown>} the decoded body.
   */
  async function get(path, params, signal) {
    let response
    try {
      response = await fetchImpl(`${base}${path}${queryString({ sessionId, ...params })}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      })
    } catch (error) {
      if (isAborted(error, signal)) throw toAbortError(error)
      throw new ApiError('network', 'The version control panel could not reach the Host.', 0)
    }
    return decode(response, signal)
  }

  /**
   * One JSON write. It carries no AbortSignal: once sent, the Host finishes it
   * even if the panel goes away.
   * @param {string} path - exact Host route path.
   * @param {Record<string, string>} values - body values besides the Session.
   * @returns {Promise<unknown>} the decoded body.
   */
  async function post(path, values) {
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...values }),
      })
    } catch {
      throw new ApiError('network', 'The version control panel could not reach the Host.', 0)
    }
    return decode(response)
  }

  return {
    /**
     * Repositories the Session may show.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<{ repositories: object[], cwd: string, truncated: boolean }>} the list.
     */
    repositories(signal) {
      return get('/api/vcs.repositories', {}, signal)
    },

    /**
     * Branch facts and the three working-tree groups.
     * @param {string} repo - repository root from the repositories answer.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the status.
     */
    status(repo, signal) {
      return get('/api/vcs.status', { repo }, signal)
    },

    /**
     * Direct children of one untracked directory.
     * @param {string} repo - repository root.
     * @param {string} path - directory path relative to the repository, slash-suffixed.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the directory listing.
     */
    untracked(repo, path, signal) {
      return get('/api/vcs.untracked', { repo, path }, signal)
    },

    /**
     * One file comparison.
     * @param {string} repo - repository root.
     * @param {{ scope: string, path: string, rev?: string | null }} target - comparison target.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the comparison state.
     */
    diff(repo, target, signal) {
      return get('/api/vcs.diff', {
        repo,
        scope: target.scope,
        path: target.path,
        oldPath: target.oldPath,
        rev: target.scope === 'commit' ? target.rev : undefined,
      }, signal)
    },

    /**
     * One page of commits.
     * @param {string} repo - repository root.
     * @param {{ ref?: string, skip?: number, limit?: number }} page - page selection.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the commit page.
     */
    log(repo, page = {}, signal) {
      return get('/api/vcs.log', { repo, ref: page.ref, skip: page.skip, limit: page.limit }, signal)
    },

    /**
     * One commit's metadata and changed files.
     * @param {string} repo - repository root.
     * @param {string} sha - full or abbreviated commit id.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the commit detail.
     */
    commit(repo, sha, signal) {
      return get('/api/vcs.commit', { repo, sha }, signal)
    },

    /**
     * One completed turn's recorded repository head and change totals.
     * @param {number} turn - 1-based turn number.
     * @param {number | null} [seq] - announcing `workspace/changes` event sequence, when present.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the turn summary.
     */
    turn(turn, seq, signal) {
      return get('/api/vcs.turn', { turn, seq }, signal)
    },

    /**
     * Bring the checked-out branch level with its upstream: fetch, then
     * fast-forward or push.
     * @param {string} repo - repository root.
     * @returns {Promise<{ upstream: string, pulled: number, pushed: number }>} what moved.
     */
    sync(repo) {
      return post('/api/vcs.sync', { repo })
    },
  }
}
