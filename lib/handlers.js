/**
 * The panel's routes: eight reads and two writes (sync and branch switching).
 *
 * Every handler takes one authenticated `Request` and answers with a JSON
 * `Response`. Backend-specific work lives behind the registry in `vcs/`;
 * this module only resolves the session and the repository, validates the
 * request shape, and dispatches.
 *
 * `createHandlers` exists apart from the Cordis wiring so tests can drive the
 * routes with a fake host context, and so `apply` stays thin.
 */

import { badRequest, errorResponse, json, notFound, VcsError } from './errors.js'
import { createBackends } from './vcs/index.js'
import { LOG_PAGE_MAX, LOG_SKIP_MAX } from './log.js'
import { sameRepoPath, validateRelPath } from './paths.js'
import { discoverRepositories } from './repositories.js'

/**
 * Clamp a number into a range.
 * @param {number} value - the number.
 * @param {number} min - lowest accepted value.
 * @param {number} max - highest accepted value.
 * @returns {number} the clamped value.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Read an optional integer query value.
 * @param {string | null} value - the query value.
 * @param {number} fallback - value when the query omits it.
 * @returns {number | undefined} the number, or undefined when malformed.
 */
function readInteger(value, fallback) {
  if (value === null) return fallback
  if (!/^-?\d+$/u.test(value)) return undefined
  return Number(value)
}

/**
 * Read a non-negative safe integer query value.
 * @param {string | null} value - the query value.
 * @returns {number | undefined} the integer, or undefined when missing or malformed.
 */
