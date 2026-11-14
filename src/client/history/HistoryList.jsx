/**
 * The History list: virtualized commit rows with the lane graph overlaid.
 *
 * The graph and the rows share one scrollport and one row height, so the lanes
 * can never drift from their commits. Only the visible window is rendered; the
 * graph receives the same window bounds.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { graphWidth, Graph } from './Graph.jsx'
import { hasSeveralAuthors } from './commits.js'
import { errorMessage, formatCommitTime, formatCount, shortSha } from '../format.js'
import { RefBadge, Segmented, Spinner } from '../ui.jsx'

/** Fixed row height in CSS pixels. */
export const ROW_HEIGHT = 30
/** Rows drawn beyond each viewport edge. */
const OVERSCAN = 10

/**
 * Render one page-deep commit list.
 * @param {{ commits: object[], layout: object, selected: string | null, onSelect: Function, t: Function, locale?: string, refMode: string, onRefMode: Function, loading: boolean, loadingMore: boolean, error: object | null, hasMore: boolean, truncated: boolean, onLoadMore: Function }} props - history state.
 */
export function HistoryList({
  commits, layout, selected, onSelect, t, locale, refMode, onRefMode,
  loading, loadingMore, error, hasMore, truncated, onLoadMore,
  initialScrollTop = 0, onScrollOffset, onRetry,
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
    // Restore once per mount; later selection changes own the offset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The first page may arrive after mount, when the scroll height is still
  // zero; apply the saved offset when there is content to scroll.
  useEffect(() => {
    if (restoreRef.current === null || commits.length === 0) return
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = restoreRef.current
    setScrollTop(element.scrollTop)
    restoreRef.current = null
  }, [commits.length])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null || selected === null) return
    const index = commits.findIndex(commit => commit.sha === selected)
    if (index < 0) return
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
    // The selection drives the scroll; appending a page must not move it.
  }, [selected, commits.length])

  const gutter = graphWidth(layout)
  const total = commits.length * ROW_HEIGHT
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(commits.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const visible = commits.slice(first, last)
  const selectedIndex = selected === null ? -1 : commits.findIndex(commit => commit.sha === selected)
  const showAuthor = useMemo(() => hasSeveralAuthors(commits), [commits])
  const loadedCount = `${formatCount(commits.length, locale)}${hasMore ? '+' : ''}`

  return (
    <div className="vcs-history">
      <div className="vcs-history-controls">
        <Segmented
          value={refMode}
          label={t('history.refLabel')}
          options={[
            { value: 'HEAD', label: t('history.head'), title: t('history.headTitle') },
            { value: 'all', label: t('history.all'), title: t('history.allTitle') },
          ]}
          onChange={onRefMode}
        />
        <span className="vcs-history-count">{loading ? <Spinner label={t('history.loading')} /> : commits.length > 0 ? t('history.count', { count: loadedCount }) : null}</span>
      </div>
      <div className="vcs-history-viewport">
        <div
          ref={scrollRef}
          className="vcs-history-scroll"
          tabIndex={0}
          role="region"
          aria-label={t('tabs.history')}
          onScroll={event => {
            setScrollTop(event.currentTarget.scrollTop)
            onScrollOffset?.(event.currentTarget.scrollTop)
          }}
        >
          <div className="vcs-history-rows" style={{ height: `${total}px` }}>
            {visible.map((commit, offset) => {
              const index = first + offset
              return (
                <button
                  key={commit.sha}
                  type="button"
                  className="vcs-commit-row"
                  aria-current={commit.sha === selected ? 'true' : undefined}
                  tabIndex={index === (selectedIndex >= 0 ? selectedIndex : 0) ? 0 : -1}
                  data-commit-index={index}
                  style={{ top: `${index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px`, paddingLeft: `${gutter + 10}px` }}
                  onClick={() => { onSelect(commit) }}
                  title={`${shortSha(commit.sha)}  ${commit.subject}`}
                >
                  <span className="vcs-commit-subject">{commit.subject}</span>
                  <span className="vcs-commit-refs">
                    {commit.refs.slice(0, 3).map(reference => <RefBadge key={`${reference.kind}:${reference.name}`} reference={reference} />)}
                  </span>
                  {showAuthor ? <span className="vcs-commit-author">{commit.author}</span> : null}
                  <span className="vcs-commit-time">{formatCommitTime(commit.authorTime, Date.now(), locale)}</span>
                </button>
              )
            })}
          </div>
          {loading && commits.length === 0 ? (
            <div className="vcs-empty"><Spinner label={t('history.loading')} /><p className="vcs-note">{t('history.loading')}</p></div>
          ) : null}
          {!loading && error !== null ? (
            <div className="vcs-empty">
              <p className="vcs-empty-title">{t('history.error')}</p>
              <p className="vcs-note">{errorMessage(t, error)}</p>
              {onRetry === undefined ? null : <button type="button" className="vcs-button" onClick={onRetry}>{t('error.retry')}</button>}
            </div>
          ) : null}
          {!loading && error === null && commits.length === 0 ? (
            <div className="vcs-empty"><p className="vcs-empty-title">{t('history.empty')}</p><p className="vcs-note">{t('history.emptyHint')}</p></div>
          ) : null}
        </div>
        <Graph
          commits={commits}
          layout={layout}
          rowHeight={ROW_HEIGHT}
          scrollTop={scrollTop}
          viewportHeight={viewport}
          width={gutter}
          selectedIndex={selectedIndex}
        />
      </div>
      {!truncated && !hasMore ? null : (
        <div className="vcs-history-footer">
          {truncated ? <p className="vcs-note">{t('history.truncated', { count: formatCount(commits.length, locale) })}</p> : null}
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
