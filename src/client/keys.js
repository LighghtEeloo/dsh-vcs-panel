/**
 * The panel's movement keys.
 *
 * The timeline and the change tree share one vocabulary: up/down or `k`/`j`
 * move through one vertical list, left/right or `h`/`l` move between panes or
 * into a row, and brackets move between tree rows. Each zone decides what a
 * direction means; command modifiers keep the key's usual meaning.
 */

/** Directions a movement key can ask for. */
export const UP = 'up'
export const DOWN = 'down'
export const BACK = 'back'
export const FORWARD = 'forward'

/** Key names by direction. */
const DIRECTIONS = new Map([
  ['ArrowUp', UP],
  ['k', UP],
  ['ArrowDown', DOWN],
  ['j', DOWN],
  ['ArrowLeft', BACK],
  ['h', BACK],
  ['ArrowRight', FORWARD],
  ['l', FORWARD],
])

/** Keys that move to the next or previous row of the change tree. */
const ROW_NEXT = ']'
const ROW_PREV = '['

/**
 * Whether the event carries no command modifier. AltGr reports itself as Alt
 * on layouts where the right Alt key composes characters (German, French);
 * the character it produces is what the user asked for, so it still counts as
 * unmodified.
 * @param {{ altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, getModifierState?: Function }} event - the key event.
 * @returns {boolean} true when the key has no command modifier.
 */
export function unmodified(event) {
  if (event.ctrlKey === true || event.metaKey === true) return false
  if (event.altKey !== true) return true
  return typeof event.getModifierState === 'function' && event.getModifierState('AltGraph') === true
}

/**
 * The direction a key event asks for, or null when it asks for none.
 * @param {{ key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} event - the key event fields that matter.
 */
export function movement(event) {
  if (!unmodified(event)) return null
  return DIRECTIONS.get(event.key) ?? null
}

/**
 * The row step a key event asks for: 1 forward, -1 backward, 0 none.
 * @param {{ key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} event - the key event.
 * @returns {number} the step.
 */
export function rowStep(event) {
  if (!unmodified(event)) return 0
  if (event.key === ROW_NEXT) return 1
  if (event.key === ROW_PREV) return -1
  return 0
}

/**
 * Whether a key event originated in a form control or editable element whose
 * keys belong to text or option input rather than panel navigation.
 * @param {unknown} target - `event.target`.
 * @returns {boolean} true when panel keys must leave the event alone.
 */
export function isEditableTarget(target) {
  if (target === null || typeof target !== 'object') return false
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
}

/**
 * Walk `node` and its `parentElement` ancestors until `stop` (exclusive)
 * looking for the nearest node satisfying `predicate`.
 * @param {unknown} node - starting element.
 * @param {unknown} stop - ancestor boundary (not visited), or null.
 * @param {(candidate: any) => boolean} predicate - match test.
 * @returns {any | null} the matching ancestor, or null.
 */
export function findAncestor(node, stop, predicate) {
  let current = node
  while (current !== null && current !== undefined && current !== stop) {
    if (predicate(current)) return current
    current = current.parentElement ?? null
  }
  return null
}

/**
 * Whether an element carries CSS class `token` (safe on DOM and test stubs).
 * @param {unknown} element - candidate element.
 * @param {string} token - class name.
 * @returns {boolean} true when present.
 */
export function hasClass(element, token) {
  return element?.classList?.contains?.(token) === true
}

/**
 * Whether an element carries attribute `name` (optionally matching `value`).
 * Supports both real DOM Elements and `FakeElement` in tests.
 * @param {unknown} element - candidate element.
 * @param {string} name - attribute name.
 * @param {string} [value] - expected value when provided.
 * @returns {boolean} true when present (and equal to `value`, if given).
 */
export function hasAttr(element, name, value) {
  if (element === null || element === undefined || typeof element !== 'object') return false
  if (typeof element.getAttribute === 'function') {
    if (value === undefined) return element.hasAttribute?.(name) ?? element.getAttribute(name) !== null
    return element.getAttribute(name) === value
  }
  if (typeof element.attributes?.has === 'function') {
    if (!element.attributes.has(name)) return false
    return value === undefined ? true : element.attributes.get(name) === value
  }
  return false
}

/**
 * Which keyboard navigation zone (`'timeline'` or `'tree'`) contains
 * `element`, stopping before `stop`.
 * @param {unknown} element - target or focused element.
 * @param {unknown} [stop=null] - panel root boundary.
 * @returns {'timeline' | 'tree' | null} the owning navigation zone.
 */
