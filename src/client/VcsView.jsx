/**
 * The version control panel, drawn as a right-Sidebar tab.
 *
 * One Session, one repository chooser, one timeline (the working tree, then
 * commits) and one detail pane for the selected node. Host data is read
 * through `api.js`; this component owns request lifecycle, selection, paging,
 * layout, and the sessionStorage-backed state. `focusRequest` moves keyboard
 * focus into the selected timeline row after the Sidebar host has focused its
 * pane.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createApi } from './api.js'
import {
  loadState, nodePatch, preferredNode, saveState, SIDEBAR_MAX, SIDEBAR_MIN, WORKTREE,
} from './state.js'
import {
  branchOpMessage, commitOpMessage, errorMessage, formatCount, shortSha, switchMessage, syncMessage, tagOpMessage,
} from './format.js'
import { isEditableTarget } from './keys.js'
import { dirKey } from './detail/tree.js'
import { buildGraph } from './history/layout.js'
import { indexCommits } from './history/commits.js'
import { graphInput, headOf, nodeAt, pickRepository, rowOf } from './history/timeline.js'
import { ROW_HEIGHT, Timeline } from './history/Timeline.jsx'
import { DetailPane } from './detail/DetailPane.jsx'
import { TopBar } from './TopBar.jsx'
import { RefActionsMenu } from './RefActionsMenu.jsx'
import { BranchDialog } from './BranchDialogs.jsx'
import { TagDialog } from './TagDialog.jsx'
import { CommitDialog } from './CommitDialog.jsx'
import { branchActions, remoteBranchActions } from './branch.js'
import { tagActions } from './tag.js'
import { commitActions } from './commit.js'
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

/** Empty remote listing for the tag push dialog. */
function idleRemotes() {
  return { status: 'idle', list: [], truncated: false, error: null }
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
 * Render the version control panel for one Session.
 * @param {{ sessionId: string, t: Function, locale?: string, focusRequest?: number }} props - standard Sidebar tab props plus the active UI locale and a one-shot request to land keyboard focus in the panel.
 */
export function VcsView({
  sessionId, t, locale, focusRequest = 0,
}) {
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
  // Local branches for the header menu, loaded when the menu opens.
  const [branches, setBranches] = useState({ status: 'idle', list: [], truncated: false, error: null })
  // The branch a switch is running for, which keeps the branch icon turning.
  const [switching, setSwitching] = useState(null)
  // The branch action a dialog or the menu is asking for: rename, delete,
  // merge, rebase, or push. Its own state keeps the icon turning and the
  // dialog disabled while the Host works.
  const [branchBusy, setBranchBusy] = useState(null)
  // The open branch dialog and the failure it shows; a refused rename keeps
  // the input, and an unmerged delete escalates to "delete anyway".
  const [branchDialog, setBranchDialog] = useState(null)
  const [branchDialogError, setBranchDialogError] = useState(null)
  // The open branch actions menu: `{ kind, name, current, actions, x, y }`.
  // It is owned here so the header and the timeline ref badges share one menu.
  const [branchMenu, setBranchMenu] = useState(null)
  // The tag action a dialog is running, its open dialog and failure, and the
  // remotes the push dialog can choose from. Tag writes keep the dialog open
  // with the error instead of reporting in the header.
  const [tagBusy, setTagBusy] = useState(null)
  const [tagDialog, setTagDialog] = useState(null)
  const [tagDialogError, setTagDialogError] = useState(null)
  const [tagRemotes, setTagRemotes] = useState(idleRemotes)
  // The open tag actions menu: `{ kind: 'tag', name, actions, x, y }`.
  const [tagMenu, setTagMenu] = useState(null)
  // The commit action a dialog is running, its open dialog and failure, and
  // the open commit menu. A failed commit action stays in its dialog.
  const [commitBusy, setCommitBusy] = useState(null)
  const [commitDialog, setCommitDialog] = useState(null)
  const [commitDialogError, setCommitDialogError] = useState(null)
  const [commitMenu, setCommitMenu] = useState(null)
  // Bumped after the Sidebar host focuses its pane, so the settle effect retries.
  const [focusTick, setFocusTick] = useState(0)

  const rootRef = useRef(null)
  const logKeyRef = useRef('')
  const lastLoaded = useRef(0)
  const dragRef = useRef(null)
  const attemptedDirsRef = useRef(new Set())
  const perRepoRef = useRef(new Map())
  const pageControllerRef = useRef(null)
  const branchesControllerRef = useRef(null)
  const loadingBranchesRef = useRef(false)
  const switchingRef = useRef(false)
  const branchBusyRef = useRef(false)
  const tagBusyRef = useRef(false)
  const commitBusyRef = useRef(false)
  // The control the branch, tag, or commit actions menu is acting for, focused
  // again after the menu or its dialog closes.
  const branchMenuReturnRef = useRef(null)
  const tagMenuReturnRef = useRef(null)
  const commitMenuReturnRef = useRef(null)
  const tagRemotesControllerRef = useRef(null)
  const diffCacheRef = useRef(new Map())
  const detailControl = useRef(null)
  const pendingEntryFocusRef = useRef(false)
  const pendingDetailFocusRef = useRef(false)
  // A focus request waits for the Sidebar host to focus its pane first.
  const hostFocusPendingRef = useRef(false)

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

  // A Sidebar open leaves focus on the pane it focused. Wait two frames for
  // that focus, then let the settle effect move on to the selected row.
  useEffect(() => {
    if (focusRequest === 0) return undefined
    pendingEntryFocusRef.current = true
    hostFocusPendingRef.current = true
    let second
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        // The host's pane focus is in place by now; let the settle effect
        // move on from it.
        hostFocusPendingRef.current = false
        setFocusTick(value => value + 1)
      })
    })
    return () => {
      cancelAnimationFrame(first)
      if (second !== undefined) cancelAnimationFrame(second)
    }
  }, [focusRequest])

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
    branchesControllerRef.current?.abort()
    branchesControllerRef.current = null
    loadingBranchesRef.current = false
    setBranches({ status: 'idle', list: [], truncated: false, error: null })
    setBranchBusy(null)
    setBranchDialog(null)
    setBranchDialogError(null)
    setBranchMenu(null)
    branchMenuReturnRef.current = null
    tagRemotesControllerRef.current?.abort()
    tagRemotesControllerRef.current = null
    tagBusyRef.current = false
    setTagBusy(null)
    setTagDialog(null)
    setTagDialogError(null)
    setTagRemotes(idleRemotes())
    setTagMenu(null)
    tagMenuReturnRef.current = null
    commitBusyRef.current = false
    setCommitBusy(null)
    setCommitDialog(null)
    setCommitDialogError(null)
    setCommitMenu(null)
    commitMenuReturnRef.current = null
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

  useEffect(() => () => {
    pageControllerRef.current?.abort()
    branchesControllerRef.current?.abort()
    tagRemotesControllerRef.current?.abort()
  }, [])

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
    setBranches({ status: 'idle', list: [], truncated: false, error: null })
    setSwitching(null)
    setBranchBusy(null)
    setBranchDialog(null)
    setBranchDialogError(null)
    setBranchMenu(null)
    branchMenuReturnRef.current = null
    tagRemotesControllerRef.current?.abort()
    tagRemotesControllerRef.current = null
    tagBusyRef.current = false
    setTagBusy(null)
    setTagDialog(null)
    setTagDialogError(null)
    setTagRemotes(idleRemotes())
    setTagMenu(null)
    tagMenuReturnRef.current = null
    commitBusyRef.current = false
    setCommitBusy(null)
    setCommitDialog(null)
    setCommitDialogError(null)
    setCommitMenu(null)
    commitMenuReturnRef.current = null
    loadingBranchesRef.current = false
    branchesControllerRef.current?.abort()
    branchesControllerRef.current = null
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

  // Once the timeline mounts after an open request, hand focus from the host
  // focused pane to the active timeline row so movement keys work right away.
  useEffect(() => {
    if (!pendingEntryFocusRef.current) return
    // A Sidebar request waits two frames for the host to focus its pane.
    if (hostFocusPendingRef.current) return
    if (repositories.status === 'loading') return
    if (repositories.status === 'ready' && state.repo === null && repositories.list.length > 0) return
    if (repositories.status !== 'ready' || state.repo === null || missingTool || !showTimeline) {
      pendingEntryFocusRef.current = false
      return
    }
    if (!timelineSettled) return
    pendingEntryFocusRef.current = false
    const active = typeof document === 'undefined' ? null : document.activeElement
    // The Sidebar host focuses the pane, not the panel; that is the handoff
    // this request was waiting for, so move on from it. Any other focus is a
    // user's own choice and is left alone.
    const hostPane = focusRequest > 0 && active?.matches?.('[data-dockkit-pane], [data-dockkit-float]') === true
    if (active !== null && active !== rootRef.current && active !== document.body && !hostPane) return
    const row = selectedRow >= 0 ? selectedRow : 0
    rootRef.current?.querySelector(`[data-timeline-index="${row}"]`)?.focus({ preventScroll: true })
  }, [focusRequest, focusTick, missingTool, repositories.list.length, repositories.status, selectedRow, showTimeline, state.repo, timelineSettled])

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
    if (repo === null || syncingRef.current || branchBusyRef.current || tagBusyRef.current || commitBusyRef.current || switchingRef.current) return
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

  /**
   * Load the local branches behind the header menu. Opening the menu again
   * reloads: branches are created and renamed outside the panel, and the
   * current one is part of the answer. The previous list stays visible while
   * the reload runs.
   */
  const loadBranches = useCallback(() => {
    const repo = stateRef.current.repo
    if (repo === null || loadingBranchesRef.current) return
    loadingBranchesRef.current = true
    branchesControllerRef.current?.abort()
    const controller = new AbortController()
    branchesControllerRef.current = controller
    setBranches(previous => ({ ...previous, status: 'loading', error: null }))
    api.branches(repo, controller.signal).then(answer => {
      if (controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      const list = Array.isArray(answer?.branches)
        ? answer.branches.filter(entry => entry !== null && typeof entry === 'object'
          && typeof entry.name === 'string' && entry.name !== '')
        : []
      setBranches({
        status: 'ready',
        list: list.map(entry => ({ name: entry.name, current: entry.current === true })),
        truncated: answer?.truncated === true,
        error: null,
      })
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      setBranches(previous => ({ status: 'error', list: previous.list, truncated: false, error }))
    }).finally(() => {
      if (branchesControllerRef.current === controller) {
        branchesControllerRef.current = null
        loadingBranchesRef.current = false
      }
    })
  }, [api])

  /**
   * Drop everything that described the old HEAD after a checkout: selection,
   * folds, directory expansions, reading position, and the diff cache. Status
   * then picks the new head's default node, exactly as after a refresh.
   */
  const resetReadingForNewHead = useCallback(() => {
    anchorRef.current = null
    timelineScrollRef.current = 0
    setDirChildren({})
    setLoadingDirs({})
    attemptedDirsRef.current.clear()
    diffCacheRef.current.clear()
    update({ node: null, nodeChosen: false, anchor: null, folds: {}, collapsed: {}, dirs: {} })
  }, [update])

  /**
   * Check out one local branch, then drop everything that described the old
   * HEAD: selection, folds, directory expansions, reading position, and the
   * diff cache. Status then picks the new branch's default node, exactly as
   * after an ordinary refresh. A refused switch changes nothing and only
   * reports why.
   */
  const switchBranch = useCallback(async branch => {
    const repo = stateRef.current.repo
    if (repo === null || switchingRef.current || branchBusyRef.current || tagBusyRef.current || commitBusyRef.current || syncingRef.current) return
    switchingRef.current = true
    setSwitching(branch)
    setNotice(null)
    // A listing that started before the switch describes the old HEAD.
    branchesControllerRef.current?.abort()
    branchesControllerRef.current = null
    loadingBranchesRef.current = false
    let outcome
    try {
      const answer = await api.switchBranch(repo, branch)
      outcome = { tone: 'info', text: switchMessage(t, answer, branch) }
    } catch (error) {
      outcome = { tone: 'error', text: errorMessage(t, error) }
    } finally {
      switchingRef.current = false
      setSwitching(null)
    }
    if (stateRef.current.repo !== repo) return
    if (outcome.tone !== 'info') {
      setNotice(outcome)
      return
    }

    resetReadingForNewHead()
    setBranches({ status: 'idle', list: [], truncated: false, error: null })
    refresh('switch')
    setNotice(outcome)
  }, [api, refresh, resetReadingForNewHead, t])

  /** Put keyboard focus back on the branch control after a dialog. */
  const focusBranchControl = useCallback(() => {
    requestAnimationFrame(() => {
      rootRef.current?.querySelector('.vcs-branch-button')?.focus()
    })
  }, [])

  /**
   * Return focus to the row, badge, or header button that opened the branch
   * menu. A timeline row may have been re-rendered or removed by the action;
   * the panel's branch control is the fallback.
   */
  const restoreBranchFocus = useCallback(() => {
    const element = branchMenuReturnRef.current
    branchMenuReturnRef.current = null
    requestAnimationFrame(() => {
      if (element !== null && element?.isConnected === true) element.focus()
      else focusBranchControl()
    })
  }, [focusBranchControl])

  /**
   * Open the branch actions menu for one local or remote-tracking branch.
   * `entry` is a branch listing row, a timeline branch badge, or a timeline
   * remote badge carrying its split remote and branch. The point is where the
   * menu opens, and the return element gets focus when the menu or its dialog
   * closes.
   */
  const openBranchActions = useCallback((entry, point, returnElement) => {
    const info = status.data?.branch
    const currentBranch = info !== undefined && info !== null
      && info.detached !== true && info.unborn !== true && typeof info.name === 'string'
      ? info.name
      : null
    const remote = entry.kind === 'remote'
    if (remote && (typeof entry.remote !== 'string' || typeof entry.branch !== 'string')) return
    branchMenuReturnRef.current = returnElement ?? null
    setBranchMenu({
      kind: remote ? 'remote' : 'branch',
      name: entry.name,
      remote: remote ? entry.remote : undefined,
      shortBranch: remote ? entry.branch : undefined,
      current: remote ? false : entry.current === true,
      actions: remote
        ? remoteBranchActions({ currentBranch })
        : branchActions({ current: entry.current === true, currentBranch }),
      x: point.clientX,
      y: point.clientY,
    })
  }, [status.data])

  /** Close the shared branch actions menu. */
  const closeBranchActions = useCallback(restoreFocus => {
    setBranchMenu(null)
    if (restoreFocus) restoreBranchFocus()
    else branchMenuReturnRef.current = null
  }, [restoreBranchFocus])

  /**
   * Open the confirmation for one branch action. Rename asks for a name;
   * delete, merge, and rebase state what will happen first. The current branch
   * is read here so merge and rebase name it without a second request.
   */
  const openBranchDialog = useCallback((kind, branch, extra = {}) => {
    const info = status.data?.branch
    const current = info !== undefined && info !== null
      && info.detached !== true && info.unborn !== true && typeof info.name === 'string'
      ? info.name
      : null
    setBranchDialog({ kind, branch, current, ...extra })
    setBranchDialogError(null)
  }, [status.data])

  /**
   * Run one branch action, then refresh. Merge, rebase, delete, and push can
   * change refs or the working tree, so the timeline and status are read
   * again; a refused action leaves the dialog open with its error, while a
   * refused push reports in the header because it starts from the menu.
   */
  const runBranchAction = useCallback(async (action, branch, options = {}) => {
    const repo = stateRef.current.repo
    if (repo === null || branchBusyRef.current || tagBusyRef.current || commitBusyRef.current || switchingRef.current || syncingRef.current) return
    branchBusyRef.current = true
    setBranchBusy(action)
    setBranchDialogError(null)
    setNotice(null)
    let outcome
    let failed = false
    try {
      const answer = await api.branchOp(repo, action, { branch, ...options })
      outcome = { tone: 'info', text: branchOpMessage(t, action, branch, answer) }
    } catch (error) {
      failed = true
      outcome = { tone: 'error', text: errorMessage(t, error) }
      if (stateRef.current.repo === repo) setBranchDialogError(error)
    } finally {
      branchBusyRef.current = false
      setBranchBusy(null)
    }
    if (stateRef.current.repo !== repo) return
    if (failed) {
      if (action === 'push') setNotice(outcome)
      return
    }
    setBranchDialog(null)
    setBranchDialogError(null)
    // The branch list names and marks may be stale; the menu reloads on open.
    setBranches({ status: 'idle', list: [], truncated: false, error: null })
    // A remote checkout moves HEAD exactly as a local switch does.
    if (action === 'checkout-remote') resetReadingForNewHead()
    refresh('branch')
    setNotice(outcome)
    // Checkout and push already restored focus when their menu closed; a
    // dialog keeps it until the write is finished.
    if (action !== 'push') restoreBranchFocus()
  }, [api, refresh, resetReadingForNewHead, t, restoreBranchFocus])

  /**
   * Dispatch one action chosen from the shared menu. A dialog keeps the
   * opener's focus until it closes; a direct action returns focus right away.
   */
  const chooseBranchAction = useCallback(action => {
    const target = branchMenu
    if (target === null) return
    setBranchMenu(null)
    if (target.kind === 'remote') {
      openBranchDialog(
        action,
        target.name,
        action === 'checkout-remote'
          ? { remote: target.remote, local: target.shortBranch }
          : { remote: target.remote },
      )
      return
    }
    if (action === 'checkout' || action === 'push') {
      restoreBranchFocus()
      if (action === 'checkout') void switchBranch(target.name)
      else void runBranchAction('push', target.name)
      return
    }
    openBranchDialog(action, target.name)
  }, [branchMenu, openBranchDialog, restoreBranchFocus, runBranchAction, switchBranch])

  /**
   * Return focus to the badge or row that opened the tag menu. A refresh may
   * have rebuilt the row; the timeline's current row is the fallback.
   */
  const restoreTagFocus = useCallback(() => {
    const element = tagMenuReturnRef.current
    tagMenuReturnRef.current = null
    requestAnimationFrame(() => {
      if (element !== null && element?.isConnected === true) {
        element.focus({ preventScroll: true })
        return
      }
      const root = rootRef.current
      const row = root?.querySelector('.vcs-timeline-row[aria-current="true"]')
        ?? root?.querySelector('.vcs-timeline-row')
      row?.focus({ preventScroll: true })
    })
  }, [])

  /** Open the tag actions menu for one tag badge. */
  const openTagActions = useCallback((reference, point, returnElement) => {
    if (capabilities?.tagOps !== true) return
    tagMenuReturnRef.current = returnElement ?? null
    setTagMenu({
      kind: 'tag',
      name: reference.name,
      actions: tagActions(),
      x: point.clientX,
      y: point.clientY,
    })
  }, [capabilities])

  /** Close the shared tag actions menu. */
  const closeTagActions = useCallback(restoreFocus => {
    setTagMenu(null)
    if (restoreFocus) restoreTagFocus()
    else tagMenuReturnRef.current = null
  }, [restoreTagFocus])

  /**
   * Load the remotes the push dialog offers. The previous request is dropped
   * when the dialog closes; a failed load stays in the dialog with its error.
   */
  const loadTagRemotes = useCallback(() => {
    const repo = stateRef.current.repo
    if (repo === null) return
    tagRemotesControllerRef.current?.abort()
    const controller = new AbortController()
    tagRemotesControllerRef.current = controller
    setTagRemotes({ status: 'loading', list: [], truncated: false, error: null })
    api.remotes(repo, controller.signal).then(answer => {
      if (controller.signal.aborted || stateRef.current.repo !== repo) return
      const list = Array.isArray(answer?.remotes)
        ? answer.remotes.filter(name => typeof name === 'string' && name !== '')
        : []
      setTagRemotes({
        status: 'ready',
        list,
        truncated: answer?.truncated === true,
        error: null,
      })
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      setTagRemotes({ status: 'error', list: [], truncated: false, error })
    }).finally(() => {
      if (tagRemotesControllerRef.current === controller) tagRemotesControllerRef.current = null
    })
  }, [api])

  /** Open the confirmation for one tag action; push also loads its remotes. */
  const openTagDialog = useCallback((kind, tag) => {
    setTagDialog({ kind, tag })
    setTagDialogError(null)
    setTagRemotes(idleRemotes())
    if (kind === 'push') loadTagRemotes()
  }, [loadTagRemotes])

  /**
   * Run one tag action, then refresh. Both actions change refs, so the
   * timeline and status are read again; a refused action leaves the dialog
   * open with its error so the user can retry or cancel.
   */
  const runTagAction = useCallback(async (action, tag, options = {}) => {
    const repo = stateRef.current.repo
    if (repo === null || tagBusyRef.current || branchBusyRef.current || commitBusyRef.current || switchingRef.current || syncingRef.current) return
    tagBusyRef.current = true
    setTagBusy(action)
    setTagDialogError(null)
    setNotice(null)
    let outcome
    let failed = false
    try {
      const answer = await api.tagOp(repo, action, { tag, ...options })
      outcome = { tone: 'info', text: tagOpMessage(t, action, tag, answer) }
    } catch (error) {
      failed = true
      outcome = { tone: 'error', text: errorMessage(t, error) }
      if (stateRef.current.repo === repo) setTagDialogError(error)
    } finally {
      tagBusyRef.current = false
      setTagBusy(null)
    }
    if (stateRef.current.repo !== repo) return
    if (failed) return
    setTagDialog(null)
    setTagDialogError(null)
    setTagRemotes(idleRemotes())
    refresh('tag')
    setNotice(outcome)
    restoreTagFocus()
  }, [api, refresh, t, restoreTagFocus])

  /** Dispatch one action chosen from the tag menu. */
  const chooseTagAction = useCallback(action => {
    const target = tagMenu
    if (target === null) return
    setTagMenu(null)
    openTagDialog(action, target.name)
  }, [openTagDialog, tagMenu])

  /**
   * Right-click on a branch or tag ref in the timeline opens the same menu
   * the corresponding header control uses.
   */
  const onTimelineRefActions = useCallback((reference, event, returnElement) => {
    if (reference.kind === 'branch' && capabilities?.branchOps === true) {
      event.preventDefault()
      event.stopPropagation()
      openBranchActions(reference, event, returnElement)
    } else if (reference.kind === 'remote' && capabilities?.branchOps === true) {
      if (typeof reference.remote !== 'string' || typeof reference.branch !== 'string') return
      event.preventDefault()
      event.stopPropagation()
      openBranchActions(reference, event, returnElement)
    } else if (reference.kind === 'tag' && capabilities?.tagOps === true) {
      event.preventDefault()
      event.stopPropagation()
      openTagActions(reference, event, returnElement)
    }
  }, [capabilities, openBranchActions, openTagActions])

  /** Submit the open branch dialog. */
  const confirmBranchDialog = useCallback(values => {
    if (branchDialog === null) return
    void runBranchAction(branchDialog.kind, branchDialog.branch, values)
  }, [branchDialog, runBranchAction])

  /** Close the branch dialog without writing anything. */
  const cancelBranchDialog = useCallback(() => {
    if (branchBusyRef.current) return
    setBranchDialog(null)
    setBranchDialogError(null)
    restoreBranchFocus()
  }, [restoreBranchFocus])

  /** Submit the open tag dialog. */
  const confirmTagDialog = useCallback(values => {
    if (tagDialog === null) return
    void runTagAction(tagDialog.kind, tagDialog.tag, values)
  }, [tagDialog, runTagAction])

  /** Close the tag dialog without writing anything. */
  const cancelTagDialog = useCallback(() => {
    if (tagBusyRef.current) return
    tagRemotesControllerRef.current?.abort()
    tagRemotesControllerRef.current = null
    setTagDialog(null)
    setTagDialogError(null)
    setTagRemotes(idleRemotes())
    restoreTagFocus()
  }, [restoreTagFocus])

  /** Return focus to the row that opened the commit menu or its dialog. */
  const restoreCommitFocus = useCallback(() => {
    const element = commitMenuReturnRef.current
    commitMenuReturnRef.current = null
    requestAnimationFrame(() => {
      if (element !== null && element?.isConnected === true) {
        element.focus({ preventScroll: true })
        return
      }
      const root = rootRef.current
      const row = root?.querySelector('.vcs-timeline-row[aria-current="true"]')
        ?? root?.querySelector('.vcs-timeline-row')
      row?.focus({ preventScroll: true })
    })
  }, [])

  /** Open the commit actions menu for one timeline commit. */
  const openCommitActions = useCallback((commit, point, returnElement) => {
    if (capabilities?.commitOps !== true) return
    const info = status.data?.branch
    const currentBranch = info !== undefined && info !== null
      && info.detached !== true && info.unborn !== true && typeof info.name === 'string'
      ? info.name
      : null
    const head = typeof info?.oid === 'string' && info.oid !== '' ? info.oid : null
    commitMenuReturnRef.current = returnElement ?? null
    setCommitMenu({
      kind: 'commit',
      name: shortSha(commit.sha),
      detail: commit.subject ?? '',
      sha: commit.sha,
      subject: commit.subject ?? '',
      actions: commitActions({ commit, currentBranch, head }),
      x: point.clientX,
      y: point.clientY,
    })
  }, [capabilities, status.data])

  /** Close the shared commit actions menu. */
  const closeCommitActions = useCallback(restoreFocus => {
    setCommitMenu(null)
    if (restoreFocus) restoreCommitFocus()
    else commitMenuReturnRef.current = null
  }, [restoreCommitFocus])

  /** Open the dialog for one commit action. */
  const openCommitDialog = useCallback((kind, target) => {
    const info = status.data?.branch
    const current = info !== undefined && info !== null
      && info.detached !== true && info.unborn !== true && typeof info.name === 'string'
      ? info.name
      : null
    setCommitDialog({
      kind,
      sha: target.sha,
      shortSha: shortSha(target.sha),
      current,
      subject: target.subject ?? '',
    })
    setCommitDialogError(null)
  }, [status.data])

  /**
   * Run one commit action, then refresh. Checkout and a hard reset drop the
   * old reading state; the other actions keep it and let a rewritten node fall
   * back through the detail's `onMissing`. A refused action stays in its
   * dialog with the error.
   */
  const runCommitAction = useCallback(async (action, target, values = {}) => {
    const repo = stateRef.current.repo
    if (repo === null || commitBusyRef.current || tagBusyRef.current || branchBusyRef.current
      || switchingRef.current || syncingRef.current) return
    commitBusyRef.current = true
    setCommitBusy(action)
    setCommitDialogError(null)
    setNotice(null)
    let outcome
    let failed = false
    try {
      const answer = await api.commitOp(repo, action, { sha: target.sha, ...values })
      outcome = { tone: 'info', text: commitOpMessage(t, action, target, answer) }
    } catch (error) {
      failed = true
      outcome = { tone: 'error', text: errorMessage(t, error) }
      if (stateRef.current.repo === repo) setCommitDialogError(error)
    } finally {
      commitBusyRef.current = false
      setCommitBusy(null)
    }
    if (stateRef.current.repo !== repo) return
    if (failed) return
    setCommitDialog(null)
    setCommitDialogError(null)
    setBranches({ status: 'idle', list: [], truncated: false, error: null })
    if (action === 'checkout' || (action === 'reset' && values.mode === 'hard')) {
      resetReadingForNewHead()
    }
    refresh('commit')
    setNotice(outcome)
    restoreCommitFocus()
  }, [api, refresh, resetReadingForNewHead, restoreCommitFocus, t])

  /** Dispatch one action chosen from the commit menu. */
  const chooseCommitAction = useCallback(action => {
    const target = commitMenu
    if (target === null) return
    setCommitMenu(null)
    // The menu names its two ref-creating actions by their visible result;
    // the Host and dialog use the same names as the other tag and branch writes.
    const kind = action === 'add-tag' ? 'tag' : action === 'create-branch' ? 'branch' : action
    openCommitDialog(kind, target)
  }, [commitMenu, openCommitDialog])

  /** Right-click or Shift+F10 on a timeline row opens its commit menu. */
  const onTimelineCommitActions = useCallback((commit, point, returnElement) => {
    if (capabilities?.commitOps !== true) return
    openCommitActions(commit, point, returnElement)
  }, [capabilities, openCommitActions])

  /** Submit the open commit dialog. */
  const confirmCommitDialog = useCallback(values => {
    if (commitDialog === null) return
    void runCommitAction(commitDialog.kind, commitDialog, values)
  }, [commitDialog, runCommitAction])

  /** Close the commit dialog without writing anything. */
  const cancelCommitDialog = useCallback(() => {
    if (commitBusyRef.current) return
    setCommitDialog(null)
    setCommitDialogError(null)
    restoreCommitFocus()
  }, [restoreCommitFocus])

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
      <div className="vcs-root" ref={rootRef} tabIndex={-1}>
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
        branches={branches.list}
        branchesStatus={branches.status}
        branchesError={branches.error}
        branchesTruncated={branches.truncated}
        onLoadBranches={loadBranches}
        onSwitchBranch={branch => { void switchBranch(branch) }}
        onBranchActions={openBranchActions}
        switching={switching !== null}
        branchBusy={branchBusy}
        tagBusy={tagBusy}
        commitBusy={commitBusy}
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
                onRefActions={capabilities?.branchOps === true || capabilities?.tagOps === true
                  ? onTimelineRefActions
                  : undefined}
                onCommitActions={capabilities?.commitOps === true ? onTimelineCommitActions : undefined}
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
      <RefActionsMenu
        target={branchMenu}
        busy={branchBusy !== null}
        t={t}
        onChoose={chooseBranchAction}
        onClose={closeBranchActions}
      />
      <RefActionsMenu
        target={tagMenu}
        busy={tagBusy !== null}
        t={t}
        onChoose={chooseTagAction}
        onClose={closeTagActions}
      />
      <RefActionsMenu
        target={commitMenu}
        busy={commitBusy !== null}
        t={t}
        onChoose={chooseCommitAction}
        onClose={closeCommitActions}
      />
      {branchDialog === null ? null : (
        <BranchDialog
          key={`${branchDialog.kind}:${branchDialog.branch}`}
          request={branchDialog}
          error={branchDialogError}
          busy={branchBusy !== null}
          onCancel={cancelBranchDialog}
          onConfirm={confirmBranchDialog}
          t={t}
        />
      )}
      {tagDialog === null ? null : (
        <TagDialog
          key={`${tagDialog.kind}:${tagDialog.tag}`}
          request={tagDialog}
          error={tagDialogError}
          busy={tagBusy !== null}
          remotes={tagRemotes}
          onCancel={cancelTagDialog}
          onConfirm={confirmTagDialog}
          t={t}
        />
      )}
      {commitDialog === null ? null : (
        <CommitDialog
          key={`${commitDialog.kind}:${commitDialog.sha}`}
          request={commitDialog}
          error={commitDialogError}
          busy={commitBusy !== null}
          onCancel={cancelCommitDialog}
          onConfirm={confirmCommitDialog}
          t={t}
        />
      )}
    </div>
  )
}
