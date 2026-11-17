/**
 * The tag actions menu: which actions apply to a tag, and which localized
 * labels describe them while they run.
 *
 * A tag names one commit for good, so the menu offers the two writes that
 * maintain it: delete the local tag, or send it to a remote. Deleting leaves a
 * remote copy alone; pushing never forces and never moves the local tag.
 */

/** Busy labels for the actions that report through the tag dialog. */
export const TAG_BUSY_KEYS = {
  delete: 'tag.deleting',
  push: 'tag.pushing',
}

/**
 * Actions the menu offers for one tag, in display order.
 * @returns {string[]} action ids.
 */
export function tagActions() {
  return ['delete', 'push']
}