export function zoneOf(element, stop = null) {
  const found = findAncestor(element, stop, node => (
    node?.dataset?.zone === 'timeline'
    || node?.dataset?.timelineIndex !== undefined
    || node?.dataset?.zone === 'tree'
    || node?.dataset?.rowKey !== undefined
    || hasAttr(node, 'data-diff-hunk-header')
  ))
  if (found === null) return null
  if (found.dataset?.zone === 'timeline' || found.dataset?.timelineIndex !== undefined) return 'timeline'
  return 'tree'
}

/**
 * Whether `element` is (or sits inside) a cursor stop: a timeline row,
 * a change-tree row, or a diff hunk header.
 * @param {unknown} element - candidate element.
 * @param {unknown} [stop=null] - panel root boundary.
 * @returns {boolean} true for navigation stops.
 */
export function isNavigationStop(element, stop = null) {
  return findAncestor(element, stop, node => (
    hasClass(node, 'vcs-timeline-row')
    || hasClass(node, 'vcs-tree-row')
    || hasAttr(node, 'data-diff-hunk-header')
  )) !== null
}

/**
 * Whether this element is a panel overlay, which owns its keyboard behavior.
 */
function isOverlay(node) {
  return hasClass(node, 'vcs-dialog-layer') || hasAttr(node, 'role', 'menu')
}

/** Whether `element` lives inside a panel dialog or floating menu. */
export function isOverlayTarget(element, stop = null) {
  return findAncestor(element, stop, isOverlay) !== null
}

/**
 * Whether `element` lives inside a dialog, floating menu, or menu trigger.
 * @param {unknown} element - candidate element.
 * @param {unknown} [stop=null] - panel root boundary.
 * @returns {boolean} true for overlay/menu controls.
 */
export function isOverlayOrMenuTarget(element, stop = null) {
  return findAncestor(element, stop, node => (
    isOverlay(node) || hasAttr(node, 'aria-haspopup', 'menu')
  )) !== null
}

/**
 * Whether `element` is (or sits inside) a discrete action button inside the
 * panel (such as sync, refresh, split/wrap/fold toggles, SHA copy, parent
 * commit jump, load more, or retry) rather than a navigation row or menu.
 * @param {unknown} element - candidate element.
 * @param {unknown} [stop=null] - panel root boundary.
 * @returns {boolean} true for discrete action buttons.
 */
export function isDiscreteActionButton(element, stop = null) {
  const button = findAncestor(element, stop, node => (
    typeof node?.tagName === 'string' && node.tagName.toUpperCase() === 'BUTTON'
  ))
  if (button === null) return false
  return !isNavigationStop(element, stop) && !isOverlayOrMenuTarget(element, stop)
}

/**
 * Whether the panel can claim keyboard focus for its active navigation stop
 * when becoming visible or when the browser/app window regains focus, without
 * stealing focus from an external input, modal dialog, or another pane.
 * @param {unknown} active - current `document.activeElement`.
 * @param {unknown} root - the panel's `.vcs-root` element.
 * @returns {boolean} true when claiming focus for VCS navigation is safe.
 */
export function canClaimFocusFrom(active, root) {
  if (root === null || root === undefined) return false
  const doc = root.ownerDocument ?? (typeof document === 'undefined' ? null : document)
  const isModalNode = node => hasAttr(node, 'aria-modal', 'true') || hasAttr(node, 'role', 'dialog')
  const activeModal = findAncestor(active, null, isModalNode)
  if (activeModal !== null && !root.contains?.(activeModal) && !activeModal.contains?.(root)) {
    return false
  }
  const modals = doc?.body?.querySelectorAll?.('[aria-modal="true"]')
  if (modals !== undefined && modals !== null) {
    for (const modal of modals) {
      if (!root.contains?.(modal) && !modal.contains?.(root)) return false
    }
  }
  if (active === null || active === undefined || active === doc?.body || active === doc?.documentElement || active === root) {
    return true
  }
  if (root.contains?.(active)) {
    return !isEditableTarget(active) && !isOverlayOrMenuTarget(active, root)
  }
  if (hasClass(active, 'vcs-turn-banner') || hasAttr(active, 'data-dockkit-pane') || hasAttr(active, 'data-dockkit-float')) {
    return true
  }
  const pane = findAncestor(root, null, node => hasAttr(node, 'data-dockkit-pane') || hasAttr(node, 'data-dockkit-float'))
  if (pane !== null && pane.contains?.(active) && !isEditableTarget(active)) {
    return true
  }
  return false
}
