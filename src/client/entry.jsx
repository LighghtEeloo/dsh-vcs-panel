/**
 * Browser half of `dsh-vcs-panel`.
 *
 * Registers the version control entry in `conversation.view`, the per-turn
 * entry in `conversation.chat.turnTail`, the eight UI dictionaries, one
 * stylesheet, the Session fold that decides whether a Turn changed files, and
 * the application-wide view shortcut. All host data comes from the
 * authenticated `/api/vcs.*` routes; nothing here writes to the repository.
 */

import { useEffect, useLayoutEffect, useState } from 'react'

import shellStyles from './styles.css'
import diffStyles from './diff/FileDiff.css'
import graphStyles from './history/graph.css'
import { DICTIONARIES } from './locales.js'
import {
  SHORTCUT_DEFAULTS, SHORTCUT_ID, VCS_VIEW,
  createViewRegistry, mainSessionId, resolveBackView,
} from './shortcuts.js'
import { createTurnChangesDefinition, turnChangedFiles, turnChanges } from './turn.js'
import { createTurnSummaryStore } from './turn-summary.js'
import { TurnTailChanges } from './TurnTail.jsx'
import { VcsView } from './VcsView.jsx'
import { ViewErrorBoundary } from './ViewErrorBoundary.jsx'

/** Locale namespace owned by this plugin. */
const NS = 'vcs'

/** The panel's tab id and sort position after Chat and Trajectory. */
const VIEW_ID = VCS_VIEW
const VIEW_ORDER = 20

/** Turn-tail entry identity and position (first, where the card used to be). */
const TURN_TAIL_ID = 'dsh-vcs-panel'
const TURN_TAIL_ORDER = -10

/** Invisible Session bridge that feeds the view shortcut; it renders no chrome. */
const VIEW_BRIDGE_ID = 'dsh-vcs-panel:view-bridge'
const VIEW_BRIDGE_ORDER = 1000

/** Required client services: slots, locale, and the Conversation registries. */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * Per-Session view memory shared by the bridge entry and the shortcut command.
 * The bridge records what the Conversation store reports; the command reads it
 * synchronously when the key is pressed.
 */
const viewRegistry = createViewRegistry()

/**
 * Find the Conversation shell's per-Session store.
 *
 * `conversation.view` switching is not exposed as a service: the shell keeps
 * its selection in the store declared on the `conversation.session` slot, and
 * only entries that declare the same store handle receive its actions. The
 * Turn-tail entry and the view bridge therefore register that handle; the
 * shortcut switches views through the bridge's captured actions. The lookup is
 * defensive: when the store is not registered yet, entries wait for
 * `conversation.session`; a DSH release that stops declaring the store leaves
 * them unregistered instead of throwing.
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
 * Run a slot registration once the Conversation store exists.
 *
 * The Chat view or the Session header can declare their slots before
 * `conversation.session` is registered, so the lookup may need to wait for
 * that registration.
 *
 * @param {object} ctx - the Client root context.
 * @param {(store: object) => (() => void)} mount - registration callback.
 * @returns {() => void} disposer for the registration and its pending watch.
 */
function mountWithConversationStore(ctx, mount) {
  let disposeEntry
  let disposeWatch
  const attach = (store) => { disposeEntry = mount(store) }
  const store = conversationStore(ctx)
  if (store !== undefined) {
    attach(store)
  } else {
    disposeWatch = ctx.slots.subscribe('conversation.session', () => {
      const found = conversationStore(ctx)
      if (found === undefined) return
      disposeWatch?.()
      disposeWatch = undefined
      attach(found)
    })
  }
  return () => {
    disposeWatch?.()
    disposeEntry?.()
  }
}

