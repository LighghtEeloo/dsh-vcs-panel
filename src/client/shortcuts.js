/**
 * Application-wide shortcut state for the VCS panel.
 *
 * DSH's shortcut registry handles key delivery, per-device defaults, conflict
 * checks, and the Settings > Shortcuts editor; this module owns the command
 * identity and the Session the command acts on. It is deliberately free of
 * React and DSH imports so the rules stay unit-testable.
 */

/** Command identity shown in Settings > Shortcuts. */
export const SHORTCUT_ID = 'vcs.view.toggle'

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
