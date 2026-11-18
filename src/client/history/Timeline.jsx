/**
 * The timeline: an optional working-tree row, loaded commits, and the lane
 * graph overlaid.
 *
 * A backend with a separate working tree contributes row 0; a backend whose
 * working copy is a commit contributes only its commits, one of which is `@`.
 * The graph and the rows share one scrollport and one row height, so lanes
 * never drift from their rows. Only the visible window is rendered; the graph
 * receives the same window bounds. Rows are two lines: the title gets the full
 * width, and refs, id, author, and time share the second line.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { graphWidth, Graph } from './Graph.jsx'
import { DEFAULT_ROW_HEIGHT } from './layout.js'
import { hasSeveralAuthors } from './commits.js'
import { worktreeSummary } from './timeline.js'
import { errorMessage, formatCommitTime, formatCount, shortChangeId, shortSha } from '../format.js'
import { DOWN, FORWARD, movement, unmodified, UP } from '../keys.js'
import { RefBadge } from '../ui.jsx'
import { Bar, TimelineSkeleton } from '../skeleton.jsx'

/** Fixed row height in CSS pixels. */
export const ROW_HEIGHT = DEFAULT_ROW_HEIGHT
/** Rows drawn beyond each viewport edge. */
const OVERSCAN = 10
/** Ref badges shown on a row before the rest are left to the detail. */
const ROW_REFS = 3

/** Added/deleted counts in the diff colors; zero sides are left out. */
function LineStat({ added, deleted, locale }) {
  return (
    <>
      {added > 0 ? <span className="vcs-add">+{formatCount(added, locale)}</span> : null}
      {deleted > 0 ? <span className="vcs-del">−{formatCount(deleted, locale)}</span> : null}
    </>
  )
}

/** The working-tree row's second line. */
function WorktreeMeta({ status, statusState, t, locale }) {
  if (status === null) {
    if (statusState === 'error') return <span className="vcs-timeline-error">{t('changes.error')}</span>
    return (
      <span className="vcs-skeleton vcs-timeline-meta-skeleton" role="status" aria-busy="true">
        <span className="vcs-sr-only">{t('changes.loading')}</span>
        <Bar width="96px" />
      </span>
    )
  }
  const summary = worktreeSummary(status)
  if (summary.changed === 0) return <span>{t('changes.clean')}</span>
  return (
    <>
      <span>{t('timeline.changes', { count: formatCount(summary.changed, locale) })}</span>
      <LineStat added={summary.added} deleted={summary.deleted} locale={locale} />
    </>
  )
}

/**
 * Render the timeline.
 * @param {{ commits: object[], layout: object, status: object | null, statusState: string, worktreeRow?: boolean, selectedRow: number, onSelectRow: (index: number) => void, onMove: (delta: number) => void, onOpen: () => void, onRefActions?: Function, onCommitActions?: Function, t: Function, locale?: string, loading: boolean, loadingMore: boolean, error: object | null, hasMore: boolean, truncated: boolean, onLoadMore: Function, onRetry: Function, initialScrollTop?: number, onScrollOffset?: (top: number) => void }} props - timeline state.
 */