/**
 * Invisible Session-scoped entry that keeps the shortcut's view memory current.
 *
 * It declares the Conversation store handle, so the slot runtime hands it the
 * same per-Session store instance and bound actions as the Conversation shell.
 * The store's persisted `view` is the source of truth; a layout effect publishes
 * it before paint so a key press never reads a stale selection.
 *
 * @param {{ sessionId: string, useStore: Function, actions: object }} props - slot store props.
 * @returns {null} no visible chrome.
 */
function ViewBridge({ sessionId, useStore, actions }) {
  const view = useStore(state => state.view)
  useLayoutEffect(() => {
    viewRegistry.track(sessionId, view, actions)
  }, [sessionId, view, actions])
  useLayoutEffect(() => () => {
    viewRegistry.release(sessionId, actions)
  }, [sessionId, actions])
  return null
}

/**
 * Collect the currently registered Conversation view ids.
 * @param {object} ctx - the Client root context.
 * @returns {Set<string>} view ids that can be selected again.
 */
function registeredViewIds(ctx) {
  const ids = new Set()
  for (const entry of ctx.slots.entries('conversation.view')) {
    const id = entry?.options?.id
    if (typeof id === 'string') ids.add(id)
  }
  return ids
}

/**
 * Register the application-wide view shortcut on a scope that has the
 * `shortcuts` and `sessions` services.
 *
 * The command is application-wide for the receiving device: regions cover the
 * page, editors, and terminal, while modals are left to the host's policy. A
 * default rejected by a future DSH release falls back to an unbound command so
 * the user can still assign a key in Settings > Shortcuts.
 *
 * @param {object} ctx - the Client root context.
 * @param {object} scope - injected Client scope.
 * @param {Function} t - namespaced translate function.
 * @returns {() => void} shortcut disposer.
 */
function registerViewShortcut(ctx, scope, t) {
  const command = {
    id: SHORTCUT_ID,
    label: () => t('shortcut.toggle'),
    aliases: ['vcs', 'version control', 'toggle vcs', 'changes'],
    defaults: SHORTCUT_DEFAULTS,
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve(context) {
      // Web/Linux already block commands behind modals; Desktop native input
      // takes priority over them, so decline explicitly instead of switching a
      // view hidden behind a dialog.
      if (context?.modal !== null && context?.modal !== undefined) return { status: 'pass' }
      const sessionId = mainSessionId(scope.sessions?.list?.getSnapshot?.())
      if (sessionId === null) return { status: 'pass' }
      const target = viewRegistry.intent(sessionId)
      if (target === null) return { status: 'pass' }
      let binding
      try {
        binding = ctx.uiConversation.binding(sessionId)
      } catch {
        // The Session binding can disappear between the key and its resolution.
        return { status: 'pass' }
      }
      if (binding === undefined) return { status: 'pass' }
      if (target.kind === 'enter') {
        return {
          status: 'handled',
          run: () => {
            try {
              binding.activate(VIEW_ID)
              target.actions.openView(VIEW_ID, 'shortcut')
            } catch (error) {
              console.warn('dsh-vcs-panel: shortcut could not open the view', error)
            }
          },
        }
      }
      const view = resolveBackView(target.view, registeredViewIds(ctx))
      return {
        status: 'handled',
        run: () => {
          try {
            binding.activate(view)
            target.actions.setView(view)
            // The view being left may never have mounted (for example after a
            // render failure), so its focus request can still be pending.
            target.actions.completeViewRequest?.()
          } catch (error) {
            console.warn('dsh-vcs-panel: shortcut could not restore the view', error)
          }
        },
      }
    },
  }
  try {
    return scope.shortcuts.register(command)
  } catch (error) {
    console.warn('dsh-vcs-panel: shortcut default is unavailable', error)
    try {
      return scope.shortcuts.register({ ...command, defaults: {} })
    } catch (fallbackError) {
      console.warn('dsh-vcs-panel: shortcut could not be registered', fallbackError)
      return () => {}
    }
  }
}

