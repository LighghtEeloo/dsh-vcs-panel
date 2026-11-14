/**
 * Browser half of `dsh-vcs-panel`.
 *
 * Registers the version control entry in `conversation.view`, the per-turn
 * entry in `conversation.chat.turnTail`, the eight UI dictionaries, one
 * stylesheet, and the Session fold that decides whether a Turn changed files.
 * All host data comes from the authenticated `/api/vcs.*` routes; nothing here
 * writes to the repository.
 */

import { useEffect, useState } from 'react'

import shellStyles from './styles.css'
import diffStyles from './diff/FileDiff.css'
import graphStyles from './history/graph.css'
import { DICTIONARIES } from './locales.js'
import { createTurnChangesDefinition } from './turn.js'
import { TurnTailChanges } from './TurnTail.jsx'
import { VcsView } from './VcsView.jsx'

/** Locale namespace owned by this plugin. */
const NS = 'vcs'

/** The panel's tab id and sort position after Chat and Trajectory. */
const VIEW_ID = 'vcs'
const VIEW_ORDER = 20

/** Turn-tail entry identity and position (first, where the card used to be). */
const TURN_TAIL_ID = 'dsh-vcs-panel'
const TURN_TAIL_ORDER = -10

/** Required client services: slots, locale, and the Conversation registries. */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * Find the Conversation shell's per-Session store.
 *
 * `conversation.view` switching is not exposed as a service: the shell keeps
 * its selection in the store declared on the `conversation.session` slot, and
 * only entries that declare the same store handle receive its actions. The
 * Turn-tail entry therefore registers that handle and calls `setView`. The
 * lookup is defensive: when the store is not registered yet, the entry waits
 * for `conversation.session`; a DSH release that stops declaring the store
 * leaves the entry unregistered instead of throwing.
 *
 * @param {object} ctx - the Client root context.
 * @returns {object | undefined} the store handle with a `setView` action.
 */
function conversationStore(ctx) {
  for (const entry of ctx.slots.entries('conversation.session')) {
    const store = entry?.store
    if (store === null || store === undefined) continue
    if (typeof store.create !== 'function') continue
    if (typeof store.spec?.actions?.setView !== 'function') continue
    return store
  }
  return undefined
}

/**
 * Register the panel, the Turn-tail entry, the locale dictionaries, and the
 * Turn fold for the lifetime of this plugin entry.
 * @param {object} ctx - the Client root context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-vcs-panel: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-vcs-panel'
    style.textContent = `${shellStyles}\n${diffStyles}\n${graphStyles}`
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-vcs-panel: styles')

  ctx.effect(() => ctx.uiConversation.events.register(createTurnChangesDefinition()), 'dsh-vcs-panel: turn changes')

  const t = ctx.locale.bind(NS)

  /**
   * Track the active UI locale so dates and counts follow the language switch.
   * The translate function reads the locale at call time; this wrapper makes
   * the view re-render when the switch happens.
   * @param {object} props - standard Conversation view props.
   * @returns {object} the version control view with the active locale.
   */
  function LocalizedVcsView(props) {
    const [locale, setLocale] = useState(() => ctx.locale.getLocale().active)
    useEffect(() => ctx.locale.subscribe(() => {
      setLocale(ctx.locale.getLocale().active)
    }), [])
    return <VcsView {...props} locale={locale} />
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: VIEW_ID,
    order: VIEW_ORDER,
    locale: NS,
    label: () => t('view.label'),
  }, LocalizedVcsView))

  ctx.slots.inject('conversation.chat.turnTail', () => {
    let disposeEntry
    let disposeWatch
    /**
     * Register the entry once the Conversation store exists. The Chat view can
     * declare this slot before `conversation.session` is registered, so the
     * lookup may need to wait for that registration.
     */
    const mount = (store) => {
      /**
       * Select the version control view for one Session.
       *
       * `openView` also leaves a focus request for the view, so the keyboard
       * lands inside the panel after the Chat row unmounts; `setView` is the
       * older fallback when that action is absent. Binding activation keeps
       * the target set aligned with a header tab switch.
       */
      function TurnTailEntry(props) {
        const open = () => {
          try {
            ctx.uiConversation.binding(props.sessionId).activate(VIEW_ID)
          } catch {
            // The Session binding can disappear between paint and click.
          }
          try {
            if (typeof props.actions?.openView === 'function') {
              props.actions.openView(VIEW_ID, 'turn-tail')
            } else {
              props.actions?.setView?.(VIEW_ID)
            }
          } catch {
            // The Conversation store can be disposed with its view.
          }
        }
        return <TurnTailChanges {...props} onOpen={open} />
      }
      disposeEntry = ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: TURN_TAIL_ID,
        order: TURN_TAIL_ORDER,
        locale: NS,
        store,
      }, TurnTailEntry)
    }

    const store = conversationStore(ctx)
    if (store !== undefined) {
      mount(store)
    } else {
      disposeWatch = ctx.slots.subscribe('conversation.session', () => {
        const found = conversationStore(ctx)
        if (found === undefined) return
        disposeWatch?.()
        disposeWatch = undefined
        mount(found)
      })
    }

    return () => {
      disposeWatch?.()
      disposeEntry?.()
    }
  })
}