export function Timeline({
  commits, layout, status, statusState, worktreeRow = true, selectedRow, onSelectRow, onMove, onOpen,
  onRefActions, onCommitActions, t, locale,
  loading, loadingMore, error, hasMore, truncated, onLoadMore, onRetry,
  initialScrollTop = 0, onScrollOffset,
}) {
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const restoreRef = useRef(initialScrollTop)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return undefined
    const measure = () => { setViewport(element.clientHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // The first page may arrive after mount, when there is nothing to scroll
  // yet; apply the saved offset once commits are there.
  useEffect(() => {
    if (restoreRef.current === null || commits.length === 0) return
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = restoreRef.current
    setScrollTop(element.scrollTop)
    restoreRef.current = null
  }, [commits.length])

  // Keep the selected row in view; appending a page must not move the list.
  useEffect(() => {
    const element = scrollRef.current
    if (element === null || selectedRow < 0) return
    const top = selectedRow * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }, [selectedRow])

  const rowCount = commits.length + (worktreeRow ? 1 : 0)
  const gutter = graphWidth(layout)
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const showAuthor = useMemo(() => hasSeveralAuthors(commits), [commits])
  const focusRow = selectedRow >= 0 ? selectedRow : 0
  const now = Date.now()

  const workingSummary = status?.workingCopy?.summary ?? null
  const rows = []
  for (let index = first; index < last; index += 1) {
    const commit = worktreeRow && index === 0 ? null : commits[worktreeRow ? index - 1 : index]
    const common = {
      type: 'button',
      'data-timeline-index': index,
      'aria-current': index === selectedRow ? 'true' : undefined,
      tabIndex: index === focusRow ? 0 : -1,
      style: { top: `${index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px`, paddingLeft: `${gutter + 8}px` },
      onClick: () => { onSelectRow(index) },
    }
    if (commit === null) {
      const clean = status !== null && (status.total ?? 0) === 0
      rows.push(
        <button key="worktree" className="vcs-timeline-row vcs-worktree-row" data-clean={clean ? 'true' : undefined} {...common}>
          <span className="vcs-timeline-title">{t('timeline.worktree')}</span>
          <span className="vcs-timeline-meta">
            <WorktreeMeta status={status} statusState={statusState} t={t} locale={locale} />
          </span>
        </button>,
      )
      continue
    }
    const workingCopy = commit.workingCopy === true
    const shortId = typeof commit.changeId === 'string' && commit.changeId !== ''
      ? shortChangeId(commit.changeId)
      : shortSha(commit.sha)
    const subject = commit.subject === '' ? t('commit.noDescription') : commit.subject
    const commitMenu = onCommitActions === undefined ? null : {
      onContextMenu: event => {
        if (event.defaultPrevented) return
        event.preventDefault()
        onCommitActions(commit, event, event.currentTarget)
      },
      onKeyDown: event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        onCommitActions(
          commit,
          { clientX: rect.left + 12, clientY: rect.bottom ?? (rect.top + rect.height) },
          event.currentTarget,
        )
      },
    }
    rows.push(
      <button
        key={commit.sha}
        className={`vcs-timeline-row${workingCopy ? ' vcs-working-copy-row' : ''}`}
        title={`${workingCopy ? '@  ' : ''}${commit.changeId === undefined ? shortSha(commit.sha) : commit.changeId}  ${subject}`}
        {...common}
        onContextMenu={commitMenu?.onContextMenu}
        onKeyDown={commitMenu?.onKeyDown}
      >
        <span className="vcs-timeline-title">{subject}</span>
        <span className="vcs-timeline-meta">
          {workingCopy ? <span className="vcs-working-badge" title={t('timeline.workingCopy')}>@</span> : null}
          {commit.refs.slice(0, ROW_REFS).map(reference => (
            <RefBadge
              key={`${reference.kind}:${reference.name}`}
              reference={reference}
              onRefContextMenu={onRefActions === undefined
                ? undefined
                : (target, event) => {
                  onRefActions(
                    target,
                    event,
                    event.currentTarget.closest?.('.vcs-timeline-row') ?? event.currentTarget,
                  )
                }}
            />
          ))}
          {commit.refs.length > ROW_REFS ? (
            <span
              className="vcs-ref vcs-ref-more"
              title={t('timeline.moreRefs', {
                refs: commit.refs.slice(ROW_REFS).map(reference => reference.name).join(', '),
              })}
            >
              +{commit.refs.length - ROW_REFS}
            </span>
          ) : null}
          <code className="vcs-timeline-sha" title={commit.sha}>{shortId}</code>
          {workingCopy && workingSummary !== null && workingSummary.changed > 0 ? (
            <>
              <span>{t('timeline.changes', { count: formatCount(workingSummary.changed, locale) })}</span>
              <LineStat added={workingSummary.added} deleted={workingSummary.deleted} locale={locale} />
            </>
          ) : null}
          {showAuthor ? <span className="vcs-timeline-author">{commit.author}</span> : null}
          <span className="vcs-timeline-time">{formatCommitTime(commit.authorTime, now, locale)}</span>
        </span>
      </button>,
    )
  }

  /** Keys of the timeline: move, open the selected node's files. */
  const onKeyDown = event => {
    if (!unmodified(event)) return
    const direction = movement(event)
    if (direction === DOWN) {
      event.preventDefault()
      onMove(1)
    } else if (direction === UP) {
      event.preventDefault()
      onMove(-1)
    } else if (direction === FORWARD || event.key === 'Enter') {
      event.preventDefault()
      onOpen()
    }
  }

  return (
    <div className="vcs-timeline">
      <div className="vcs-timeline-viewport">
        <div
          ref={scrollRef}
          className="vcs-timeline-scroll"
          role="region"
          aria-label={t('timeline.label')}
          data-zone="timeline"
          onKeyDown={onKeyDown}
          onScroll={event => {
            setScrollTop(event.currentTarget.scrollTop)
            onScrollOffset?.(event.currentTarget.scrollTop)
          }}
        >
          <div className="vcs-timeline-rows" style={{ height: `${rowCount * ROW_HEIGHT}px` }}>
            {rows}
          </div>
          {loading && commits.length === 0 ? (
            <TimelineSkeleton
              rows={Math.max(1, Math.ceil(viewport / ROW_HEIGHT) - rowCount)}
              rowHeight={ROW_HEIGHT}
              gutter={gutter}
              label={t('history.loading')}
            />
          ) : null}
          {loadingMore ? <TimelineSkeleton rows={3} rowHeight={ROW_HEIGHT} gutter={gutter} /> : null}
          {!loading && error !== null ? (
            <div className="vcs-timeline-note">
              <span>{t('history.error')} {errorMessage(t, error)}</span>
              <button type="button" className="vcs-button" onClick={onRetry}>{t('error.retry')}</button>
            </div>
          ) : null}
          {!loading && error === null && commits.length === 0 ? (
            <div className="vcs-timeline-note"><span>{t('history.empty')}</span></div>
          ) : null}
        </div>
        <Graph
          rowCount={rowCount}
          layout={layout}
          rowHeight={ROW_HEIGHT}
          scrollTop={scrollTop}
          viewportHeight={viewport}
          width={gutter}
          selectedIndex={selectedRow}
        />
      </div>
      {commits.length === 0 ? null : (
        <div className="vcs-timeline-footer">
          <span className="vcs-timeline-count">
            {t('history.count', { count: `${formatCount(commits.length, locale)}${hasMore ? '+' : ''}` })}
          </span>
          {truncated ? <span className="vcs-note">{t('history.truncated', { count: formatCount(commits.length, locale) })}</span> : null}
          {hasMore ? (
            <button type="button" className="vcs-load-more" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? t('history.loadingMore') : t('history.loadMore')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
