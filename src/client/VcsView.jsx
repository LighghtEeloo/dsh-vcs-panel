/**
 * The Git panel view registered in `conversation.view`.
 *
 * One Session, one repository chooser, two list surfaces (Changes and History)
 * and one detail pane. Host data is read through `api.js`; this component owns
 * request lifecycle, selection, paging, and the sessionStorage-backed state.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createApi } from './api.js'
import { loadState, saveState, SIDEBAR_MAX, SIDEBAR_MIN } from './state.js'
import { errorMessage } from './format.js'
import { buildRows, rowIndexOfFile } from './changes/tree.js'
import { buildGraph } from './history/layout.js'
import { ChangesList } from './changes/ChangesList.jsx'
import { DiffPane } from './changes/DiffPane.jsx'
import { HistoryList } from './history/HistoryList.jsx'
import { CommitPane } from './history/CommitPane.jsx'
import { TopBar } from './TopBar.jsx'
import { Spinner } from './ui.jsx'

/** Rows per history page. */
const PAGE_SIZE = 300
/** Reload when the panel becomes visible after this idle time. */
const STALE_MS = 30_000
/** Below this width the panel shows one column at a time. */
const NARROW_WIDTH = 760

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

/**
 * Render the Git view for one Session.
 * @param {{ sessionId: string, t: Function }} props - standard Conversation view props.
 */
