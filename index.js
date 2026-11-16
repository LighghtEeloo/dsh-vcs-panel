/**
 * Host half of `dsh-vcs-panel`.
 *
 * Seven authenticated, read-only `/api/vcs.*` routes expose one repository's
 * working changes, a single file's hunks, its history, and each turn's
 * recorded head and change totals. The backend is chosen by the repository's
 * marker (Jujutsu or Git) and runs through the injected subprocess service
 * with fixed argv; no route stages, commits, checks out, or otherwise rewrites
 * commits or bookmarks.
 */

import { createHandlers } from './lib/handlers.js'
import { createTurnTracker } from './lib/turns.js'
import { createBackends } from './lib/vcs/index.js'

export { createHandlers } from './lib/handlers.js'
export { createTurnTracker } from './lib/turns.js'

/**
 * Services required: authenticated routes, session working directories,
 * backend execution, and filesystem containment.
 */
export const inject = ['connection', 'sessions', 'subprocess', 'fs']

/** One entry per registered route, in the order the client asks for them. */
const ROUTES = [
  ['/api/vcs.repositories', 'repositories'],
  ['/api/vcs.status', 'status'],
  ['/api/vcs.untracked', 'untracked'],
  ['/api/vcs.diff', 'diff'],
  ['/api/vcs.log', 'log'],
  ['/api/vcs.commit', 'commit'],
  ['/api/vcs.turn', 'turn'],
]

/**
 * Normalize the row config. Only a literal `enabled: false` turns the feature
 * off; a missing or unreadable config leaves the routes registered.
 * @param {unknown} raw - the config as Cordis supplied it.
 * @returns {{ enabled: boolean }} the normalized config.
 */
export function normalizeConfig(raw) {
  return { enabled: !(raw !== null && typeof raw === 'object' && raw.enabled === false) }
}

/**
 * Register the read-only routes and per-turn head observer inside Connection's
 * authentication fence.
 * @param {object} ctx - Host context carrying every injected service.
 * @param {unknown} config - the row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (!normalizeConfig(config).enabled) return

  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-vcs-panel: lifetime')

  const backends = createBackends(ctx)
  const turnTracker = createTurnTracker(ctx, { backends, signal: lifetime.signal })
  ctx.effect(() => turnTracker.attach(), 'dsh-vcs-panel: turn heads')

  const handlers = createHandlers(ctx, { backends, turnTracker })

  for (const [path, key] of ROUTES) {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async request => handlers[key](
          new Request(request, {
            signal: AbortSignal.any([request.signal, lifetime.signal]),
          }),
        ),
      }),
      `dsh-vcs-panel: ${path}`,
    )
  }
}
