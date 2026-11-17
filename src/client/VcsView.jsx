/**
 * The version control view registered in `conversation.view`.
 *
 * One Session, one repository chooser, one timeline (the working tree, then
 * commits) and one detail pane for the selected node. Host data is read
 * through `api.js`; this component owns request lifecycle, selection, paging,
 * layout, and the sessionStorage-backed state.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createApi } from './api.js'
import {
  loadState, nodePatch, preferredNode, saveState, SIDEBAR_MAX, SIDEBAR_MIN, WORKTREE,
} from './state.js'
import { errorMessage, formatCount, syncMessage } from './format.js'
import { isEditableTarget } from './keys.js'
import { dirKey } from './detail/tree.js'
import { buildGraph } from './history/layout.js'
import { indexCommits } from './history/commits.js'
import { graphInput, headOf, nodeAt, pickRepository, rowOf } from './history/timeline.js'
import { ROW_HEIGHT, Timeline } from './history/Timeline.jsx'
import { DetailPane } from './detail/DetailPane.jsx'
import { TopBar } from './TopBar.jsx'
import { TimelineSkeleton, TreeSkeleton } from './skeleton.jsx'

/** Rows per history page. */
const PAGE_SIZE = 300
/** Reload when the panel becomes visible after this idle time. */
const STALE_MS = 30_000
/** Below this width the panel shows one column at a time. */
const NARROW_WIDTH = 760
/** Width of the divider between the timeline and the detail. */
const RESIZER_WIDTH = 5

/** Row-key prefix of the unstaged group, where untracked directories load. */
const UNSTAGED_PREFIX = 'unstaged|'

/** Empty status answer. */
function idleStatus() {
  return { status: 'idle', data: null, error: null }
}

/** Empty history answer. */
function idleLog() {
  return { status: 'idle', commits: [], error: null, truncated: false, hasMore: false, loadingMore: false }
}

/** Clamp a sidebar width. */
function clampWidth(value) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value))
}

/** Copy a record without one key. */
function omit(record, key) {
  const next = { ...(record ?? {}) }
  delete next[key]
  return next
}

/**
 * Render the version control view for one Session.
 * @param {{ sessionId: string, t: Function, locale?: string, viewRequest?: object, completeViewRequest?: Function }} props - standard Conversation view props plus the active UI locale.
 */
