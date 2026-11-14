/**
 * Session-scoped panel state.
 *
 * The Host owns Git; this module owns only what the panel remembers per
 * Session: repository, tab, selection, expansion, layout choices, and scroll
 * offsets. `sessionStorage` is the boundary — losing it drops the panel back
 * to defaults, never to an error.
 */

/** Prefix that keeps this plugin's keys apart from any other tab state. */
const KEY_PREFIX = 'vcs:'

/** Tab ids the panel accepts. */
export const TABS = ['changes', 'history']

/** Ref modes the history tab accepts. */
export const REFS = ['HEAD', 'all']

/** Sidebar width bounds, in CSS pixels. */
export const SIDEBAR_MIN = 280
export const SIDEBAR_MAX = 480

/**
 * The state a fresh Session starts with.
 * @returns {object} a new default state object.
 */
export function defaultState() {
  return {
    repo: null,
    tab: 'changes',
    file: null,
    dirs: {},
    collapsed: {},
    commit: null,
    commitFile: null,
    ref: 'HEAD',
    split: false,
    wrap: false,
    sidebarWidth: 320,
    scroll: { changes: 0, history: 0 },
  }
}

/** Clamp a finite number into a range. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** A non-empty string, or null. */
function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Copy only boolean-true entries of a plain object. */
function trueKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, on] of Object.entries(value)) {
    if (on === true && typeof key === 'string') result[key] = true
  }
  return result
}

/**
 * Normalize one selected working-tree file.
 * @param {unknown} value - persisted value.
 * @returns {{ group: string, path: string } | null} the selection or null.
 */
function fileOrNull(value) {
  if (value === null || typeof value !== 'object') return null
  const group = value.group
  const path = value.path
  if ((group !== 'staged' && group !== 'unstaged' && group !== 'untracked') || typeof path !== 'string' || path === '') {
    return null
  }
  return { group, path }
}

/**
 * Rebuild a persisted state, dropping anything this version does not accept.
 * @param {unknown} raw - parsed storage value.
 * @returns {object} a complete state.
 */
export function sanitizeState(raw) {
  const base = defaultState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const state = base
  state.repo = textOrNull(raw.repo)
  if (TABS.includes(raw.tab)) state.tab = raw.tab
  state.file = fileOrNull(raw.file)
  state.dirs = trueKeys(raw.dirs)
  state.collapsed = trueKeys(raw.collapsed)
  state.commit = typeof raw.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.commit) ? raw.commit : null
  state.commitFile = textOrNull(raw.commitFile)
  if (REFS.includes(raw.ref)) state.ref = raw.ref
  state.split = raw.split === true
  state.wrap = raw.wrap === true
  if (typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)) {
    state.sidebarWidth = clamp(Math.round(raw.sidebarWidth), SIDEBAR_MIN, SIDEBAR_MAX)
  }
  if (raw.scroll !== null && typeof raw.scroll === 'object') {
    for (const key of ['changes', 'history']) {
      const value = raw.scroll[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) state.scroll[key] = value
    }
  }
  return state
}

/** The storage key for one Session. */
export function storageKey(sessionId) {
  return `${KEY_PREFIX}${sessionId}`
}

/**
 * Read one Session's panel state.
 * @param {string} sessionId - the Session whose panel is opening.
 * @param {Storage} [storage] - sessionStorage-compatible store.
 * @returns {object} the restored or default state.
 */
export function loadState(sessionId, storage = globalThis.sessionStorage) {
  try {
    const raw = storage?.getItem(storageKey(sessionId))
    if (raw === null || raw === undefined) return defaultState()
    return sanitizeState(JSON.parse(raw))
  } catch {
    return defaultState()
  }
}

/**
 * Persist one Session's panel state.
 * @param {string} sessionId - the Session the state belongs to.
 * @param {object} state - the complete state to write.
 * @param {Storage} [storage] - sessionStorage-compatible store.
 * @returns {void}
 */
export function saveState(sessionId, state, storage = globalThis.sessionStorage) {
  try {
    storage?.setItem(storageKey(sessionId), JSON.stringify(state))
  } catch {
    // A full or unavailable sessionStorage costs only restoration, never the panel.
  }
}
