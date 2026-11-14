/**
 * The panel's movement keys.
 *
 * The timeline, the file list, and the diff stream share one vocabulary:
 * up/down or `k`/`j` move within a list, and left/right or `h`/`l` move
 * between panes. Each zone decides what a direction means; command modifiers
 * keep the key's usual meaning.
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

/** Whether the event carries no command modifier. */
export function unmodified(event) {
  return !event.altKey && !event.ctrlKey && !event.metaKey
}

/**
 * The direction a key event asks for, or null when it asks for none.
 * @param {{ key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} event - the key event fields that matter.
 */
export function movement(event) {
  if (!unmodified(event)) return null
  return DIRECTIONS.get(event.key) ?? null
}
