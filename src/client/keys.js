/**
 * The panel's movement keys.
 *
 * The timeline and the change tree share one vocabulary: up/down or `k`/`j`
 * move within a list, left/right or `h`/`l` move between panes or into a row,
 * and brackets step across hunks. Each zone decides what a direction means;
 * command modifiers keep the key's usual meaning.
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

/** Keys that step to the next or previous hunk. */
const HUNK_NEXT = ']'
const HUNK_PREV = '['

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
 * The hunk step a key event asks for: 1 forward, -1 backward, 0 none.
 * @param {{ key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} event - the key event.
 * @returns {number} the step.
 */
export function hunkStep(event) {
  if (!unmodified(event)) return 0
  if (event.key === HUNK_NEXT) return 1
  if (event.key === HUNK_PREV) return -1
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
