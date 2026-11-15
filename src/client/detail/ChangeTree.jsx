/**
 * The change tree: one node's files as collapsible rows, where a file row is
 * also the header of its comparison.
 *
 * A file asks for its comparison only when it comes near the viewport, and a
 * shared queue keeps a few requests in flight; a file that scrolls away before
 * its turn never reaches the Host. Until its comparison arrives the file holds
 * an estimated height, so the scroll height settles early. The group row and
 * the expanded file row stick above the body they belong to, so the reader
 * always knows which group and file own the next hunk.
 *
 * Keyboard and scroll share one cursor: moving the cursor scrolls the row into
 * view, while the wheel, the trackpad or paging move the cursor to the row
 * being read. Neither overrides the other.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileDiff } from '../diff/FileDiff.jsx'
import { formatCount, lineCounts, splitPath, statusKey } from '../format.js'
import { BACK, DOWN, FORWARD, hunkStep, movement, UP } from '../keys.js'
import { Chevron, Spinner } from '../ui.jsx'
import {
  MAX_PARALLEL, changedLines, diffTarget, estimateHeight, isFolded, nextFileRow, rowAt,
} from './detail.js'
import { createQueue } from './queue.js'
import { rowBodyId } from './tree.js'

/** Distance beyond the viewport at which a file starts loading. */
const PRELOAD_MARGIN = '800px 0px'

/** Comparisons kept across nodes and refreshes of the same revision. */
const CACHE_LIMIT = 300

/** Height of one tree row and of one expanded file header, in CSS pixels. */
const ROW_HEIGHT = 28

/** Indentation per tree level, in CSS pixels. */
const INDENT = 14

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

/** The localized reason a folded file gives, when the default rules folded it. */
function foldedText(reason, entry, t, locale) {
  if (reason === 'large') return t('stream.foldedLarge', { count: formatCount(changedLines(entry), locale) })
  if (reason === 'budget') return t('stream.foldedBudget')
  return t('stream.folded')
}

/**
 * Keys a reading position may fall back to when its exact row is not rendered,
 * from the row itself up to its group row.
 * @param {string} key - a row key.
 * @returns {string[]} candidate keys, nearest first.
 */
function ancestorKeys(key) {
  const candidates = [key]
  const bar = key.indexOf('|')
  if (bar < 0) return candidates
  const group = key.slice(0, bar + 1)
  let path = key.slice(bar + 1)
  while (path.includes('/')) {
    path = path.slice(0, path.lastIndexOf('/'))
    candidates.push(`${group}${path}`)
  }
  candidates.push(group)
  return candidates
}

/**
 * One file's comparison, or the reason it is folded.
 *
 * The comparison is requested when the file is both unfolded and near the
 * viewport. A placeholder holds the estimated height until then, so rows below
 * do not jump when the answer arrives.
 */
const FileBody = memo(function FileBody({
  fileKey, entry, target, near, folded, foldReason, request, revision,
  split, wrap, onLoaded, t, locale,
}) {
  const [answer, setAnswer] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (folded || target === null || !near) return undefined
    if (answer !== null && answer.revision === revision && answer.attempt === attempt) return undefined
    // The previous answer stays on screen until the new one arrives.
    return request(target, revision, result => {
      setAnswer({ ...result, revision, attempt })
      onLoaded(fileKey, result)
    })
    // `answer` is read only to skip work that already finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded, near, revision, attempt, request, onLoaded, fileKey, targetKey(target ?? {})])

  if (folded) {
    if (foldReason === undefined) return null
    return <p className="vcs-tree-folded">{foldedText(foldReason, entry, t, locale)}</p>
  }
  if (answer === null) {
    return (
      <div className="vcs-tree-placeholder" style={{ height: `${estimateHeight(entry)}px` }}>
        <FileDiff state="loading" split={split} wrap={wrap} retry={() => undefined} t={t} locale={locale} />
      </div>
    )
  }
  const state = answer.status === 'ready' ? answer.diff : answer.status
  return (
    <FileDiff
      state={state}
      split={split}
      wrap={wrap}
      retry={() => { setAttempt(value => value + 1) }}
      t={t}
      locale={locale}
    />
  )
})