export function VcsView({ sessionId, t }) {
  const [state, setState] = useState(() => loadState(sessionId))
  const stateRef = useRef(state)
  stateRef.current = state
  const scrollRef = useRef({ ...state.scroll })
  const persistTimer = useRef(null)

  const api = useMemo(() => createApi(sessionId), [sessionId])
  const [repositories, setRepositories] = useState({ status: 'loading', list: [], truncated: false, error: null })
  const [status, setStatus] = useState(idleStatus)
  const [log, setLog] = useState(idleLog)
  const [revision, setRevision] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [narrowDetail, setNarrowDetail] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [dirChildren, setDirChildren] = useState({})
  const [loadingDirs, setLoadingDirs] = useState({})
  const [notice, setNotice] = useState(null)

  const rootRef = useRef(null)
  const changesScrollRef = useRef(null)
  const logKeyRef = useRef('')
  const lastLoaded = useRef(0)
  const dragRef = useRef(null)
  const attemptedDirsRef = useRef(new Set())
  const perRepoRef = useRef(new Map())
  const pageControllerRef = useRef(null)

  /** Persist scroll offsets a moment after the last scroll event. */
  const persistScroll = useCallback(() => {
    if (persistTimer.current !== null) return
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      saveState(sessionId, { ...stateRef.current, scroll: { ...scrollRef.current } })
    }, 300)
  }, [sessionId])

  useEffect(() => () => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current)
    saveState(sessionId, { ...stateRef.current, scroll: { ...scrollRef.current } })
  }, [sessionId])

  useEffect(() => {
    saveState(sessionId, { ...state, scroll: { ...scrollRef.current } })
  }, [sessionId, state])

  /** Update a slice of persisted state. */
  const update = useCallback(patch => {
    setState(previous => ({ ...previous, ...patch }))
  }, [])

  /** Remember one repository's selection and restore the next one's. */
  const switchRepo = useCallback(nextRepo => {
    const current = stateRef.current
    if (current.repo !== null && current.repo !== nextRepo) {
      perRepoRef.current.set(current.repo, {
        file: current.file,
        commit: current.commit,
        commitFile: current.commitFile,
        dirs: current.dirs,
        collapsed: current.collapsed,
        ref: current.ref,
      })
    }
    const saved = nextRepo === null ? undefined : perRepoRef.current.get(nextRepo)
    setNarrowDetail(false)
    setNotice(null)
    setCursor(0)
    setDirChildren({})
    setLoadingDirs({})
    attemptedDirsRef.current.clear()
    setStatus(idleStatus())
    scrollRef.current = { changes: 0, history: 0 }
    restoredChangesRef.current = false
    update({
      repo: nextRepo,
      file: saved?.file ?? null,
      commit: saved?.commit ?? null,
      commitFile: saved?.commitFile ?? null,
      dirs: saved?.dirs ?? {},
      collapsed: saved?.collapsed ?? {},
      ref: saved?.ref ?? 'HEAD',
    })
  }, [update])

  // Narrow layout: one column at a time.
  useLayoutEffect(() => {
    const element = rootRef.current
    if (element === null) return undefined
    const measure = () => { setNarrow(element.clientWidth < NARROW_WIDTH) }
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
      const list = Array.isArray(answer.repositories) ? answer.repositories : []
      setRepositories({ status: 'ready', list, truncated: answer.truncated === true, error: null })
      const previousRepo = stateRef.current.repo
      const nextRepo = list.find(entry => entry.path === previousRepo)?.path
        ?? list.find(entry => entry.enclosing)?.path
        ?? list[0]?.path
        ?? null
      if (nextRepo !== previousRepo) switchRepo(nextRepo)
      if (list.length === 0) setRefreshing(false)
    }).catch(error => {
      if (error?.name === 'AbortError') return
      setRepositories({ status: 'error', list: [], truncated: false, error })
      setRefreshing(false)
    })
    return () => { controller.abort() }
  }, [api, revision, switchRepo])

  // Working-tree status for the chosen repository.
  useEffect(() => {
    if (state.repo === null) {
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
      setStatus({ status: 'ready', data, error: null })
      setRefreshing(false)
      lastLoaded.current = Date.now()
    }).catch(error => {
      if (error?.name === 'AbortError') return
      setStatus(previous => ({ status: 'error', data: previous.data, error }))
      setRefreshing(false)
    })
    return () => { controller.abort() }
  }, [api, state.repo, revision])

  // Reset loaded history whenever the range changes.
  useEffect(() => {
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
    setLog(idleLog())
    logKeyRef.current = ''
  }, [state.repo, state.ref])

  useEffect(() => () => { pageControllerRef.current?.abort() }, [])

  // First history page: loaded when the tab opens and invalidated by refresh.
  useEffect(() => {
    if (state.repo === null) return undefined
    const key = `${state.repo}|${state.ref}|${revision}`
    const needed = state.tab === 'history' || log.commits.length > 0
    if (!needed || logKeyRef.current === key) return undefined
    const controller = new AbortController()
    let settled = false
    setLog(previous => ({ ...previous, status: 'loading', error: null, commits: previous.commits }))
    api.log(state.repo, { ref: state.ref, skip: 0, limit: PAGE_SIZE }, controller.signal).then(page => {
      settled = true
      logKeyRef.current = key
      const commits = Array.isArray(page.commits) ? page.commits : []
      setLog({
        status: 'ready',
        commits,
        error: null,
        truncated: page.truncated === true,
        hasMore: commits.length >= PAGE_SIZE && page.truncated !== true,
        loadingMore: false,
      })
    }).catch(error => {
      if (error?.name === 'AbortError') return
      logKeyRef.current = ''
      setLog({ ...idleLog(), status: 'error', error })
    })
    return () => {
      controller.abort()
      // An aborted first page must stay retryable when the tab returns.
      if (!settled && logKeyRef.current === key) logKeyRef.current = ''
    }
  }, [api, state.repo, state.ref, state.tab, revision])

  // Returning to the panel after a while refreshes once, without polling.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastLoaded.current < STALE_MS) return
      setRevision(value => value + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // Restore the Changes list's offset once there are rows to scroll. The list
  // remounts on tab switches and when a narrow detail closes, so a missing
  // element resets the flag and the next mount restores again.
  const restoredChangesRef = useRef(false)
  useLayoutEffect(() => {
    if (state.tab !== 'changes' || status.data === null) {
      restoredChangesRef.current = false
      return
    }
    const element = changesScrollRef.current
    if (element === null) {
      restoredChangesRef.current = false
      return
    }
    if (restoredChangesRef.current) return
    element.scrollTop = scrollRef.current.changes ?? 0
    restoredChangesRef.current = true
  }, [state.tab, state.repo, status.data, narrowDetail])

  // A different Session may reuse this component instance; reload its state.
  const sessionRef = useRef(sessionId)
  useEffect(() => {
    if (sessionRef.current === sessionId) return
    sessionRef.current = sessionId
    const restored = loadState(sessionId)
    scrollRef.current = { ...restored.scroll }
    restoredChangesRef.current = false
    logKeyRef.current = ''
    setState(restored)
    setStatus(idleStatus())
    setLog(idleLog())
    setRepositories({ status: 'loading', list: [], error: null })
    setDirChildren({})
    setLoadingDirs({})
    setNarrowDetail(false)
    setCursor(0)
    setNotice(null)
    attemptedDirsRef.current.clear()
    perRepoRef.current.clear()
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
  }, [sessionId])

  const groups = useMemo(() => {
    const data = status.data
    if (data === null) return []
    const stateForTree = { collapsed: state.collapsed, dirs: state.dirs, dirChildren, loadingDirs }
    const built = ['staged', 'unstaged', 'untracked']
      .map(id => {
        const entries = data.groups?.[id] ?? []
        return {
          id,
          rows: buildRows(id, entries, stateForTree),
          total: entries.length,
          label: t(`changes.${id}`, { count: String(entries.length) }),
        }
      })
      .filter(group => group.rows.length > 0)
    let index = 0
    for (const group of built) {
      group.rows = group.rows.map(row => ({ ...row, index: index++ }))
    }
    return built
  }, [status.data, state.collapsed, state.dirs, dirChildren, loadingDirs, t])

  const changesRows = useMemo(() => groups.flatMap(group => group.rows), [groups])

  useEffect(() => {
    if (status.data === null) return
    const index = rowIndexOfFile(changesRows, state.file)
    if (index >= 0) setCursor(index)
    // Restore once per repository refresh; directory clicks own the cursor after this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.repo, status.data])

  /** The working-tree entry selected in the list, including loaded untracked children. */
  const selectedEntry = useMemo(() => {
    if (state.file === null || status.data === null) return null
    const entries = state.file.group === 'untracked'
      ? [...(status.data.groups?.untracked ?? []), ...Object.values(dirChildren).flat()]
      : (status.data.groups?.[state.file.group] ?? [])
    const found = entries.find(entry => entry.path === state.file.path && !entry.directory)
    if (found === undefined) return null
    if (found.status !== undefined) return found
    return { path: found.path, status: '?', added: 0, deleted: 0 }
  }, [state.file, status.data, dirChildren])

  const layout = useMemo(() => buildGraph(log.commits), [log.commits])
  const selectedCommit = useMemo(
    () => (state.commit === null ? null : log.commits.find(commit => commit.sha === state.commit) ?? null),
    [state.commit, log.commits],
  )

  const changed = status.data?.total ?? 0

  /** Refresh both repositories and the selected repository's data. */
  const refresh = useCallback(() => {
    setRefreshing(true)
    setNotice(null)
    setDirChildren({})
    setLoadingDirs({})
    attemptedDirsRef.current.clear()
    setRevision(value => value + 1)
  }, [])

  /** Load the direct children of one untracked directory. */
  const expandUntracked = useCallback(async (key, path) => {
    if (state.repo === null) return
    const repo = state.repo
    attemptedDirsRef.current.add(key)
    setLoadingDirs(previous => ({ ...previous, [key]: true }))
    try {
      const answer = await api.untracked(repo, path)
      if (stateRef.current.repo !== repo) return
      setDirChildren(previous => ({ ...previous, [key]: Array.isArray(answer.entries) ? answer.entries : [] }))
      if (answer.truncated === true) setNotice(t('changes.untrackedTruncated'))
    } catch (error) {
      if (error?.name === 'AbortError') return
      if (stateRef.current.repo !== repo) return
      update({ dirs: omit(stateRef.current.dirs, key) })
      setNotice(errorMessage(t, error))
    } finally {
      setLoadingDirs(previous => {
        const next = { ...previous }
        delete next[key]
        return next
      })
    }
  }, [api, state.repo, t, update])

  // Re-open persisted untracked folders once their repository's status is known.
  useEffect(() => {
    if (state.repo === null || status.data === null) return
    for (const key of Object.keys(state.dirs)) {
      if (!key.startsWith('untracked|')) continue
      if (dirChildren[key] !== undefined || loadingDirs[key] === true) continue
      if (attemptedDirsRef.current.has(key)) continue
      void expandUntracked(key, `${key.slice('untracked|'.length)}/`)
    }
  }, [state.repo, state.dirs, status.data, dirChildren, loadingDirs, expandUntracked])

  /** Toggle a directory row: collapse it, expand it, or fetch its children. */
  const toggleDir = useCallback(row => {
    if (typeof row.index === 'number') setCursor(row.index)
    if (row.group === 'untracked' && row.loadable) {
      const key = `${row.group}|${row.path.replace(/\/+$/, '')}`
      if (row.expanded) {
        update({ dirs: omit(stateRef.current.dirs, key) })
        return
      }
      update({ dirs: { ...stateRef.current.dirs, [key]: true } })
      if (dirChildren[key] === undefined && loadingDirs[key] !== true) void expandUntracked(key, row.path)
      return
    }
    const key = `${row.group}|${row.path.replace(/\/+$/, '')}`
    if (row.expanded) update({ collapsed: { ...stateRef.current.collapsed, [key]: true } })
    else update({ collapsed: omit(stateRef.current.collapsed, key) })
  }, [dirChildren, expandUntracked, loadingDirs, update])

  /** Select one working-tree file. */
  const focusRoot = useCallback(() => {
    requestAnimationFrame(() => { rootRef.current?.focus() })
  }, [])

  const selectFile = useCallback((row, index) => {
    setCursor(index)
    update({ file: { group: row.group, path: row.path } })
    if (narrow) {
      setNarrowDetail(true)
      focusRoot()
    }
  }, [focusRoot, narrow, update])

  /** Select one commit. */
  const selectCommit = useCallback(commit => {
    update({ commit: commit.sha, commitFile: null })
    if (narrow) {
      setNarrowDetail(true)
      focusRoot()
    }
  }, [focusRoot, narrow, update])

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
      if (stateRef.current.repo !== repo || stateRef.current.ref !== ref) return
      setLog(previous => ({
        ...previous,
        loadingMore: false,
        commits: [...previous.commits, ...(Array.isArray(page.commits) ? page.commits : [])],
        truncated: page.truncated === true,
        hasMore: (page.commits ?? []).length >= PAGE_SIZE && page.truncated !== true,
      }))
    } catch (error) {
      if (error?.name === 'AbortError') return
      if (stateRef.current.repo !== repo || stateRef.current.ref !== ref) return
      setLog(previous => ({ ...previous, loadingMore: false }))
      setNotice(errorMessage(t, error))
    } finally {
      if (pageControllerRef.current === controller) pageControllerRef.current = null
    }
  }, [api, log.commits, log.hasMore, log.loadingMore, state.repo, state.ref, t])

  /** Move DOM focus to a Changes row once React has painted it. */
  const focusChangesRow = useCallback(index => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rootRef.current?.querySelector(`[data-row-index="${index}"]`)?.focus()
      })
    })
  }, [])

  /** Move DOM focus to a History row once React has painted it. */
  const focusCommitRow = useCallback(index => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rootRef.current?.querySelector(`[data-commit-index="${index}"]`)?.focus()
      })
    })
  }, [])

  /** One keyboard command over the active list. */
  const moveChanges = useCallback(delta => {
    if (changesRows.length === 0) return
    let next = Math.max(0, Math.min(cursor, changesRows.length - 1)) + delta
    while (next >= 0 && next < changesRows.length && changesRows[next].kind === 'loading') next += delta
    if (next < 0 || next >= changesRows.length) return
    setCursor(next)
    const row = changesRows[next]
    if (row.kind === 'file') update({ file: { group: row.group, path: row.path } })
    focusChangesRow(next)
  }, [changesRows, cursor, focusChangesRow, state.file, update])

  const moveHistory = useCallback(delta => {
    if (log.commits.length === 0) return
    let index = state.commit === null ? -1 : log.commits.findIndex(commit => commit.sha === state.commit)
    index = index < 0 ? 0 : index + delta
    if (index < 0 || index >= log.commits.length) return
    update({ commit: log.commits[index].sha, commitFile: null })
    focusCommitRow(index)
  }, [focusCommitRow, log.commits, state.commit, update])

  /** Keyboard navigation for both lists; inputs keep their keys. */
  const onKeyDown = event => {
    const target = event.target
    if (target instanceof HTMLElement) {
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      if (tag === 'BUTTON' && !('rowIndex' in target.dataset) && !('commitIndex' in target.dataset)) return
    }
    if (event.key === 'Escape') {
      if (state.commitFile !== null) {
        event.preventDefault()
        update({ commitFile: null })
      } else if (narrow && narrowDetail) {
        event.preventDefault()
        setNarrowDetail(false)
        if (state.tab === 'history') focusRoot()
        else focusChangesRow(changesRows.length === 0 ? 0 : Math.min(Math.max(cursor, 0), changesRows.length - 1))
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault()
      if (state.tab === 'changes') moveChanges(1)
      else moveHistory(1)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault()
      if (state.tab === 'changes') moveChanges(-1)
      else moveHistory(-1)
      return
    }
    if (event.key === 'Enter' && !narrowDetail) {
      if (target instanceof HTMLElement && target.tagName === 'BUTTON') return
      if (state.tab === 'changes') {
        const row = changesRows[cursor]
        if (row === undefined) return
        event.preventDefault()
        if (row.kind === 'dir') toggleDir(row)
        else if (row.kind === 'file') {
          update({ file: { group: row.group, path: row.path } })
          if (narrow) setNarrowDetail(true)
        }
      } else if (narrow && state.commit !== null) {
        event.preventDefault()
        setNarrowDetail(true)
      }
    }
  }

  /** Drag the sidebar divider. */
  const startResize = event => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, width: state.sidebarWidth }
  }
  const resize = event => {
    if (dragRef.current === null) return
    update({ sidebarWidth: clampWidth(dragRef.current.width + event.clientX - dragRef.current.x) })
  }
  const stopResize = () => { dragRef.current = null }

  if (repositories.status === 'error') {
    const missing = repositories.error?.code === 'git-missing'
    return (
      <div className="vcs-root" data-conversation-composer-overlay="" ref={rootRef} tabIndex={-1}>
        <div className="vcs-center">
          <p className="vcs-empty-title">{missing ? t('error.gitMissing') : t('repositories.error')}</p>
          <p className="vcs-note">{missing ? t('error.gitMissingHint') : errorMessage(t, repositories.error)}</p>
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
        onRepoChange={repo => { switchRepo(repo) }}
        status={status.data}
        changed={changed}
        onRefresh={refresh}
        refreshing={refreshing}
        t={t}
      />
      {repositories.status === 'loading' ? (
        <div className="vcs-center"><Spinner label={t('loading.repositories')} /><p className="vcs-note">{t('loading.repositories')}</p></div>
      ) : state.repo === null ? (
        <div className="vcs-center">
          <p className="vcs-empty-title">{t('empty.repository')}</p>
          <p className="vcs-note">{t('empty.repositoryHint')}</p>
        </div>
      ) : (
        <div className="vcs-main" id="vcs-panel" role="tabpanel" aria-labelledby={`vcs-tab-${state.tab}`}>
          {!narrow || !narrowDetail ? (
            <section className="vcs-sidebar" style={narrow ? undefined : { width: `${state.sidebarWidth}px` }}>
              <div
                className="vcs-tabbar"
                role="tablist"
                aria-label={t('view.label')}
                onKeyDown={event => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const next = state.tab === 'changes' ? 'history' : 'changes'
                  update({ tab: next })
                  rootRef.current?.querySelector(`#vcs-tab-${next}`)?.focus()
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id="vcs-tab-changes"
                  aria-controls="vcs-panel"
                  aria-selected={state.tab === 'changes'}
                  tabIndex={state.tab === 'changes' ? 0 : -1}
                  onClick={() => { update({ tab: 'changes' }) }}
                >
                  {t('tabs.changes')}
                  {changed > 0 ? <span className="vcs-tab-count">{changed}</span> : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  id="vcs-tab-history"
                  aria-controls="vcs-panel"
                  aria-selected={state.tab === 'history'}
                  tabIndex={state.tab === 'history' ? 0 : -1}
                  onClick={() => { update({ tab: 'history' }) }}
                >
                  {t('tabs.history')}
                </button>
              </div>
              {notice === null ? null : <p className="vcs-notice" role="alert">{notice}</p>}
              {repositories.truncated ? <p className="vcs-note">{t('repositories.truncated', { count: '50' })}</p> : null}
              {status.status === 'error' ? <p className="vcs-notice" role="alert">{t('changes.error')} {errorMessage(t, status.error)}</p> : null}
              {state.tab === 'changes' ? (
                <div
                  ref={changesScrollRef}
                  className="vcs-list-scroll"
                  onScroll={event => {
                    scrollRef.current.changes = event.currentTarget.scrollTop
                    persistScroll()
                  }}
                >
                  <ChangesList
                    groups={groups}
                    t={t}
                    empty={status.data !== null && changed === 0}
                    loading={status.status === 'loading'}
                    activeIndex={changesRows.length === 0 ? 0 : Math.min(Math.max(cursor, 0), changesRows.length - 1)}
                    onSelect={(row) => { selectFile(row, row.index) }}
                    onToggle={toggleDir}
                    truncated={status.data?.truncated === true}
                  />
                </div>
              ) : (
                <HistoryList
                  key={`${state.repo}|${state.ref}`}
                  commits={log.commits}
                  layout={layout}
                  selected={state.commit}
                  onSelect={selectCommit}
                  t={t}
                  refMode={state.ref}
                  onRefMode={refMode => { update({ ref: refMode, commit: null, commitFile: null }) }}
                  loading={log.status === 'loading'}
                  loadingMore={log.loadingMore}
                  error={log.error}
                  hasMore={log.hasMore}
                  truncated={log.truncated}
                  onLoadMore={() => { void loadMore() }}
                  initialScrollTop={scrollRef.current.history ?? 0}
                  onScrollOffset={top => {
                    scrollRef.current.history = top
                    persistScroll()
                  }}
                />
              )}
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
          {!narrow || narrowDetail ? (
            <section className="vcs-content">
              {state.tab === 'changes' ? (
                <DiffPane
                  api={api}
                  repo={state.repo}
                  target={state.file === null ? null : { scope: state.file.group, path: state.file.path, oldPath: selectedEntry?.origPath }}
                  entry={selectedEntry}
                  t={t}
                  split={state.split}
                  wrap={state.wrap}
                  onToggleSplit={split => { update({ split }) }}
                  onToggleWrap={wrap => { update({ wrap }) }}
                  revision={revision}
                  onBack={() => {
                    setNarrowDetail(false)
                    focusChangesRow(changesRows.length === 0 ? 0 : Math.min(Math.max(cursor, 0), changesRows.length - 1))
                  }}
                  narrow={narrow}
                />
              ) : (
                <CommitPane
                  api={api}
                  repo={state.repo}
                  sha={state.commit}
                  summary={selectedCommit}
                  selectedFile={state.commitFile}
                  onSelectFile={file => { update({ commitFile: file }) }}
                  split={state.split}
                  wrap={state.wrap}
                  onToggleSplit={split => { update({ split }) }}
                  onToggleWrap={wrap => { update({ wrap }) }}
                  revision={revision}
                  onBack={() => {
                    setNarrowDetail(false)
                    update({ commit: null, commitFile: null })
                    focusRoot()
                  }}
                  narrow={narrow}
                  t={t}
                />
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Copy a record without one key. */
function omit(record, key) {
  const next = { ...(record ?? {}) }
  delete next[key]
  return next
}
