/**
 * Host half of `dsh-vcs-panel`.
 *
 * Six authenticated, read-only `/api/vcs.*` routes expose one repository's
 * working changes, a single file's hunks, and its history. The backend is
 * chosen by the repository's marker (Jujutsu or Git) and runs through the
 * injected subprocess service with fixed argv; no route stages, commits,
 * checks out, or otherwise rewrites commits or bookmarks.
 */

import { createHandlers } from './lib/handlers.js'

export { createHandlers } from './lib/handlers.js'

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
 * Register the read-only routes inside Connection's authentication fence.
 * @param {object} ctx - Host context carrying every injected service.
 * @param {unknown} config - the row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (!normalizeConfig(config).enabled) return

  const handlers = createHandlers(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-vcs-panel: lifetime')

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