/**
 * Render the change tree of one node.
 * @param {object} props - rows, expansion data, and panel state.
 */
export function ChangeTree({
  api, repo, rev, rows, defaults, folds, split, wrap, revision, cache,
  initialAnchor, onReading, onToggleRow, onBulkFold, onLeave, control, before = null, t, locale,
}) {
  const scrollRef = useRef(null)
  const rowEls = useRef(new Map())
  const bodyEls = useRef(new Map())
  const sectionEls = useRef(new Map())
  const loadedRef = useRef(new Map())
  const observerRef = useRef(null)
  const frameRef = useRef(0)
  const pendingPreserve = useRef(null)
  const pendingAlign = useRef(null)
  const refreshAnchor = useRef(null)
  const restoredRef = useRef(false)
  const lastInputRef = useRef('scroll')
  const queue = useMemo(() => createQueue(MAX_PARALLEL), [])
  const [near, setNear] = useState(() => new Map())
  const [everyNear, setEveryNear] = useState(false)
  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(0)
  const readingRef = useRef(initialAnchor?.key ?? null)
  const [readingKey, setReadingKey] = useState(initialAnchor?.key ?? null)

  const navRows = useMemo(() => rows.filter(row => row.kind !== 'loading'), [rows])
  const grouped = useMemo(() => rows.some(row => row.kind === 'group'), [rows])
  const navIndexByKey = useMemo(() => {
    const index = new Map()
    navRows.forEach((row, at) => index.set(row.key, at))
    return index
  }, [navRows])
  const cursorKey = navRows[Math.max(0, Math.min(cursor, navRows.length - 1))]?.key ?? null

  /** Whether one file row is folded under the current rules. */
  const isRowFolded = useCallback(row => isFolded(row.key, defaults, folds), [defaults, folds])

  const setCursorAt = useCallback(index => {
    cursorRef.current = index
    setCursor(index)
  }, [])

  /** The top offset of one element inside the scrolling tree. */
  const flowTop = useCallback(element => {
    const root = scrollRef.current
    if (element === null || element === undefined || root === null) return 0
    let top = 0
    let node = element
    while (node !== null && node !== root) {
      top += node.offsetTop
      node = node.offsetParent
    }
    return top
  }, [])

  /** The tree top a row is aligned to, leaving the sticky rows in view. */
  const alignmentTop = useCallback(row => {
    if (!grouped) return 0
    return row.kind === 'group' ? 0 : ROW_HEIGHT
  }, [grouped])

  /** A stable ref callback per row key, so rerenders do not rebind. */
  const bindRow = useMemo(() => {
    const callbacks = new Map()
    return key => {
      let callback = callbacks.get(key)
      if (callback === undefined) {
        callback = element => {
          if (element === null) rowEls.current.delete(key)
          else rowEls.current.set(key, element)
        }
        callbacks.set(key, callback)
      }
      return callback
    }
  }, [])

  /** A stable ref callback per file body; hunk headers are looked up there. */
  const bindBody = useMemo(() => {
    const callbacks = new Map()
    return key => {
      let callback = callbacks.get(key)
      if (callback === undefined) {
        callback = element => {
          if (element === null) bodyEls.current.delete(key)
          else bodyEls.current.set(key, element)
        }
        callbacks.set(key, callback)
      }
      return callback
    }
  }, [])

  /** A stable ref callback per file section, observed for loading. */
  const bindSection = useMemo(() => {
    const callbacks = new Map()
    return key => {
      let callback = callbacks.get(key)
      if (callback === undefined) {
        callback = element => {
          const previous = sectionEls.current.get(key)
          if (previous !== undefined) observerRef.current?.unobserve(previous)
          if (element === null) {
            sectionEls.current.delete(key)
            return
          }
          sectionEls.current.set(key, element)
          observerRef.current?.observe(element)
        }
        callbacks.set(key, callback)
      }
      return callback
    }
  }, [])

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

  const onLoaded = useCallback((key, result) => {
    loadedRef.current.set(key, result)
  }, [])

  // A new revision invalidates which comparisons the tree considers loaded.
  useEffect(() => { loadedRef.current.clear() }, [revision])

  // Files near the viewport, as the browser reports them.
  useEffect(() => {
    const root = scrollRef.current
    if (root === null) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setEveryNear(true)
      return undefined
    }
    const observer = new IntersectionObserver(entries => {
      setNear(previous => {
        const next = new Map(previous)
        for (const entry of entries) {
          const key = entry.target.dataset.fileKey
          if (key === undefined) continue
          next.set(key, entry.isIntersecting)
        }
        return next
      })
    }, { root, rootMargin: PRELOAD_MARGIN })
    observerRef.current = observer
    for (const element of sectionEls.current.values()) observer.observe(element)
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [])

  // The cursor stays inside the rendered rows.
  useEffect(() => {
    if (navRows.length === 0) {
      if (cursorRef.current !== 0) setCursorAt(0)
      return
    }
    if (cursorRef.current > navRows.length - 1) setCursorAt(navRows.length - 1)
  }, [navRows, setCursorAt])

  /** The row index of one key, falling back to its nearest rendered ancestor. */
  const indexOfKey = useCallback(key => {
    if (key === null) return -1
    for (const candidate of ancestorKeys(key)) {
      const index = navIndexByKey.get(candidate)
      if (index !== undefined) return index
    }
    return -1
  }, [navIndexByKey])

  /** Report the row being read and the offset below its top. */
  const report = useCallback(() => {
    const root = scrollRef.current
    if (root === null) return
    const tops = []
    const keys = []
    for (const row of navRows) {
      const element = rowEls.current.get(row.key)
      if (element === undefined) continue
      keys.push(row.key)
      tops.push(flowTop(element))
    }
    if (keys.length === 0) {
      readingRef.current = null
      setReadingKey(null)
      onReading(null)
      return
    }
    const offset = root.scrollTop + 1
    if (offset < tops[0]) {
      readingRef.current = null
      setReadingKey(null)
      onReading(null)
      return
    }
    const index = rowAt(tops, offset)
    const key = keys[index]
    readingRef.current = key
    setReadingKey(previous => (previous === key ? previous : key))
    onReading({ key, offset: Math.max(0, root.scrollTop - tops[index]) })
  }, [flowTop, navRows, onReading])

  /** Align one row below the sticky rows, but only when it is out of view. */
  const scrollRowIntoView = useCallback(index => {
    const root = scrollRef.current
    const row = navRows[index]
    if (root === null || row === undefined) return
    const element = rowEls.current.get(row.key)
    if (element === undefined) return
    const top = flowTop(element)
    const alignment = alignmentTop(row)
    const viewTop = root.scrollTop + alignment
    const viewBottom = root.scrollTop + root.clientHeight
    if (top < viewTop || top + ROW_HEIGHT > viewBottom) {
      root.scrollTop = Math.max(0, top - alignment)
    }
  }, [alignmentTop, flowTop, navRows])

  /** Focus one row without letting the browser scroll it again. */
  const focusRowElement = useCallback(key => {
    rowEls.current.get(key)?.focus({ preventScroll: true })
  }, [])

  /** Move the keyboard cursor to one row. */
  const focusRowAt = useCallback(index => {
    const row = navRows[index]
    if (row === undefined) return
    setCursorAt(index)
    scrollRowIntoView(index)
    focusRowElement(row.key)
  }, [focusRowElement, navRows, scrollRowIntoView, setCursorAt])

  const move = useCallback(delta => {
    if (navRows.length === 0) return
    lastInputRef.current = 'keyboard'
    const base = Math.max(0, Math.min(cursorRef.current, navRows.length - 1))
    focusRowAt(Math.max(0, Math.min(base + delta, navRows.length - 1)))
  }, [focusRowAt, navRows.length])

  /** Whether one row currently shows the content below it. */
  const isExpanded = useCallback(row => (row.kind === 'file' ? !isRowFolded(row) : row.expanded), [isRowFolded])

  /**
   * Collapse or expand one row. A file head that has already scrolled past its
   * sticky slot keeps that slot when it collapses, so the next file takes over
   * right below it instead of the reader being pushed back up.
   */
  const toggle = useCallback((row, expanded) => {
    lastInputRef.current = 'keyboard'
    if (row.kind === 'file' && expanded) {
      const root = scrollRef.current
      const element = rowEls.current.get(row.key)
      if (root !== null && element !== undefined && flowTop(element) <= root.scrollTop + alignmentTop(row)) {
        pendingAlign.current = { key: row.key, alignment: alignmentTop(row) }
      }
    }
    onToggleRow(row, !expanded)
  }, [alignmentTop, flowTop, onToggleRow])

  /** `→` / `l`: expand a collapsed row, or step into an expanded group or directory. */
  const forward = useCallback(() => {
    const index = Math.max(0, Math.min(cursorRef.current, navRows.length - 1))
    const row = navRows[index]
    if (row === undefined) return
    lastInputRef.current = 'keyboard'
    if (!isExpanded(row)) {
      onToggleRow(row, true)
      return
    }
    if (row.kind !== 'group' && row.kind !== 'dir') return
    const child = navRows[index + 1]
    if (child === undefined) return
    const inside = row.kind === 'group' ? child.kind !== 'group' : child.depth > row.depth
    if (inside) focusRowAt(index + 1)
  }, [focusRowAt, isExpanded, navRows, onToggleRow])

  /** Top offsets of the hunk headers inside one file's comparison. */
  const hunkOffsets = useCallback(row => {
    const body = bodyEls.current.get(row.key)
    if (body === undefined) return []
    const tops = new Set()
    for (const header of body.querySelectorAll('[data-diff-hunk-header]')) tops.add(flowTop(header))
    // A side-by-side comparison draws one header per column; they align, and
    // the set keeps one offset per hunk in ascending order.
    return [...tops].sort((a, b) => a - b)
  }, [flowTop])

  /** Scroll to one hunk of a file; stop on the file row when it has no hunks yet. */
  const scrollToFileHunk = useCallback((index, direction) => {
    const root = scrollRef.current
    const row = navRows[index]
    if (root === null || row === undefined) return
    const element = rowEls.current.get(row.key)
    if (element === undefined) return
    const stickyBottom = (grouped ? ROW_HEIGHT : 0) + ROW_HEIGHT
    const offsets = hunkOffsets(row)
    setCursorAt(index)
    focusRowElement(row.key)
    lastInputRef.current = 'keyboard'
    const target = offsets.length === 0
      ? flowTop(element) - alignmentTop(row)
      : (direction > 0 ? offsets[0] : offsets[offsets.length - 1]) - stickyBottom
    root.scrollTop = Math.max(0, target)
    report()
  }, [alignmentTop, flowTop, focusRowElement, grouped, hunkOffsets, navRows, report, setCursorAt])

  /** `]` / `[`: step to the next or previous hunk, crossing files and skipping folded ones. */
  const jumpHunk = useCallback(direction => {
    const root = scrollRef.current
    if (root === null || navRows.length === 0) return
    lastInputRef.current = 'keyboard'
    const stickyBottom = (grouped ? ROW_HEIGHT : 0) + ROW_HEIGHT
    const line = root.scrollTop + stickyBottom
    const tops = []
    for (const row of navRows) {
      const element = rowEls.current.get(row.key)
      tops.push(element === undefined ? Number.POSITIVE_INFINITY : flowTop(element))
    }
    const index = rowAt(tops, line + 1)
    const row = navRows[index]
    if (row !== undefined && row.kind === 'file' && !isRowFolded(row)) {
      const offsets = hunkOffsets(row)
      let current = -1
      for (let at = 0; at < offsets.length; at += 1) {
        if (offsets[at] <= line) current = at
        else break
      }
      const target = offsets[current + direction]
      if (target !== undefined) {
        setCursorAt(index)
        focusRowElement(row.key)
        root.scrollTop = Math.max(0, target - stickyBottom)
        report()
        return
      }
      // Hunks inside an unloaded comparison are unknown; stay on its header.
      if (!loadedRef.current.has(row.key)) {
        scrollToFileHunk(index, direction)
        return
      }
    }
    const targetIndex = nextFileRow(navRows, index, direction, isRowFolded)
    if (targetIndex >= 0) scrollToFileHunk(targetIndex, direction)
  }, [focusRowElement, flowTop, grouped, hunkOffsets, isRowFolded, navRows, report, scrollToFileHunk, setCursorAt])

  const onKeyDown = event => {
    const target = event.target
    if (target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT' || target.isContentEditable)) return
    if (event.isComposing === true) return
    const step = hunkStep(event)
    if (step !== 0) {
      event.preventDefault()
      jumpHunk(step)
      return
    }
    const direction = movement(event)
    if (direction === DOWN) {
      event.preventDefault()
      move(1)
      return
    }
    if (direction === UP) {
      event.preventDefault()
      move(-1)
      return
    }
    if (direction === FORWARD) {
      event.preventDefault()
      forward()
      return
    }
    if (direction === BACK || event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onLeave()
      return
    }
    // Paging keys scroll the tree themselves; the cursor follows the reading row.
    if (event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'Home' || event.key === 'End') {
      lastInputRef.current = 'scroll'
    }
  }

  // Wheel and trackpad scrolling is the user moving the reading position.
  useEffect(() => {
    const root = scrollRef.current
    if (root === null) return undefined
    const markScrolled = () => { lastInputRef.current = 'scroll' }
    root.addEventListener('wheel', markScrolled, { passive: true })
    root.addEventListener('touchmove', markScrolled, { passive: true })
    return () => {
      root.removeEventListener('wheel', markScrolled)
      root.removeEventListener('touchmove', markScrolled)
    }
  }, [])

  const onScroll = () => {
    if (frameRef.current !== 0) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      report()
      if (lastInputRef.current !== 'scroll') return
      const key = readingRef.current
      if (key === null) return
      const index = navIndexByKey.get(key)
      if (index !== undefined && index !== cursorRef.current) setCursorAt(index)
    })
  }

  // A refresh reloads the node's data; remember the reading row so the same
  // row can be shown again once the new rows arrive.
  useEffect(() => {
    if (!restoredRef.current) return
    const root = scrollRef.current
    const key = readingRef.current
    if (root === null || key === null) return
    const element = rowEls.current.get(key)
    refreshAnchor.current = {
      key,
      offset: element === undefined ? 0 : Math.max(0, root.scrollTop - flowTop(element)),
      rows,
    }
  }, [revision, flowTop]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const pending = refreshAnchor.current
    if (pending === null || rows === pending.rows) return
    refreshAnchor.current = null
    const root = scrollRef.current
    if (root === null) return
    const index = indexOfKey(pending.key)
    const row = index < 0 ? undefined : navRows[index]
    const element = row === undefined ? undefined : rowEls.current.get(row.key)
    if (element !== undefined) {
      root.scrollTop = Math.max(0, flowTop(element) + (row.key === pending.key ? pending.offset : 0))
    }
    report()
  }, [flowTop, indexOfKey, navRows, report, rows])

  // Restore the reading position once the rows exist.
  useLayoutEffect(() => {
    if (restoredRef.current || navRows.length === 0) return
    restoredRef.current = true
    const root = scrollRef.current
    if (root === null || initialAnchor === null) {
      report()
      return
    }
    const index = indexOfKey(initialAnchor.key)
    const row = index < 0 ? undefined : navRows[index]
    const element = row === undefined ? undefined : rowEls.current.get(row.key)
    if (element !== undefined) {
      const exact = row.key === initialAnchor.key
      root.scrollTop = flowTop(element) + (exact ? initialAnchor.offset : 0)
    }
    setCursorAt(index >= 0 ? index : 0)
    report()
  }, [flowTop, indexOfKey, initialAnchor, navRows, report])

  // Rows changed: re-report the reading row so folding never leaves it stale.
  useLayoutEffect(() => {
    report()
  }, [report])

  // The tree's own width can change without the rows changing (window resize).
  useEffect(() => {
    const root = scrollRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { report() })
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [report])

  useEffect(() => () => { cancelAnimationFrame(frameRef.current) }, [])

  /** Save the cursor row's screen position, run one change, then restore it. */
  const preserve = useCallback(callback => {
    const root = scrollRef.current
    const row = navRows[Math.max(0, Math.min(cursorRef.current, navRows.length - 1))]
    const element = row === undefined ? undefined : rowEls.current.get(row.key)
    pendingPreserve.current = root === null || element === undefined
      ? null
      : { key: row.key, screenTop: flowTop(element) - root.scrollTop }
    callback()
  }, [flowTop, navRows])

  useLayoutEffect(() => {
    const pending = pendingPreserve.current
    if (pending === null) return
    pendingPreserve.current = null
    const root = scrollRef.current
    const element = rowEls.current.get(pending.key)
    if (root === null || element === undefined) return
    root.scrollTop = Math.max(0, flowTop(element) - pending.screenTop)
  })

  // Keep a just-collapsed file head in the slot it held while stuck.
  useLayoutEffect(() => {
    const pending = pendingAlign.current
    if (pending === null) return
    pendingAlign.current = null
    const root = scrollRef.current
    const element = rowEls.current.get(pending.key)
    if (root === null || element === undefined) return
    root.scrollTop = Math.max(0, flowTop(element) - pending.alignment)
    report()
  })

  /** Expose the tree's focus and bulk-fold hooks to the detail pane. */
  useEffect(() => {
    control.current = {
      focusReading() {
        if (navRows.length === 0) return
        const index = indexOfKey(readingRef.current)
        const target = index >= 0 ? index : Math.max(0, Math.min(cursorRef.current, navRows.length - 1))
        focusRowAt(target)
      },
      bulkFold(mode) {
        preserve(() => { onBulkFold(mode) })
      },
    }
    return () => { control.current = null }
  }, [control, focusRowAt, indexOfKey, navRows.length, onBulkFold, preserve])

  /** The click handler every row shares: move the cursor and flip the row. */
  const activateRow = (row, expanded) => {
    const index = navIndexByKey.get(row.key)
    if (index !== undefined) setCursorAt(index)
    toggle(row, expanded)
  }

  const indentOf = depth => `${8 + (depth + (grouped ? 1 : 0)) * INDENT}px`
  const totalStat = (added, deleted) => (
    <span className="vcs-tree-stat">
      {added > 0 ? <span className="vcs-add">+{formatCount(added, locale)}</span> : null}
      {deleted > 0 ? <span className="vcs-del">−{formatCount(deleted, locale)}</span> : null}
    </span>
  )
  const fileStat = entry => {
    if (entry.status === '?') return null
    if (entry.binary === true) return <span className="vcs-tree-stat vcs-dim">{t('changes.binary')}</span>
    const counts = lineCounts(entry)
    return (
      <span className="vcs-tree-stat">
        {counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added, locale)}</span> : null}
        {counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted, locale)}</span> : null}
      </span>
    )
  }
  const rowProps = row => ({
    'data-row-key': row.key,
    tabIndex: row.key === cursorKey ? 0 : -1,
    ref: bindRow(row.key),
  })
  const renderLoading = row => (
    <div
      key={`loading:${row.key}`}
      className="vcs-tree-row vcs-tree-loading"
      role="status"
      style={{ paddingLeft: indentOf(row.depth) }}
    >
      <Spinner label={t('changes.loadingDirectory')} />
      <span className="vcs-dim">{t('changes.loadingDirectory')}</span>
    </div>
  )
  const renderGroup = (row, children) => {
    const bodyId = rowBodyId(row.key)
    return (
      <div key={row.key} className="vcs-tree-group">
        <button
          type="button"
          className="vcs-tree-row vcs-tree-group-head"
          aria-expanded={row.expanded}
          aria-controls={bodyId}
          aria-current={readingKey === row.key ? 'location' : undefined}
          style={{ paddingLeft: '8px' }}
          {...rowProps(row)}
          onClick={() => { activateRow(row, row.expanded) }}
        >
          <Chevron open={row.expanded} />
          <span className="vcs-tree-group-name">{t(`changes.${row.group}`)}</span>
          <span className="vcs-tree-spacer" />
          <span className="vcs-tree-stat vcs-dim">{t('detail.fileCount', { count: formatCount(row.count, locale) })}</span>
          {totalStat(row.added, row.deleted)}
        </button>
        <div className="vcs-tree-group-body" id={bodyId}>{children}</div>
      </div>
    )
  }
  const renderDir = (row, children) => {
    const bodyId = rowBodyId(row.key)
    return (
      <div key={row.key} className="vcs-tree-dir">
        <button
          type="button"
          className="vcs-tree-row vcs-tree-dir-head"
          aria-expanded={row.expanded}
          aria-controls={bodyId}
          aria-current={readingKey === row.key ? 'location' : undefined}
          title={row.path}
          style={{ paddingLeft: indentOf(row.depth) }}
          {...rowProps(row)}
          onClick={() => { activateRow(row, row.expanded) }}
        >
          <Chevron open={row.expanded} />
          {row.loadable
            ? (
              <>
                <span className="vcs-status vcs-status-?" aria-hidden="true">?</span>
                <span className="vcs-sr-only">{t('status.untracked')}</span>
              </>
            )
            : null}
          <span className="vcs-tree-dir-name">{row.name}</span>
        </button>
        <div className="vcs-tree-dir-body" id={bodyId}>{children}</div>
      </div>
    )
  }
  const renderFile = row => {
    const expanded = !isRowFolded(row)
    const foldReason = typeof folds?.[row.key] === 'boolean' ? undefined : defaults.get(row.key)
    const parts = splitPath(row.entry.path)
    const bodyId = rowBodyId(row.key)
    return (
      <section
        key={row.key}
        className="vcs-tree-file"
        data-file-key={row.key}
        ref={bindSection(row.key)}
      >
        <div className="vcs-tree-file-head-wrap" data-open={expanded ? 'true' : undefined}>
          <button
            type="button"
            className="vcs-tree-row vcs-tree-file-head"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-current={readingKey === row.key ? 'location' : undefined}
            title={row.entry.origPath === undefined ? row.path : `${row.entry.origPath} → ${row.path}`}
            style={{ paddingLeft: indentOf(row.depth) }}
            {...rowProps(row)}
            onClick={() => { activateRow(row, expanded) }}
          >
            <Chevron open={expanded} />
            <span className={`vcs-status vcs-status-${row.entry.status}`} aria-hidden="true">{row.entry.status}</span>
            <span className="vcs-sr-only">{t(statusKey(row.entry.status))}</span>
            <span className="vcs-tree-file-name">
              {row.entry.origPath === undefined
                ? null
                : <span className="vcs-dim">{splitPath(row.entry.origPath).base} →</span>}
              <strong>{row.name}</strong>
              {expanded && parts.dir !== '' ? <span className="vcs-tree-parent vcs-dim">{parts.dir}</span> : null}
            </span>
            <span className="vcs-tree-spacer" />
            {fileStat(row.entry)}
          </button>
        </div>
        <div className="vcs-tree-file-body" id={bodyId} ref={bindBody(row.key)}>
          <FileBody
            fileKey={row.key}
            entry={row.entry}
            target={diffTarget(row.group, row.entry, rev)}
            near={everyNear || near.get(row.key) === true}
            folded={!expanded}
            foldReason={foldReason}
            request={request}
            revision={revision}
            split={split}
            wrap={wrap}
            onLoaded={onLoaded}
            t={t}
            locale={locale}
          />
        </div>
      </section>
    )
  }

  /** Render the flat row list as nested row groups. */
  const renderRows = () => {
    const renderRange = (from, to) => {
      const elements = []
      let index = from
      while (index < to) {
        const row = rows[index]
        if (row.kind === 'file') {
          elements.push(renderFile(row))
          index += 1
          continue
        }
        if (row.kind === 'loading') {
          elements.push(renderLoading(row))
          index += 1
          continue
        }
        let end = index + 1
        if (row.kind === 'group') {
          while (end < to && rows[end].kind !== 'group') end += 1
        } else {
          while (end < to && rows[end].kind !== 'group' && rows[end].depth > row.depth) end += 1
        }
        const children = renderRange(index + 1, end)
        elements.push(row.kind === 'group' ? renderGroup(row, children) : renderDir(row, children))
        index = end
      }
      return elements
    }
    return renderRange(0, rows.length)
  }

  return (
    <div
      ref={scrollRef}
      className="vcs-tree"
      data-grouped={grouped ? 'true' : undefined}
      role="region"
      aria-label={t('tree.label')}
      data-zone="tree"
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      {before}
      {renderRows()}
    </div>
  )
}