/**
 * Register the panel, the Turn-tail entry, the locale dictionaries, the Turn
 * fold, the invisible view bridge, and the view shortcut for the lifetime of
 * this plugin entry.
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

  const turnSummaries = createTurnSummaryStore()
  ctx.effect(() => {
    const disposeReset = typeof ctx.on === 'function'
      ? ctx.on('connection/reset', () => { turnSummaries.reset() })
      : undefined
    return () => {
      if (typeof disposeReset === 'function') disposeReset()
      turnSummaries.dispose()
    }
  }, 'dsh-vcs-panel: turn summaries')

  const t = ctx.locale.bind(NS)

  /**
   * Track the active UI locale so dates and counts follow the language switch.
   * The translate function reads the locale at call time; subscribing makes the
   * caller re-render when the switch happens.
   * @returns {string} active BCP 47 locale tag.
   */
  function useActiveLocale() {
    const [locale, setLocale] = useState(() => ctx.locale.getLocale().active)
    useEffect(() => ctx.locale.subscribe(() => {
      setLocale(ctx.locale.getLocale().active)
    }), [])
    return locale
  }

  /**
   * Version control view bound to the active UI locale.
   * @param {object} props - standard Conversation view props.
   * @returns {object} the version control view with the active locale.
   */
  function LocalizedVcsView(props) {
    const locale = useActiveLocale()
    return (
      <ViewErrorBoundary key={props.sessionId} t={t}>
        <VcsView {...props} locale={locale} />
      </ViewErrorBoundary>
    )
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: VIEW_ID,
    order: VIEW_ORDER,
    locale: NS,
    label: () => t('view.label'),
  }, LocalizedVcsView))

  ctx.slots.inject('conversation.chat.turnTail', () => mountWithConversationStore(ctx, (store) => {
    /**
     * Banner for a Turn that changed files, reading that Turn's recorded
     * repository head and line-diff totals.
     *
     * `openView` also leaves a focus request for the view, so the keyboard
     * lands inside the panel after the Chat row unmounts; `setView` is the
     * older fallback when that action is absent. Binding activation keeps
     * the target set aligned with a header tab switch.
     */
    function ActiveTurnTailEntry(props) {
      const locale = useActiveLocale()
      const coordinates = turnChanges(props.turn)
      const turnNumber = coordinates?.turn ?? null
      const seq = coordinates?.seq ?? null
      const [, setRevision] = useState(0)
      const summary = turnSummaries.get(props.sessionId, turnNumber, seq)
      useEffect(() => {
        const unsubscribe = turnSummaries.subscribe(props.sessionId, turnNumber, seq, () => {
          setRevision(value => value + 1)
        })
        turnSummaries.observe(props.sessionId, turnNumber, seq)
        return unsubscribe
      }, [props.sessionId, turnNumber, seq])
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
      return (
        <TurnTailChanges
          turn={props.turn}
          summary={summary}
          locale={locale}
          t={props.t}
          onOpen={open}
        />
      )
    }

    /** Skip hooks and subscriptions on Turns that changed no files. */
    function TurnTailEntry(props) {
      if (!turnChangedFiles(props.turn)) return null
      return <ActiveTurnTailEntry {...props} />
    }
    return ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: TURN_TAIL_ID,
      order: TURN_TAIL_ORDER,
      locale: NS,
      store,
    }, TurnTailEntry)
  }))

  // The shortcut is optional: without the host services the panel keeps its
  // normal registrations and simply has no global key.
  ctx.inject(['shortcuts', 'sessions'], (scope) => {
    scope.effect(() => registerViewShortcut(ctx, scope, t), 'dsh-vcs-panel: view shortcut')
    scope.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => mountWithConversationStore(ctx, (store) => (
      ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: VIEW_BRIDGE_ID,
        order: VIEW_BRIDGE_ORDER,
        locale: NS,
        store,
      }, ViewBridge)
    ))), 'dsh-vcs-panel: view bridge')
  })
}