export function VcsView({ sessionId, t, locale, viewRequest, completeViewRequest }) {
  const [state, setState] = useState(() => loadState(sessionId))
  const stateRef = useRef(state)
  stateRef.current = state
  // Live reading positions: written on every scroll, persisted lazily.
  const anchorRef = useRef(state.anchor)
  const timelineScrollRef = useRef(state.timelineScroll)
  const persistTimer = useRef(null)

  const api = useMemo(() => createApi(sessionId), [sessionId])
  const [repositories, setRepositories] = useState({ status: 'loading', list: [], truncated: false, error: null })
  const [status, setStatus] = useState(idleStatus)
  const [log, setLog] = useState(idleLog)
  const [revision, setRevision] = useState(0)
  // The control whose refresh is waiting for status: 'refresh', 'sync', or null.
  const [refreshing, setRefreshing] = useState(null)
  const [width, setWidth] = useState(0)
  const [narrowDetail, setNarrowDetail] = useState(false)
  const [dirChildren, setDirChildren] = useState({})
  const [loadingDirs, setLoadingDirs] = useState({})
  // The top bar's message, right of the branch and sync: `{ tone: 'error' | 'info', text }`.
  const [notice, setNotice] = useState(null)
  // The repository a sync is running for; one sync at a time per panel.
  const [syncingRepo, setSyncingRepo] = useState(null)

  const rootRef = useRef(null)
  const logKeyRef = useRef('')
  const lastLoaded = useRef(0)
  const dragRef = useRef(null)
  const attemptedDirsRef = useRef(new Set())
  const perRepoRef = useRef(new Map())
  const pageControllerRef = useRef(null)
  const diffCacheRef = useRef(new Map())
  const detailControl = useRef(null)
  const pendingEntryFocusRef = useRef(false)
  const pendingDetailFocusRef = useRef(false)

  const narrow = width > 0 && width < NARROW_WIDTH
  const missingTool = status.status === 'error' && status.error?.code === 'vcs-missing'
  const showTimeline = !narrow || !narrowDetail
  const showDetail = !narrow || narrowDetail
  const repositoriesReady = repositories.status === 'ready'
  const repoInfo = repositories.list.find(entry => entry.path === state.repo) ?? null
  const capabilities = status.data?.capabilities ?? repoInfo?.capabilities ?? null
  const worktreeRow = capabilities?.workingCopy !== 'commit'
  const workingCopyNode = capabilities?.workingCopyNode ?? null

  /** The state as it should be stored, including the live reading positions. */
  const persisted = useCallback(() => ({
    ...stateRef.current,
    anchor: anchorRef.current,
    timelineScroll: timelineScrollRef.current,
  }), [])

  /** Persist reading positions a moment after the last scroll event. */
  const persistSoon = useCallback(() => {
    if (persistTimer.current !== null) return
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      saveState(sessionId, persisted())
    }, 300)
  }, [persisted, sessionId])

  // A Conversation View request (for example the turn-tail VCS icon) moves
  // focus into the panel after the view switches, then acknowledges it.
  useEffect(() => {
    if (viewRequest?.view !== 'vcs') return
    pendingEntryFocusRef.current = true
    rootRef.current?.focus({ preventScroll: true })
    completeViewRequest?.()
  }, [viewRequest, completeViewRequest])

  useEffect(() => () => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current)
    saveState(sessionId, persisted())
  }, [persisted, sessionId])

  useEffect(() => {
    saveState(sessionId, persisted())
  }, [persisted, sessionId, state])

  /** Update a slice of persisted state. */
  const update = useCallback(patch => {
    setState(previous => ({ ...previous, ...patch }))
  }, [])

  /** Move the selection; the patch also resets per-node reading state. */
  const selectNode = useCallback((node, chosen) => {
    if (chosen) pendingDetailFocusRef.current = false
    const patch = nodePatch(stateRef.current, node, chosen)
    if ('anchor' in patch) anchorRef.current = null
    if (Object.keys(patch).length > 0) update(patch)
  }, [update])

  /** Remember one repository's selection and restore the next one's. */
  const switchRepo = useCallback((nextRepo, nextCapabilities) => {
    pendingDetailFocusRef.current = false
    const current = stateRef.current
    if (current.repo !== null && current.repo !== nextRepo) {
      perRepoRef.current.set(current.repo, {
        node: current.node,
        nodeChosen: current.nodeChosen,
        dirs: current.dirs,
        collapsed: current.collapsed,
        ref: current.ref,
      })
    }
    const saved = nextRepo === null ? undefined : perRepoRef.current.get(nextRepo)
    const ranges = Array.isArray(nextCapabilities?.ranges) ? nextCapabilities.ranges : null
    const savedRef = saved?.ref
    const ref = ranges?.some(range => range.value === savedRef)
      ? savedRef
      : (nextCapabilities?.defaultRange ?? 'HEAD')
    setNarrowDetail(false)
    setNotice(null)
    setDirChildren({})
    setLoadingDirs({})
    attemptedDirsRef.current.clear()
    diffCacheRef.current.clear()
    setStatus(idleStatus())
    anchorRef.current = null
    timelineScrollRef.current = 0
    update({
      repo: nextRepo,
      node: saved?.node ?? null,
      nodeChosen: saved?.nodeChosen ?? false,
      dirs: saved?.dirs ?? {},
      collapsed: saved?.collapsed ?? {},
      folds: {},
      anchor: null,
      ref,
    })
  }, [update])

  // The persisted range belongs to one backend; a Jujutsu selection must not
  // start on `HEAD`, and a Git selection must not start on `@`.
  useEffect(() => {
    if (capabilities === null) return
    const ranges = Array.isArray(capabilities.ranges) ? capabilities.ranges : []
    if (ranges.length === 0 || ranges.some(range => range.value === state.ref)) return
    update({ ref: capabilities.defaultRange ?? ranges[0].value })
  }, [capabilities, state.ref, update])

  // Panel width decides the single-column layout.
  useLayoutEffect(() => {
    const element = rootRef.current
    if (element === null) return undefined
    const measure = () => { setWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // Repositories: reload on mount and explicit refresh.
  useEffect(() => {
    const controller = new AbortController()
    setRepositories(previous => ({ ...previous, status: previous.list.length === 0 ? 'loading' : 'ready', error: null }))
    api.repositories(controller.signal).then(answer => {
      if (controller.signal.aborted) return
      const list = Array.isArray(answer?.repositories) ? answer.repositories : []
      setRepositories({ status: 'ready', list, truncated: answer?.truncated === true, error: null })
      const previousRepo = stateRef.current.repo
      const nextEntry = pickRepository(list, previousRepo)
      const nextRepo = nextEntry?.path ?? null
      if (nextRepo !== previousRepo) switchRepo(nextRepo, nextEntry?.capabilities)
      if (list.length === 0) setRefreshing(null)
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      setRepositories({ status: 'error', list: [], truncated: false, error })
      setRefreshing(null)
    })
    return () => { controller.abort() }
  }, [api, revision, switchRepo])

  // Working-tree status for the chosen repository; it also settles the
  // default selection until the user picks a node.
  useEffect(() => {
    if (!repositoriesReady || state.repo === null) {
      setStatus(idleStatus())
      return undefined
    }
    const controller = new AbortController()
    setStatus(previous => ({
      status: previous.data === null ? 'loading' : 'refreshing',
      data: previous.data,
      error: null,
    }))
    api.status(state.repo, controller.signal).then(data => {
      if (controller.signal.aborted) return
      if (data === null || typeof data !== 'object') {
        setStatus(previous => ({ status: 'error', data: previous.data, error: null }))
        setRefreshing(null)
        return
      }
      setStatus({ status: 'ready', data, error: null })
      setRefreshing(null)
      lastLoaded.current = Date.now()
      const node = preferredNode(stateRef.current, data)
      if (node !== null && node !== stateRef.current.node) selectNode(node, false)
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      setStatus(previous => ({ status: 'error', data: previous.data, error }))
      setRefreshing(null)
    })
    return () => { controller.abort() }
  }, [api, repositoriesReady, state.repo, revision, selectNode])

  // Reset loaded history whenever the range changes.
  useEffect(() => {
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
    setLog(idleLog())
    logKeyRef.current = ''
  }, [state.repo, state.ref])

  useEffect(() => () => { pageControllerRef.current?.abort() }, [])

  // First history page, invalidated by refresh.
  useEffect(() => {
    if (!repositoriesReady || state.repo === null) return undefined
    if (capabilities !== null && Array.isArray(capabilities.ranges) && !capabilities.ranges.some(range => range.value === state.ref)) return undefined
    const key = `${state.repo}|${state.ref}|${revision}`
    if (logKeyRef.current === key) return undefined
    const controller = new AbortController()
    let settled = false
    setLog(previous => ({ ...previous, status: 'loading', error: null }))
    api.log(state.repo, { ref: state.ref, skip: 0, limit: PAGE_SIZE }, controller.signal).then(page => {
      if (controller.signal.aborted) return
      settled = true
      logKeyRef.current = key
      const commits = Array.isArray(page?.commits) ? page.commits : []
      setLog({
        status: 'ready',
        commits,
        error: null,
        truncated: page?.truncated === true,
        hasMore: commits.length >= PAGE_SIZE && page?.truncated !== true,
        loadingMore: false,
      })
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      logKeyRef.current = ''
      setLog({ ...idleLog(), status: 'error', error })
    })
    return () => {
      controller.abort()
      if (!settled && logKeyRef.current === key) logKeyRef.current = ''
    }
  }, [api, capabilities, repositoriesReady, state.repo, state.ref, revision])

  // Returning to the panel after a while refreshes once, without polling.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastLoaded.current < STALE_MS) return
      diffCacheRef.current.clear()
      setRevision(value => value + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // A different Session may reuse this component instance; reload its state.
  const sessionRef = useRef(sessionId)
  useEffect(() => {
    if (sessionRef.current === sessionId) return
    sessionRef.current = sessionId
    const restored = loadState(sessionId)
    anchorRef.current = restored.anchor
    timelineScrollRef.current = restored.timelineScroll
    logKeyRef.current = ''
    setState(restored)
    setStatus(idleStatus())
    setLog(idleLog())
    setRepositories({ status: 'loading', list: [], truncated: false, error: null })
    setDirChildren({})
    setLoadingDirs({})
    setNarrowDetail(false)
    setNotice(null)
    pendingEntryFocusRef.current = false
    pendingDetailFocusRef.current = false
    attemptedDirsRef.current.clear()
    perRepoRef.current.clear()
    diffCacheRef.current.clear()
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
  }, [sessionId])

  const head = worktreeRow ? headOf(status.data, log.commits, state.ref) : null
  const layout = useMemo(
    () => buildGraph(graphInput(log.commits, head, { worktreeRow })),
    [head, log.commits, worktreeRow],
  )
  const commitIndex = useMemo(
    () => indexCommits(log.commits, workingCopyNode),
    [log.commits, workingCopyNode],
  )
  const selectedRow = rowOf(commitIndex, state.node, { worktreeRow })
  const summary = state.node === null || state.node === WORKTREE
    ? null
    : log.commits[commitIndex.get(state.node)] ?? null
  const hasTimelineRows = worktreeRow || log.commits.length > 0
  const timelineSettled = hasTimelineRows || log.status === 'ready' || log.status === 'error'

  // Once the timeline mounts after a view-open request, hand focus from the
  // root shell to the active timeline row so movement keys work right away.
  useEffect(() => {
    if (!pendingEntryFocusRef.current) return
    if (repositories.status === 'loading') return
    if (repositories.status === 'ready' && state.repo === null && repositories.list.length > 0) return
    if (repositories.status !== 'ready' || state.repo === null || missingTool || !showTimeline) {
      pendingEntryFocusRef.current = false
      return
    }
    if (!timelineSettled) return
    pendingEntryFocusRef.current = false
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active !== null && active !== rootRef.current && active !== document.body) return
    const row = selectedRow >= 0 ? selectedRow : 0
    rootRef.current?.querySelector(`[data-timeline-index="${row}"]`)?.focus({ preventScroll: true })
  }, [missingTool, repositories.list.length, repositories.status, selectedRow, showTimeline, state.repo, timelineSettled])

  // When the default selection moves onto HEAD after status and history arrive,
  // keep an untouched timeline focus on the newly selected row.
  useEffect(() => {
    if (state.nodeChosen || selectedRow < 0 || !showTimeline) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active === null || active?.dataset?.timelineIndex === undefined) return
    if (active.dataset.timelineIndex === String(selectedRow)) return
    rootRef.current?.querySelector(`[data-timeline-index="${selectedRow}"]`)?.focus({ preventScroll: true })
  }, [selectedRow, showTimeline, state.nodeChosen])

  /**
   * Refresh repositories, status, history, and every open comparison.
   * `requester` names the control the wait belongs to, so its icon is the
   * one that turns.
   */
  const refresh = useCallback((requester = 'refresh') => {
    setRefreshing(requester)
    setNotice(null)
    setDirChildren({})
    setLoadingDirs({})
    attemptedDirsRef.current.clear()
    diffCacheRef.current.clear()
    setRevision(value => value + 1)
  }, [])

  /**
   * Sync the chosen repository's branch with its upstream, then refresh.
   * Refresh runs on failure too: the fetch may already have moved the
   * upstream, so the counts on the button change either way. The refresh is
   * the sync's own, so the sync icon keeps turning until the counts are back
   * instead of handing over to the refresh icon. The outcome is set after the
   * refresh, which clears notices.
   */
  const syncingRef = useRef(false)
  const sync = useCallback(async () => {
    const repo = stateRef.current.repo
    if (repo === null || syncingRef.current) return
    syncingRef.current = true
    setSyncingRepo(repo)
    setNotice(null)
    try {
      let outcome
      try {
        outcome = { tone: 'info', text: syncMessage(t, await api.sync(repo), locale) }
      } catch (error) {
        outcome = { tone: 'error', text: errorMessage(t, error) }
      }
      // The refresh takes over the wait before the sync lets go of it, so
      // the icon turns on without a gap whether or not the updates batch.
      if (sessionRef.current === sessionId && stateRef.current.repo === repo) {
        refresh('sync')
        setNotice(outcome)
      }
    } finally {
      syncingRef.current = false
      setSyncingRepo(null)
    }
  }, [api, locale, refresh, sessionId, t])

  /** Load the direct children of one untracked directory. */
  const expandUntracked = useCallback(async (key, path) => {
    if (state.repo === null) return
    const repo = state.repo
    attemptedDirsRef.current.add(key)
    setLoadingDirs(previous => ({ ...previous, [key]: true }))
    try {
      const answer = await api.untracked(repo, path)
      if (stateRef.current.repo !== repo) return
      const entries = Array.isArray(answer.entries) ? answer.entries : []
      setDirChildren(previous => ({ ...previous, [key]: entries }))
      if (answer.truncated === true) {
        setNotice({ tone: 'error', text: t('changes.untrackedTruncated', { count: formatCount(entries.length, locale) }) })
      }
    } catch (error) {
      if (error?.name === 'AbortError') return
      if (stateRef.current.repo !== repo) return
      update({ dirs: omit(stateRef.current.dirs, key) })
      setNotice({ tone: 'error', text: errorMessage(t, error) })
    } finally {
      setLoadingDirs(previous => omit(previous, key))
    }
  }, [api, state.repo, t, locale, update])

  // Re-open persisted untracked directories once their repository's status is
  // known. The directories live in the unstaged group now; a path that is no
  // longer an untracked directory is simply dropped.
  useEffect(() => {
    if (state.repo === null || status.data === null) return
    const loadable = new Set(
      (status.data.groups?.untracked ?? [])
        .filter(entry => entry.directory === true)
        .map(entry => dirKey('unstaged', entry.path)),
    )
    for (const key of Object.keys(state.dirs)) {
      if (!key.startsWith(UNSTAGED_PREFIX)) continue
      if (!loadable.has(key)) continue
      if (dirChildren[key] !== undefined || loadingDirs[key] === true) continue
      if (attemptedDirsRef.current.has(key)) continue
      void expandUntracked(key, `${key.slice(UNSTAGED_PREFIX.length)}/`)
    }
  }, [state.repo, state.dirs, status.data, dirChildren, loadingDirs, expandUntracked])

  /** Toggle a group or directory row; an untracked directory loads on open. */
  const toggleRow = useCallback(row => {
    const key = row.key
    if (row.loadable === true) {
      if (row.expanded) {
        update({ dirs: omit(stateRef.current.dirs, key) })
        return
      }
      update({ dirs: { ...stateRef.current.dirs, [key]: true } })
      if (dirChildren[key] === undefined && loadingDirs[key] !== true) void expandUntracked(key, row.path)
      return
    }
    if (row.expanded) update({ collapsed: { ...stateRef.current.collapsed, [key]: true } })
    else update({ collapsed: omit(stateRef.current.collapsed, key) })
  }, [dirChildren, expandUntracked, loadingDirs, update])

  /** Fold or unfold one diff section against its default. */
  const toggleFold = useCallback((key, folded) => {
    update({ folds: { ...stateRef.current.folds, [key]: folded } })
  }, [update])

  /** Focus one timeline row once React has painted it. */
  const focusTimelineRow = useCallback(index => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rootRef.current?.querySelector(`[data-timeline-index="${index}"]`)?.focus()
      })
    })
  }, [])

  /** Choose the node on one timeline row. */
  const selectRow = useCallback(index => {
    const node = nodeAt(log.commits, index, { worktreeRow, workingCopyNode })
    if (node === null) return
    selectNode(node, true)
    if (narrow) setNarrowDetail(true)
  }, [log.commits, narrow, selectNode, worktreeRow, workingCopyNode])

  /** Keyboard movement along the timeline; the selection follows the cursor. */
  const moveTimeline = useCallback(delta => {
    const next = selectedRow < 0 ? 0 : selectedRow + delta
    const node = next < 0 ? null : nodeAt(log.commits, next, { worktreeRow, workingCopyNode })
    if (node === null) return
    selectNode(node, true)
    focusTimelineRow(next)
  }, [focusTimelineRow, log.commits, selectNode, selectedRow, worktreeRow, workingCopyNode])

  /** Move the keyboard into the selected node's files, or wait while they load. */
  const openDetail = useCallback(() => {
    pendingDetailFocusRef.current = true
    if (narrow) setNarrowDetail(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!pendingDetailFocusRef.current) return
        if (detailControl.current?.focusNav() === true) {
          pendingDetailFocusRef.current = false
          return
        }
        const active = typeof document === 'undefined' ? null : document.activeElement
        if (narrow && (active === null || active === document.body || !rootRef.current?.contains(active))) {
          rootRef.current?.focus({ preventScroll: true })
        }
      })
    })
  }, [narrow])

  /** Complete a deferred detail focus once the selected node's rows arrive. */
  const onDetailSettled = useCallback(hasRows => {
    if (!pendingDetailFocusRef.current) return
    pendingDetailFocusRef.current = false
    if (!hasRows) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active !== null && active !== document.body && rootRef.current !== null && !rootRef.current.contains(active)) {
      return
    }
    if (isEditableTarget(active)) return
    detailControl.current?.focusNav()
  }, [])

  /** Return the keyboard to the timeline, closing the narrow detail. */
  const leaveDetail = useCallback(() => {
    pendingDetailFocusRef.current = false
    if (narrow) setNarrowDetail(false)
    focusTimelineRow(selectedRow < 0 ? 0 : selectedRow)
  }, [focusTimelineRow, narrow, selectedRow])

  /** Jump to a loaded commit named in the detail, such as a parent. */
  const selectCommit = useCallback(sha => {
    selectNode(sha, true)
    const index = commitIndex.get(sha)
    if (index !== undefined && !narrow) focusTimelineRow(index + (worktreeRow ? 1 : 0))
  }, [commitIndex, focusTimelineRow, narrow, selectNode, worktreeRow])

  // Read through a ref so the detail's request effects do not restart on every status answer.
  const statusDataRef = useRef(null)
  statusDataRef.current = status.data

  /** A selected commit vanished (amend, rebase): fall back to the default. */
  const onMissing = useCallback(() => {
    const node = preferredNode({ node: null, nodeChosen: false }, statusDataRef.current)
    selectNode(node ?? (worktreeRow ? WORKTREE : workingCopyNode), false)
  }, [selectNode, worktreeRow, workingCopyNode])

  const onReading = useCallback(anchor => {
    anchorRef.current = anchor
    persistSoon()
  }, [persistSoon])

  /** Load the next history page. */
  const loadMore = useCallback(async () => {
    if (state.repo === null || log.loadingMore || !log.hasMore) return
    const repo = state.repo
    const ref = state.ref
    pageControllerRef.current?.abort()
    const controller = new AbortController()
    pageControllerRef.current = controller
    setLog(previous => ({ ...previous, loadingMore: true }))
    try {
      const page = await api.log(repo, { ref, skip: log.commits.length, limit: PAGE_SIZE }, controller.signal)
      if (controller.signal.aborted) return
      if (stateRef.current.repo !== repo || stateRef.current.ref !== ref) return
      const commits = Array.isArray(page?.commits) ? page.commits : []
      setLog(previous => ({
        ...previous,
        loadingMore: false,
        commits: [...previous.commits, ...commits],
        truncated: page?.truncated === true,
        hasMore: commits.length >= PAGE_SIZE && page?.truncated !== true,
      }))
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      if (stateRef.current.repo !== repo || stateRef.current.ref !== ref) return
      setLog(previous => ({ ...previous, loadingMore: false }))
      setNotice({ tone: 'error', text: errorMessage(t, error) })
    } finally {
      if (pageControllerRef.current === controller) pageControllerRef.current = null
    }
  }, [api, log.commits.length, log.hasMore, log.loadingMore, state.repo, state.ref, t])

  /** Escape closes the narrow detail from anywhere inside it. */
  const onKeyDown = event => {
    if (event.key !== 'Escape' || !narrow || !narrowDetail) return
    if (isEditableTarget(event.target)) return
    event.preventDefault()
    leaveDetail()
  }

  /** Drag the sidebar divider. */
  const startResize = event => {
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // A synthetic or already-released pointer simply skips capture.
    }
    dragRef.current = { x: event.clientX, width: state.sidebarWidth }
  }
  const resize = event => {
    if (dragRef.current === null) return
    update({ sidebarWidth: clampWidth(dragRef.current.width + event.clientX - dragRef.current.x) })
  }
  const stopResize = () => { dragRef.current = null }

  if (repositories.status === 'error') {
    const missing = repositories.error?.code === 'vcs-missing'
    return (
      <div className="vcs-root" data-conversation-composer-overlay="" ref={rootRef} tabIndex={-1}>
        <div className="vcs-center">
          <p className="vcs-empty-title">{missing ? t('error.vcsMissing') : t('repositories.error')}</p>
          <p className="vcs-note">{missing ? t('error.vcsMissingHint') : errorMessage(t, repositories.error)}</p>
          <button type="button" className="vcs-button" onClick={refresh}>{t('error.retry')}</button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="vcs-root"
      data-narrow={narrow ? 'true' : undefined}
      data-conversation-composer-overlay=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <TopBar
        repositories={repositories.list}
        repo={state.repo}
        onRepoChange={repo => {
          const entry = repositories.list.find(candidate => candidate.path === repo)
          switchRepo(repo, entry?.capabilities)
        }}
        status={status.data}
        capabilities={capabilities}
        refMode={state.ref}
        onRefMode={ref => { update({ ref }) }}
        onRefresh={() => { refresh() }}
        refreshing={refreshing === 'refresh'}
        revalidating={status.status === 'refreshing'}
        onSync={() => { void sync() }}
        syncing={(syncingRepo !== null && syncingRepo === state.repo) || refreshing === 'sync'}
        notice={notice}
        t={t}
        locale={locale}
      />
      {repositories.truncated ? <p className="vcs-note">{t('repositories.truncated', { count: formatCount(repositories.list.length, locale) })}</p> : null}
      {repositories.status === 'loading' ? (
        // Nothing is known yet, not even the backend: draw both columns as
        // they will be, so the panel settles in place instead of popping in.
        <div className="vcs-main">
          <section
            className="vcs-sidebar vcs-sidebar-loading"
            style={narrow ? undefined : { width: `${state.sidebarWidth}px` }}
          >
            <TimelineSkeleton rowHeight={ROW_HEIGHT} label={t('loading.repositories')} />
          </section>
          {narrow ? null : <section className="vcs-content"><TreeSkeleton /></section>}
        </div>
      ) : state.repo === null ? (
        <div className="vcs-center">
          <p className="vcs-empty-title">{t('empty.repository')}</p>
          <p className="vcs-note">{t('empty.repositoryHint')}</p>
        </div>
      ) : missingTool ? (
        <div className="vcs-center">
          <p className="vcs-empty-title">{t('error.vcsMissing')}</p>
          <p className="vcs-note">{t('error.vcsMissingHint')} {errorMessage(t, status.error)}</p>
          <button type="button" className="vcs-button" onClick={refresh}>{t('error.retry')}</button>
        </div>
      ) : (
        <div className="vcs-main">
          {showTimeline ? (
            <section className="vcs-sidebar" style={narrow ? undefined : { width: `${state.sidebarWidth}px` }}>
              <Timeline
                key={`${state.repo}|${state.ref}`}
                commits={log.commits}
                layout={layout}
                status={status.data}
                statusState={status.status}
                worktreeRow={worktreeRow}
                selectedRow={selectedRow}
                onSelectRow={selectRow}
                onMove={moveTimeline}
                onOpen={openDetail}
                t={t}
                locale={locale}
                loading={log.status === 'loading'}
                loadingMore={log.loadingMore}
                error={log.error}
                hasMore={log.hasMore}
                truncated={log.truncated}
                onLoadMore={() => { void loadMore() }}
                onRetry={refresh}
                initialScrollTop={timelineScrollRef.current}
                onScrollOffset={top => {
                  timelineScrollRef.current = top
                  persistSoon()
                }}
              />
            </section>
          ) : null}
          {!narrow ? (
            <div
              className="vcs-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('panel.resize')}
              aria-valuenow={state.sidebarWidth}
              aria-valuemin={SIDEBAR_MIN}
              aria-valuemax={SIDEBAR_MAX}
              tabIndex={0}
              onPointerDown={startResize}
              onPointerMove={resize}
              onPointerUp={stopResize}
              onPointerCancel={stopResize}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                update({ sidebarWidth: clampWidth(state.sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16)) })
              }}
            />
          ) : null}
          {showDetail ? (
            <section className="vcs-content">
              {state.node === null ? (
                <TreeSkeleton label={t('changes.loading')} />
              ) : (
                <DetailPane
                  key={`${state.repo}|${state.node}`}
                  api={api}
                  repo={state.repo}
                  node={state.node}
                  summary={summary}
                  status={status.data}
                  statusState={status.status}
                  statusError={status.error}
                  dirChildren={dirChildren}
                  loadingDirs={loadingDirs}
                  dirs={state.dirs}
                  collapsed={state.collapsed}
                  onToggleDir={toggleRow}
                  folds={state.folds}
                  onToggleFold={toggleFold}
                  onSetFolds={folds => { update({ folds }) }}
                  split={state.split}
                  wrap={state.wrap}
                  onToggleSplit={split => { update({ split }) }}
                  onToggleWrap={wrap => { update({ wrap }) }}
                  narrow={narrow}
                  onBack={leaveDetail}
                  onLeaveNav={leaveDetail}
                  onSelectCommit={selectCommit}
                  isLoaded={sha => commitIndex.has(sha)}
                  onMissing={onMissing}
                  onSettled={onDetailSettled}
                  revision={revision}
                  cache={diffCacheRef.current}
                  initialAnchor={anchorRef.current}
                  onReading={onReading}
                  control={detailControl}
                  capabilities={capabilities}
                  t={t}
                  locale={locale}
                />
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
