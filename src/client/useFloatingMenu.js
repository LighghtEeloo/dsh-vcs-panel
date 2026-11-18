/**
 * Shared floating-menu dismissal, blur-exit, and roving keyboard navigation
 * used by the header pickers and the shared actions menu.
 */

import { useEffect } from 'react'

/** Keys a floating menu consumes so the panel's movement keys stay outside. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'])

/**
 * Manage outside-click/resize/external-scroll dismissal, Tab blur exit, and
 * roving keyboard navigation for one floating menu.
 *
 * Scrolling inside `menuRef` itself is ignored so overflowing menus can scroll
 * via mouse wheel or Arrow keys without closing themselves.
 *
 * @param {{ open: boolean, menuRef: { current: any }, triggerRef?: { current: any }, itemSelector: string, onClose: (restoreFocus: boolean) => void, dismissOnScroll?: boolean }} options - menu refs and dismissal rules.
 * @returns {{ onKeyDown: (event: any) => void, onBlur: (event: any) => void }} keyboard and blur handlers.
 */
export function useFloatingMenu({ open, menuRef, triggerRef, itemSelector, onClose, dismissOnScroll = true }) {
  useEffect(() => {
    if (!open) return undefined
    const hasDocument = typeof document !== 'undefined'
    const hasWindow = typeof window !== 'undefined'
    const dismiss = event => {
      if (menuRef.current?.contains?.(event.target)) return
      if (triggerRef?.current?.contains?.(event.target)) return
      onClose(false)
    }
    const onResize = () => { onClose(false) }
    const onScroll = event => {
      // Scrolling inside an overflowing menu must not dismiss itself.
      if (menuRef.current?.contains?.(event.target)) return
      onClose(false)
    }
    if (hasDocument) document.addEventListener('pointerdown', dismiss, true)
    if (hasWindow) {
      window.addEventListener('resize', onResize)
      if (dismissOnScroll) window.addEventListener('scroll', onScroll, true)
    }
    return () => {
      if (hasDocument) document.removeEventListener('pointerdown', dismiss, true)
      if (hasWindow) {
        window.removeEventListener('resize', onResize)
        if (dismissOnScroll) window.removeEventListener('scroll', onScroll, true)
      }
    }
  }, [dismissOnScroll, menuRef, onClose, open, triggerRef])

  const onKeyDown = event => {
    if (!MENU_KEYS.has(event.key)) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose(true)
      return
    }
    const items = Array.from(menuRef.current?.querySelectorAll?.(itemSelector) ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const active = typeof document === 'undefined' ? null : document.activeElement
    const index = items.indexOf(active)
    let next
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length
    else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const onBlur = event => {
    if (!open) return
    if (event.relatedTarget !== null && event.relatedTarget !== undefined
      && event.currentTarget?.contains?.(event.relatedTarget)) {
      return
    }
    onClose(false)
  }

  return { onKeyDown, onBlur }
}
