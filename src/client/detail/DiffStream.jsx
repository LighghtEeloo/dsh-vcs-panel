/**
 * The diff stream: every file of one node as a section in navigation order.
 *
 * A section asks for its comparison only when it comes near the viewport, and
 * a shared queue keeps a few requests in flight; a section that scrolls away
 * before its turn never reaches the Host. Until its comparison arrives a
 * section holds an estimated height, so the scroll height settles early and
 * the browser's scroll anchoring keeps the reading position steady while
 * sections above it load. Each section header sticks to the top while its
 * comparison is in view.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileDiff } from '../diff/FileDiff.jsx'
import { formatCount, lineCounts, splitPath, statusKey } from '../format.js'
import { Chevron } from '../ui.jsx'
import { MAX_PARALLEL, changedLines, estimateHeight, isFolded, sectionAt } from './detail.js'
import { createQueue } from './queue.js'

/** Distance beyond the viewport at which a section starts loading. */
const PRELOAD_MARGIN = '800px 0px'

/** Comparisons kept across nodes and refreshes of the same revision. */
const CACHE_LIMIT = 300

/** The identity of one comparison request. */
function targetKey(target) {
  return `${target.scope}|${target.path}|${target.oldPath ?? ''}|${target.rev ?? ''}`
}

/** Store one answer, evicting the oldest past {@link CACHE_LIMIT}. */
function remember(cache, key, value) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
}

/** The localized reason a folded section gives. */
function foldedText(reason, entry, t, locale) {
  if (reason === 'large') return t('stream.foldedLarge', { count: formatCount(changedLines(entry), locale) })
  if (reason === 'budget') return t('stream.foldedBudget')
  return t('stream.folded')
}

/** One file's section. */
const Section = memo(function Section({
  section, near, folded, foldReason, onToggleFold, request, revision,
  split, wrap, bindElement, t, locale,
}) {
  const [answer, setAnswer] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const { entry } = section

  useEffect(() => {
    if (folded || !near) return undefined
    if (answer !== null && answer.revision === revision && answer.attempt === attempt) return undefined
    // The previous answer stays on screen until the new one arrives.
    return request(section.target, revision, result => { setAnswer({ ...result, revision, attempt }) })
    // `answer` is read only to skip work that already finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded, near, revision, attempt, request, targetKey(section.target)])

  const counts = lineCounts(entry)
  const parts = splitPath(entry.path)
  let body
  if (folded) {
    body = (
      <p className="vcs-section-folded">
        <span>{foldedText(foldReason, entry, t, locale)}</span>
        <button type="button" className="vcs-button" onClick={() => { onToggleFold(section.key, false) }}>{t('stream.expand')}</button>
      </p>
    )
  } else if (answer === null) {
    body = (
      <div className="vcs-section-placeholder" style={{ height: `${estimateHeight(entry)}px` }}>
        <FileDiff state="loading" split={split} wrap={wrap} retry={() => undefined} t={t} locale={locale} />
      </div>
    )
  } else {
    const state = answer.status === 'ready' ? answer.diff : answer.status
    body = <FileDiff state={state} split={split} wrap={wrap} retry={() => { setAttempt(value => value + 1) }} t={t} locale={locale} />
  }

  return (
    <section className="vcs-section" data-section-key={section.key} ref={bindElement(section.key)}>
      <div className="vcs-section-header">
        <button
          type="button"
          className="vcs-section-toggle"
          aria-expanded={!folded}
          title={folded ? t('stream.expand') : t('stream.collapse')}
          onClick={() => { onToggleFold(section.key, !folded) }}
        >
          <Chevron open={!folded} />
          <span className={`vcs-status vcs-status-${entry.status}`} aria-hidden="true">{entry.status}</span>
          <span className="vcs-sr-only">{t(statusKey(entry.status))}</span>
          <span className="vcs-section-path">
            {entry.origPath === undefined ? null : <span className="vcs-dim">{entry.origPath} → </span>}
            {parts.dir === '' ? null : <span className="vcs-dim">{parts.dir}</span>}
            <strong>{parts.base}</strong>
          </span>
          {entry.binary ? <span className="vcs-row-stat vcs-dim">{t('changes.binary')}</span> : (
            <span className="vcs-row-stat">
              {counts.added !== null && counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added, locale)}</span> : null}
              {counts.deleted !== null && counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted, locale)}</span> : null}
            </span>
          )}
        </button>
      </div>
      <div className="vcs-section-body">{body}</div>
    </section>
  )
})

/**
 * Render the stream.
 * @param {{ api: object, repo: string, sections: object[], groupLabels: Record<string, string> | null, defaults: Map<string, string>, folds: Record<string, boolean>, onToggleFold: (key: string, folded: boolean) => void, split: boolean, wrap: boolean, revision: number, cache: Map<string, object>, initialAnchor: { key: string, offset: number } | null, onReading: (anchor: { key: string, offset: number } | null) => void, control: { current: object | null }, before?: object, t: Function, locale?: string }} props - stream state.
 */