function readNonNegativeInteger(value) {
  if (value === null || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Build the route handlers bound to one host context.
 *
 * @param {object} ctx - Host context carrying `sessions`, `fs`, and `subprocess`.
 * @param {{ backends?: Map<string, object>, turnTracker?: { read: Function } }} [options] - shared backend and turn-head state.
 * @returns {{ repositories: Function, status: Function, untracked: Function, diff: Function, log: Function, commit: Function, turn: Function, sync: Function, branches: Function, switchBranch: Function }}
 *   one request handler per route.
 */
export function createHandlers(ctx, { backends = createBackends(ctx), turnTracker = ctx?.turnTracker } = {}) {
  /** Resolve the optional Host per-turn change recorder service. */
  function workspaceChanges() {
    const service = typeof ctx?.get === 'function'
      ? ctx.get('workspaceChanges')
      : ctx?.workspaceChanges
    return service !== null && service !== undefined && typeof service.summary === 'function'
      ? service
      : null
  }

  /**
   * Resolve the session a request addresses to its working directory.
   * The client sends a session identity rather than a path, so the browser
   * cannot aim this plugin at an arbitrary directory.
   * @param {URLSearchParams} query - the request query.
   * @returns {Promise<string>} the session working directory.
   * @throws {VcsError} when the session or its directory is missing.
   */
  async function requireCwd(query) {
    const sessionId = query.get('sessionId')
    if (sessionId === null || sessionId === '') throw badRequest('sessionId is required.')
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new VcsError('no-session', 'This session is no longer available.')
    }
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new VcsError('no-cwd', 'This session has no working directory.')
    }
    return cwd
  }

  /**
   * Resolve the request's repository query against what discovery offers,
   * never against the string alone.
   * @param {URLSearchParams} query - the request query.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ root: string, name: string, vcs: string, backend: object }>} the repository.
   */
  async function requireRepository(query, signal) {
    const cwd = await requireCwd(query)
    const repoQuery = query.get('repo')
    if (repoQuery === null || repoQuery === '') throw badRequest('repo is required.')
    const discovered = await discoverRepositories(ctx, cwd, signal)
    const match = discovered.repositories.find(repo => sameRepoPath(repo.path, repoQuery))
    if (match === undefined) {
      throw new VcsError('not-a-repo', 'The requested repository is not available in this session.')
    }
    const backend = backends.get(match.vcs)
    if (backend === undefined) {
      throw new VcsError('internal', 'This repository uses an unsupported version control backend.')
    }
    return { root: match.path, name: match.name, vcs: match.vcs, backend }
  }

  /** Handle `GET /api/vcs.repositories`. */
  async function repositories(request) {
    const query = new URL(request.url).searchParams
    const cwd = await requireCwd(query)
    const found = await discoverRepositories(ctx, cwd, request.signal)
    return json({
      ...found,
      repositories: found.repositories.map(repo => ({
        ...repo,
        capabilities: backends.get(repo.vcs)?.capabilities,
      })),
    })
  }

  /** Handle `GET /api/vcs.status`. */
  async function status(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    await repo.backend.require(request.signal)
    const answer = await repo.backend.status(repo.root, request.signal)
    return json({
      repo: { path: repo.root, name: repo.name },
      vcs: repo.vcs,
      capabilities: repo.backend.capabilities,
      ...answer,
    })
  }

  /** Handle `GET /api/vcs.untracked`. */
  async function untracked(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.untracked !== true || typeof repo.backend.untracked !== 'function') {
      throw badRequest('This repository has no untracked directories to expand.')
    }
    await repo.backend.require(request.signal)
    const answer = await repo.backend.untracked(repo.root, query.get('path'), request.signal)
    return json(answer)
  }

  /** Handle `GET /api/vcs.diff`. */
  async function diff(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    await repo.backend.require(request.signal)

    const scope = query.get('scope')
    if (scope === null || scope === '') throw badRequest('scope is required.')
    const rel = validateRelPath(query.get('path'))
    if (rel === undefined) throw badRequest('path must be a repository-relative file path.')
    const rawOldPath = query.get('oldPath')
    const oldPath = rawOldPath === null ? null : validateRelPath(rawOldPath)
    if (rawOldPath !== null && oldPath === undefined) {
      throw badRequest('oldPath must be a repository-relative file path.')
    }

    const answer = await repo.backend.diff(repo.root, {
      scope,
      path: rel,
      oldPath,
      rev: query.get('rev'),
    }, request.signal)
    return json(answer)
  }

  /** Handle `GET /api/vcs.log`. */
  async function log(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    await repo.backend.require(request.signal)

    const ranges = repo.backend.capabilities.ranges
    const ref = query.get('ref') ?? repo.backend.capabilities.defaultRange
    if (!ranges.some(range => range.value === ref)) {
      const values = ranges.map(range => range.value).join(', ')
      throw badRequest(`ref is ${values}.`)
    }
    const limitValue = readInteger(query.get('limit'), LOG_PAGE_MAX)
    const skipValue = readInteger(query.get('skip'), 0)
    if (limitValue === undefined) throw badRequest('limit must be an integer.')
    if (skipValue === undefined) throw badRequest('skip must be an integer.')
    const limit = clamp(limitValue, 1, LOG_PAGE_MAX)
    const skip = clamp(skipValue, 0, LOG_SKIP_MAX)

    const answer = await repo.backend.log(repo.root, { ref, limit, skip }, request.signal)
    return json(answer)
  }

  /** Handle `GET /api/vcs.commit`. */
  async function commit(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    await repo.backend.require(request.signal)

    const answer = await repo.backend.commit(repo.root, query.get('sha'), request.signal)
    return json(answer)
  }

  /** Repository roots with a write in flight; a second write of one root is refused. */
  const writing = new Set()

  /**
   * Read the JSON body of a write route and resolve its session and repository
   * fields into a query.
   *
   * The body is JSON, which a cross-site form cannot send without a CORS
   * preflight, and a browser-declared cross-site request is refused outright.
   * The session and repository then resolve exactly as for the reads.
   *
   * @param {Request} request - the write request.
   * @param {string} label - human name of the action, for messages.
   * @returns {Promise<{ body: object, query: URLSearchParams }>} the parsed body and its target.
   */
  async function readWrite(request, label) {
    if (request.method !== 'POST') throw badRequest(`${label} is a POST request.`)
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && site !== 'none') {
      throw new VcsError('forbidden', `${label} only accepts requests from this app.`)
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? '')) {
      throw badRequest(`${label} expects a JSON body.`)
    }
    let body
    try {
      body = await request.json()
    } catch {
      throw badRequest('The request body is not valid JSON.')
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('The request body must be an object.')
    }
    const query = new URLSearchParams()
    for (const key of ['sessionId', 'repo']) {
      if (typeof body[key] === 'string') query.set(key, body[key])
    }
    return { body, query }
  }

  /**
   * Handle `POST /api/vcs.sync`, one of the two writes.
   */
  async function sync(request) {
    const { query } = await readWrite(request, 'Sync')

    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.sync !== true || typeof repo.backend.sync !== 'function') {
      throw badRequest('This repository cannot sync from the panel.')
    }
    await repo.backend.require(request.signal)
    if (writing.has(repo.root)) {
      throw new VcsError('busy', 'Another write is already running for this repository.')
    }
    writing.add(repo.root)
    try {
      return json(await repo.backend.sync(repo.root, request.signal))
    } finally {
      writing.delete(repo.root)
    }
  }

  /**
   * Handle `GET /api/vcs.branches`, the local branches a switch can target.
   */
  async function branches(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.branchSwitch !== true || typeof repo.backend.branches !== 'function') {
      throw badRequest('This repository has no local branches to switch.')
    }
    await repo.backend.require(request.signal)
    return json(await repo.backend.branches(repo.root, request.signal))
  }

  /**
   * Handle `POST /api/vcs.switch`, the other write.
   *
   * The branch name is checked against the repository's own local branch list
   * by the backend, so only an existing local branch can reach `git switch`.
   */
  async function switchBranch(request) {
    const { body, query } = await readWrite(request, 'Branch switching')
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.branchSwitch !== true || typeof repo.backend.switchBranch !== 'function') {
      throw badRequest('This repository cannot switch branches from the panel.')
    }
    const branch = body.branch
    if (typeof branch !== 'string' || branch === '' || branch.length > 255
      || /[\u0000-\u0020\u007f]/u.test(branch) || branch.startsWith('-')) {
      throw badRequest('branch must name a local branch.')
    }
    await repo.backend.require(request.signal)
    if (writing.has(repo.root)) {
      throw new VcsError('busy', 'Another write is already running for this repository.')
    }
    writing.add(repo.root)
    try {
      return json(await repo.backend.switchBranch(repo.root, branch, request.signal))
    } finally {
      writing.delete(repo.root)
    }
  }

  /** Handle `GET /api/vcs.turn`. */
  async function turn(request) {
    const query = new URL(request.url).searchParams
    await requireCwd(query)
    const sessionId = query.get('sessionId')
    const turnNumber = readNonNegativeInteger(query.get('turn'))
    if (turnNumber === undefined || turnNumber < 1) {
      throw badRequest('turn must be a positive integer.')
    }
    const rawSeq = query.get('seq')
    const seq = rawSeq === null ? undefined : readNonNegativeInteger(rawSeq)
    if (rawSeq !== null && seq === undefined) {
      throw badRequest('seq must be a non-negative integer.')
    }

    const recordedHead = await turnTracker?.read?.(sessionId, turnNumber, request.signal)
    const recordedChanges = seq === undefined ? undefined : workspaceChanges()?.summary(sessionId, seq)
    if (recordedChanges !== undefined && recordedChanges !== null) {
      if (typeof recordedChanges !== 'object') {
        throw new VcsError('internal', 'The turn summary could not be read.')
      }
      if (recordedChanges.turn !== turnNumber) {
        throw badRequest('seq does not belong to turn.')
      }
      if (!Number.isSafeInteger(recordedChanges.total) || recordedChanges.total < 0
        || !Number.isSafeInteger(recordedChanges.added) || recordedChanges.added < 0
        || !Number.isSafeInteger(recordedChanges.deleted) || recordedChanges.deleted < 0) {
        throw new VcsError('internal', 'The turn summary could not be read.')
      }
    }
    if (recordedHead === undefined && (recordedChanges === undefined || recordedChanges === null)) {
      throw notFound('That turn summary is no longer available.')
    }

    return json({
      turn: turnNumber,
      head: recordedHead?.head ?? null,
      changed: recordedChanges?.total ?? null,
      added: recordedChanges?.added ?? null,
      deleted: recordedChanges?.deleted ?? null,
    })
  }

  /** Write one diagnostic line to the Host log; a broken logger must not replace the answer. */
  function warn(text) {
    try {
      ctx.logger?.warn?.(`dsh-vcs-panel: ${text}`)
    } catch {
      // The answer still goes out.
    }
  }

  /**
   * Turn a thrown route failure into its JSON answer, except for a cancelled
   * request, which keeps its abort so the transport can drop it.
   * @param {Function} handler - the route implementation.
   * @returns {(request: Request) => Promise<Response>} the guarded handler.
   */
  function wrap(handler) {
    return async function route(request) {
      try {
        return await handler(request)
      } catch (error) {
        if (request.signal?.aborted) throw error
        if (error instanceof VcsError) {
          if (error.detail !== undefined) warn(`${error.code}: ${error.detail}`)
          return errorResponse(error)
        }
        warn(error instanceof Error ? error.message : String(error))
        return errorResponse(error)
      }
    }
  }

  return {
    repositories: wrap(repositories),
    status: wrap(status),
    untracked: wrap(untracked),
    diff: wrap(diff),
    log: wrap(log),
    commit: wrap(commit),
    turn: wrap(turn),
    sync: wrap(sync),
    branches: wrap(branches),
    switchBranch: wrap(switchBranch),
  }
}
