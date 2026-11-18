/**
 * The tag actions menu: which actions apply to a tag, visual grouping,
 * destructiveness, and which localized labels describe them while they run.
 *
 * A tag names one commit for good, so the menu offers the two writes that
 * maintain it: delete the local tag, or send it to a remote. Deleting leaves a
 * remote copy alone; pushing never forces and never moves the local tag.
 */

/** Visual group, destructiveness, and menu label key for each tag action. */
export const TAG_ACTION_META = Object.freeze({
  delete: { group: 0, destructive: true, labelKey: 'tag.delete' },
  push: { group: 1, destructive: false, labelKey: 'tag.push' },
})

/** Busy labels for the actions that report through the tag dialog. */
export const TAG_BUSY_KEYS = Object.freeze({
  delete: 'tag.deleting',
  push: 'tag.pushing',
})

/**
 * Actions the menu offers for one tag, in display order.
 * @returns {string[]} action ids.
 */
export function tagActions() {
  return ['delete', 'push']
}
