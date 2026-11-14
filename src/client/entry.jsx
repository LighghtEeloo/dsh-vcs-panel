/**
 * Browser half of `dsh-vcs-panel`.
 *
 * Registers the version control entry in `conversation.view`, the eight UI
 * dictionaries, and one stylesheet. All host data comes from the authenticated
 * `/api/vcs.*` routes; nothing here writes to the repository.
 */

import { useEffect, useState } from 'react'

import shellStyles from './styles.css'
import diffStyles from './diff/FileDiff.css'
import graphStyles from './history/graph.css'
import { DICTIONARIES } from './locales.js'
import { VcsView } from './VcsView.jsx'

/** Locale namespace owned by this plugin. */
const NS = 'vcs'

/** The panel's tab id and sort position after Chat and Trajectory. */
const VIEW_ID = 'vcs'
const VIEW_ORDER = 20

/** Required client services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the panel for the lifetime of this plugin entry.
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
}