export function DiffStream({
  api, repo, sections, groupLabels, defaults, folds, onToggleFold, split, wrap, revision, cache,
  initialAnchor, onReading, control, before = null, t, locale,
}) {
  const scrollRef = useRef(null)
  const elements = useRef(new Map())
  const observerRef = useRef(null)
  const queue = useMemo(() => createQueue(MAX_PARALLEL), [])
  const [near, setNear] = useState(() => new Set())
  const [everyNear, setEveryNear] = useState(false)

  /** Ask for one comparison through the cache and the queue; returns a canceller. */
  const request = useCallback((target, answerRevision, onAnswer) => {
    const key = `${repo}|${targetKey(target)}|${answerRevision}`
    const cached = cache.get(key)
    if (cached !== undefined) {
      onAnswer(cached)
      return undefined
    }
    const controller = new AbortController()
    let settled = false
    const cancel = queue.enqueue(() => api.diff(repo, target, controller.signal).then(diff => {
      settled = true
      const result = { status: 'ready', diff }
      remember(cache, key, result)
      onAnswer(result)
    }, error => {
      if (error?.name === 'AbortError') return
      settled = true
      onAnswer({ status: error?.code === 'not-found' ? 'missing' : 'error', diff: null })
    }))
    return () => {
      if (settled) return
      cancel()
      controller.abort()
    }
  }, [api, cache, queue, repo])

  // Sections near the viewport, as the browser reports them.
  useEffect(() => {
    const root = scrollRef.current
    if (root === null) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setEveryNear(true)
      return undefined
    }
    const observer = new IntersectionObserver(entries => {
      setNear(previous => {
        const next = new Set(previous)
        for (const entry of entries) {
          const key = entry.target.dataset.sectionKey
          if (entry.isIntersecting) next.add(key)
          else next.delete(key)
        }
        return next
      })
    }, { root, rootMargin: PRELOAD_MARGIN })
    observerRef.current = observer
    for (const element of elements.current.values()) observer.observe(element)
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [])

  /** Stable per-section element callbacks, so rerenders do not re-observe. */
  const bindElement = useMemo(() => {
    const callbacks = new Map()
    return key => {
      let callback = callbacks.get(key)
      if (callback === undefined) {
        callback = element => {
          const previous = elements.current.get(key)
          if (previous !== undefined && previous !== element) observerRef.current?.unobserve(previous)
          if (element === null) {
            elements.current.delete(key)
            return
          }
          elements.current.set(key, element)
          observerRef.current?.observe(element)
        }
        callbacks.set(key, callback)
      }
      return callback
    }
  }, [])

  /** Top offsets of the rendered sections, in stream order. */
  const sectionTops = useCallback(() => {
    const tops = []
    const keys = []
    for (const section of sections) {
      const element = elements.current.get(section.key)
      if (element === undefined) continue
      tops.push(element.offsetTop)
      keys.push(section.key)
    }
    return { tops, keys }
  }, [sections])

  /** Report the section being read and the offset inside it. */
  const report = useCallback(() => {
    const root = scrollRef.current
    if (root === null) return
    const { tops, keys } = sectionTops()
    const index = sectionAt(tops, root.scrollTop + 1)
    if (index < 0 || root.scrollTop + 1 < tops[0]) {
      onReading(keys.length === 0 ? null : { key: keys[0], offset: 0 })
      return
    }
    onReading({ key: keys[index], offset: Math.max(0, root.scrollTop - tops[index]) })
  }, [onReading, sectionTops])

  // Jumps requested by the navigation.
  useEffect(() => {
    control.current = {
      scrollTo(key) {
        const root = scrollRef.current
        const element = elements.current.get(key)
        if (root === null || element === undefined) return
        root.scrollTop = element.offsetTop
        report()
      },
      focus() {
        scrollRef.current?.focus()
      },
    }
    return () => { control.current = null }
  }, [control, report])

  // Restore the reading position once the sections exist.
  const restoredRef = useRef(false)
  useLayoutEffect(() => {
    if (restoredRef.current || sections.length === 0) return
    restoredRef.current = true
    const root = scrollRef.current
    const element = initialAnchor === null ? undefined : elements.current.get(initialAnchor.key)
    if (root !== null && element !== undefined) root.scrollTop = element.offsetTop + initialAnchor.offset
    report()
  }, [initialAnchor, report, sections.length])

  const frameRef = useRef(0)
  useEffect(() => () => { cancelAnimationFrame(frameRef.current) }, [])
  const onScroll = () => {
    if (frameRef.current !== 0) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      report()
    })
  }

  let previousGroup = null
  const children = []
  for (const section of sections) {
    if (groupLabels !== null && section.group !== previousGroup) {
      children.push(<h3 key={`group:${section.group}`} className="vcs-stream-group">{groupLabels[section.group]}</h3>)
    }
    previousGroup = section.group
    children.push(
      <Section
        key={section.key}
        section={section}
        near={everyNear || near.has(section.key)}
        folded={isFolded(section.key, defaults, folds)}
        foldReason={typeof folds?.[section.key] === 'boolean' ? 'user' : defaults.get(section.key)}
        onToggleFold={onToggleFold}
        request={request}
        revision={revision}
        split={split}
        wrap={wrap}
        bindElement={bindElement}
        t={t}
        locale={locale}
      />,
    )
  }

  return (
    <div
      ref={scrollRef}
      className="vcs-stream"
      role="region"
      aria-label={t('stream.label')}
      data-zone="stream"
      tabIndex={-1}
      onScroll={onScroll}
    >
      {before}
      {children}
    </div>
  )
}
