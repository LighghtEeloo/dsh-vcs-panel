/**
 * Application-wide shortcut state for the VCS view.
 *
 * DSH's shortcut registry handles key delivery, per-device defaults, conflict
 * checks, and the Settings > Shortcuts editor; this module owns the behavior
 * behind the command and the per-Session "which view am I on / which view was
 * I on before" memory. It is deliberately free of React and DSH imports so the
 * toggle rules stay unit-testable.
 */

/** Command identity shown in Settings > Shortcuts. */
export const SHORTCUT_ID = 'vcs.view.toggle'

/** The view owned by this command. */
export const VCS_VIEW = 'vcs'

/** Fallback when the previous non-VCS view is unknown or no longer registered. */
export const DEFAULT_VIEW = 'chat'

/**
 * Per-profile defaults: Command+Shift+G on macOS and Control+Shift+G
 * elsewhere. Linux Web is omitted because DSH's Web binding policy rejects
 * this combination; there the command starts unbound and the user can pick a
 * key in Settings > Shortcuts.
 */
export const SHORTCUT_DEFAULTS = Object.freeze({
  'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'desktop:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'desktop:linux': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'web:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'web:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
})

/**
 * Whether an action set can switch views. Slot entries receive the bound
 * Conversation store actions; both methods are needed by the two directions.
 * @param {unknown} actions - candidate store actions.
 * @returns {boolean} true when both view actions are callable.
 */
function usableActions(actions) {
  return actions !== null
    && typeof actions === 'object'
    && typeof actions.openView === 'function'
    && typeof actions.setView === 'function'
}

/**
 * Create the per-Session view memory used by the shortcut.
 *
 * `current` is the view the Conversation store reports, normalized to
 * `defaultView` when its persisted value is still null. `last` is the most
 * recent non-VCS view, never VCS itself, so a second press always returns to
 * the page the user left. Tracking is keyed by Session; switching Sessions
 * does not mix their histories.
 *
 * @param {{ vcsView?: string, defaultView?: string }} [options] - view ids.
 * @returns {{
 *   track(sessionId: string, view: string | null, actions: object): void,
 *   release(sessionId: string, actions: object): void,
 *   intent(sessionId: string): { kind: 'enter' | 'back', view: string, actions: object } | null,
 * }} the registry.
 */
export function createViewRegistry({ vcsView = VCS_VIEW, defaultView = DEFAULT_VIEW } = {}) {
  /** @type {Map<string, { current: string, last: string, actions: object }>} */
  const entries = new Map()
  return {
    track(sessionId, view, actions) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (!usableActions(actions)) return
      const current = typeof view === 'string' && view !== '' ? view : defaultView
      const entry = entries.get(sessionId)
      if (entry === undefined) {
        entries.set(sessionId, {
          current,
          last: current === vcsView ? defaultView : current,
          actions,
        })
        return
      }
      entry.current = current
      entry.actions = actions
      if (current !== vcsView) entry.last = current
    },
    release(sessionId, actions) {
      const entry = entries.get(sessionId)
      if (entry !== undefined && entry.actions === actions) entries.delete(sessionId)
    },
    intent(sessionId) {
      const entry = entries.get(sessionId)
      if (entry === undefined) return null
      if (entry.current === vcsView) return { kind: 'back', view: entry.last, actions: entry.actions }
      return { kind: 'enter', view: vcsView, actions: entry.actions }
    },
  }
}

/**
 * Pick the Session whose main view is resident. DSH's runtime Session list
 * records view retention; the same rule is used by the Workspace shortcuts to
 * resolve "the current Session".
 * @param {{ byId?: Record<string, { id?: string, retainedBy?: { mainView?: number } }> } | undefined} snapshot - Session list state.
 * @returns {string | null} the retained Session id, or null when no main view is resident.
 */
export function mainSessionId(snapshot) {
  const rows = snapshot?.byId
  if (rows === null || typeof rows !== 'object') return null
  for (const row of Object.values(rows)) {
    if ((row?.retainedBy?.mainView ?? 0) > 0 && typeof row.id === 'string' && row.id !== '') return row.id
  }
  return null
}

/**
 * Resolve the view to return to. A view that was unloaded since it was
 * recorded must not be selected again; Chat is the shell's own fallback.
 * @param {string | undefined} candidate - recorded last non-VCS view.
 * @param {Iterable<string> | undefined} registered - currently registered view ids.
 * @returns {string} the candidate when registered, else Chat.
 */
export function resolveBackView(candidate, registered) {
  const known = registered instanceof Set ? registered : new Set(registered ?? [])
  return typeof candidate === 'string' && candidate !== '' && known.has(candidate) ? candidate : DEFAULT_VIEW
}
