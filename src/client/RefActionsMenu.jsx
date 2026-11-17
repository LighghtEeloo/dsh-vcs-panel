/**
 * The ref actions menu, shared by the header's branch control, the branch ref
 * badges in the timeline, and the tag ref badges.
 *
 * The caller names one ref, its kind, whether it is checked out, and the
 * actions that apply; this component only places, paints, and keys the menu.
 * It opens at the pointer, stays inside the viewport, focuses its first row,
 * closes on Escape, an outside press, a scroll, or a resize, and reports how
 * it closed so the caller can return focus to the control that opened it.
 */

import { useEffect, useRef } from 'react'

import { isDestructiveAction } from './branch.js'

/** Width of the menu, row height, and the space its title and separators take. */
const MENU_WIDTH = 252
const ITEM_HEIGHT = 28
const EXTRA_HEIGHT = 72
const MARGIN = 8

/** Keys the menu consumes so the panel's movement keys stay outside. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'])

/** Fixed labels for branch actions that take no interpolation. */
const BRANCH_LABELS = {
  checkout: 'branch.checkout',
  rename: 'branch.rename',
  delete: 'branch.delete',
  push: 'branch.push',
}

/** Fixed labels for tag actions. */
const TAG_LABELS = {
  delete: 'tag.delete',
  push: 'tag.push',
}

/** Actions in one visual group are separated from the next group. */
const BRANCH_GROUP = {
  checkout: 0,
  rename: 1,
  delete: 1,
  merge: 2,
  rebase: 2,
  push: 3,
}

/** A tag's destructive write is marked apart from its push. */
const TAG_GROUP = {
  delete: 0,
  push: 1,
}

/**
 * Keep one menu inside the viewport.
 * @param {{ x: number, y: number }} point - the opening point.
 * @param {number} count - number of rows.
 * @returns {{ left: number, top: number }} the fixed position.
 */
function menuPosition(point, count) {
  const height = count * ITEM_HEIGHT + EXTRA_HEIGHT
  if (typeof window === 'undefined') return { left: point.x, top: point.y }
  return {
    left: Math.max(MARGIN, Math.min(point.x, window.innerWidth - MENU_WIDTH - MARGIN)),
    top: Math.max(MARGIN, Math.min(point.y, window.innerHeight - height - MARGIN)),
  }
}

/** The localized row label for one action of one ref kind. */
function actionLabel(target, action, t) {
  if (target.kind === 'tag') return t(TAG_LABELS[action])
  if (action === 'merge') return t('branch.merge', { branch: target.name })
  if (action === 'rebase') return t('branch.rebase', { branch: target.name })
  return t(BRANCH_LABELS[action])
}

/** The visual group of one action, or undefined for an unknown action. */
function actionGroup(kind, action) {
  return (kind === 'tag' ? TAG_GROUP : BRANCH_GROUP)[action]
}

/**
 * Render the open ref actions menu.
 * @param {{ target: { kind: 'branch' | 'tag', name: string, current?: boolean, actions: string[], x: number, y: number } | null, busy: boolean, t: Function, onChoose: Function, onClose: (restoreFocus: boolean) => void }} props - the ref, its actions, and the close callbacks.
 */
export function RefActionsMenu({ target, busy, t, onChoose, onClose }) {
  const menuRef = useRef(null)

  // Move focus into the menu once it appears.
  useEffect(() => {
    if (target === null) return undefined
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector('[data-ops-item]')?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [target])

  // Dismissal: anything outside the menu.
  useEffect(() => {
    if (target === null) return undefined
    const dismiss = event => {
      if (menuRef.current?.contains(event.target)) return
      onClose(false)
    }
    const onResize = () => { onClose(false) }
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [onClose, target])

  if (target === null) return null
  const position = menuPosition(target, target.actions.length)
  const menuLabel = target.kind === 'tag'
    ? t('tag.menuLabel', { tag: target.name })
    : t('branch.menuLabel', { branch: target.name })

  const onKeyDown = event => {
    if (!MENU_KEYS.has(event.key)) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose(true)
      return
    }
    const items = Array.from(menuRef.current?.querySelectorAll('[data-ops-item]') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement)
    let next
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length
    else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div
      ref={menuRef}
      className="vcs-ref-ops"
      role="menu"
      aria-label={menuLabel}
      data-ref-kind={target.kind}
      tabIndex={-1}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onKeyDown={onKeyDown}
    >
      <p className="vcs-ref-ops-title">
        <span className="vcs-ref-ops-name">{target.name}</span>
        {target.kind === 'branch' && target.current ? <span className="vcs-ref-ops-current">{t('branch.current')}</span> : null}
      </p>
      {target.actions.map((action, index) => {
        const label = actionLabel(target, action, t)
        const separated = index > 0 && actionGroup(target.kind, action) !== actionGroup(target.kind, target.actions[index - 1])
        return (
          <div key={action}>
            {separated ? <div className="vcs-ref-ops-sep" role="separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={`vcs-menu-item vcs-ref-ops-item${isDestructiveAction(action) ? ' vcs-ref-ops-danger' : ''}`}
              data-ops-item=""
              aria-disabled={busy ? 'true' : undefined}
              title={label}
              onClick={() => { if (!busy) onChoose(action) }}
            >
              {label}
            </button>
          </div>
        )
      })}
    </div>
  )
}
