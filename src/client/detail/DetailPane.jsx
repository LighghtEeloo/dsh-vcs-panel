/**
 * The detail of one timeline node, the same for the working tree and commits:
 * a toolbar, a header block, the file navigation, and the diff stream.
 *
 * The node decides only the header and where the files come from — the
 * working-tree status, or the commit's changed files from `vcs.commit`. Both
 * become file groups (`detail.js`), and the navigation and the stream read
 * those groups the same way.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WORKTREE } from '../state.js'
import { errorMessage, formatCount, formatDateTime, shortSha } from '../format.js'
import { messageBody } from '../history/commits.js'
import { worktreeSummary } from '../history/timeline.js'
import { BackIcon, BranchIcon, Button, CheckIcon, Chevron, CopyIcon, IconButton, RefBadge, Segmented, Spinner } from '../ui.jsx'
import { buildRows } from './tree.js'
import { commitGroups, defaultFolds, sectionKey, streamSections, worktreeGroups } from './detail.js'
import { FileNav } from './FileNav.jsx'
import { DiffStream } from './DiffStream.jsx'

/** An inline file list starts open when it is at most this long. */
const INLINE_NAV_OPEN = 12

/** Commit id with a copy action. */
function ShaButton({ sha, t }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => { setCopied(false) }, 1600)
    return () => { clearTimeout(timer) }
  }, [copied])
  const copy = () => {
    if (navigator.clipboard?.writeText === undefined) return
    navigator.clipboard.writeText(sha).then(() => { setCopied(true) }).catch(() => { setCopied(false) })
  }
  return (
    <Button className="vcs-sha-button" onClick={copy} title={t('commit.copySha')} aria-label={t('commit.copySha')}>
      <code>{shortSha(sha)}</code>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

/** The commit header block: subject, people, parents, and message body. */
function CommitHeader({ commitState, summary, onSelectCommit, isLoaded, onRetry, t, locale }) {
  const detail = commitState.commit
  const subject = detail?.subject ?? summary?.subject ?? ''
  const body = messageBody(detail?.message)
  return (
    <header className="vcs-node-header">
      <h2 className="vcs-node-title">{subject}</h2>
      {commitState.status === 'error' ? (
        <div className="vcs-node-status">
          <span>{t('commit.error')} {errorMessage(t, commitState.error)}</span>
          <Button onClick={onRetry}>{t('error.retry')}</Button>
        </div>
      ) : detail === null ? (
        <div className="vcs-node-status"><Spinner label={t('commit.loading')} /><span>{t('commit.loading')}</span></div>
      ) : (
        <>
          <dl className="vcs-commit-meta">
            <dt>{t('commit.author')}</dt>
            <dd>{detail.author} <span className="vcs-dim">{formatDateTime(detail.authorTime, locale)}</span></dd>
            {detail.committer !== detail.author || detail.committerTime !== detail.authorTime ? (
              <>
                <dt>{t('commit.committer')}</dt>
                <dd>{detail.committer} <span className="vcs-dim">{formatDateTime(detail.committerTime, locale)}</span></dd>
              </>
            ) : null}
            <dt>{t('commit.parents')}</dt>
            <dd>
              {detail.parents.length === 0
                ? <span className="vcs-dim">{t('commit.root')}</span>
                : detail.parents.map(parent => (isLoaded(parent) ? (
                  <button
                    key={parent}
                    type="button"
                    className="vcs-parent vcs-parent-link"
                    title={t('commit.showParent', { sha: shortSha(parent) })}
                    onClick={() => { onSelectCommit(parent) }}
                  >
                    <code>{shortSha(parent)}</code>
                  </button>
                ) : <code key={parent} className="vcs-parent" title={parent}>{shortSha(parent)}</code>))}
            </dd>
          </dl>
          {body === '' ? null : <pre className="vcs-commit-message">{body}</pre>}
          {detail.files.length === 0 ? <p className="vcs-note">{t('commit.noFiles')}</p> : null}
          {commitState.truncated ? <p className="vcs-note">{t('commit.filesTruncated', { count: formatCount(detail.files.length, locale) })}</p> : null}
        </>
      )}
    </header>
  )
}

/** The working-tree header block: only states that replace the file list. */
function WorktreeHeader({ status, statusState, statusError, t }) {
  if (status === null) {
    if (statusState === 'error') {
      return <header className="vcs-node-header"><p className="vcs-node-status">{t('changes.error')} {errorMessage(t, statusError)}</p></header>
    }
    return <header className="vcs-node-header"><div className="vcs-node-status"><Spinner label={t('changes.loading')} /><span>{t('changes.loading')}</span></div></header>
  }
  if ((status.total ?? 0) > 0) return null
  return (
    <header className="vcs-node-header vcs-node-empty">
      <p className="vcs-empty-title">{t('changes.clean')}</p>
      <p className="vcs-note">{t('changes.cleanHint')}</p>
    </header>
  )
}

/**
 * Render the detail of one node. The parent keys this component by node, so
 * every node starts with fresh local state.
 * @param {object} props - node, data, and handlers from the panel.
 */
export function DetailPane({
  api, repo, node, summary, status, statusState, statusError,
  dirChildren, loadingDirs, dirs, collapsed, onToggleDir,
  folds, onToggleFold, split, wrap, onToggleSplit, onToggleWrap,
  narrow, navInline, onBack, onLeaveNav, onSelectCommit, isLoaded, onMissing,
  revision, cache, initialAnchor, onReading, control, t, locale,
}) {
  const isWorktree = node === WORKTREE
  const [commitState, setCommitState] = useState({ status: 'idle', commit: null, truncated: false, error: null })
  const [attempt, setAttempt] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [readingKey, setReadingKey] = useState(initialAnchor?.key ?? null)
  const streamControl = useRef(null)
  const navRef = useRef(null)

  useEffect(() => {
    if (isWorktree) return undefined
    const controller = new AbortController()
    setCommitState(previous => ({ ...previous, status: previous.commit === null ? 'loading' : 'refreshing', error: null }))
    api.commit(repo, node, controller.signal).then(answer => {
      setCommitState({ status: 'ready', commit: answer.commit, truncated: answer.truncated === true, error: null })
    }).catch(error => {
      if (error?.name === 'AbortError') return
      if (error?.code === 'not-found') onMissing()
      setCommitState({ status: 'error', commit: null, truncated: false, error })
    })
    return () => { controller.abort() }
  }, [api, attempt, isWorktree, node, onMissing, repo, revision])

  const groups = useMemo(
    () => (isWorktree ? worktreeGroups(status) : commitGroups(commitState.commit)),
    [commitState.commit, isWorktree, status],
  )
  const rev = isWorktree ? null : (commitState.commit?.sha ?? node)
  const sections = useMemo(() => streamSections(groups, dirChildren, rev), [dirChildren, groups, rev])
  const defaults = useMemo(() => defaultFolds(sections), [sections])

  const labelOf = useCallback(group => (group.id === 'commit'
    ? t('nav.files', { count: formatCount(group.entries.length, locale) })
    : t(`changes.${group.id}`, { count: formatCount(group.entries.length, locale) })), [locale, t])

  const navGroups = useMemo(() => {
    const expansion = { collapsed, dirs, dirChildren, loadingDirs }
    let index = 0
    return groups.map(group => ({
      id: group.id,
      label: labelOf(group),
      rows: buildRows(group.id, group.entries, expansion).map(row => ({ ...row, index: index++ })),
    }))
  }, [collapsed, dirChildren, dirs, groups, labelOf, loadingDirs])
  const navRows = useMemo(() => navGroups.flatMap(group => group.rows), [navGroups])
  const groupLabels = useMemo(() => {
    if (!isWorktree) return null
    return Object.fromEntries(groups.map(group => [group.id, labelOf(group)]))
  }, [groups, isWorktree, labelOf])

  /** Focus one navigation row once React has painted it; a closed inline list hands focus to the stream. */
  const focusRow = useCallback(index => {
    requestAnimationFrame(() => {
      const row = navRef.current?.querySelector(`[data-row-index="${index}"]`)
      if (row) row.focus()
      else streamControl.current?.focus()
    })
  }, [])

  // The row of the section being read becomes the keyboard cursor, unless the
  // keyboard is already working in the navigation.
  const onStreamReading = useCallback(anchor => {
    setReadingKey(anchor?.key ?? null)
    onReading(anchor)
    if (anchor === null || navRef.current?.contains(document.activeElement)) return
    const index = navRows.findIndex(row => row.kind === 'file' && sectionKey(row.group, row.path) === anchor.key)
    if (index >= 0) setCursor(index)
  }, [navRows, onReading])

  const activate = useCallback(row => {
    if (typeof row.index === 'number') setCursor(row.index)
    if (row.kind === 'dir') {
      onToggleDir(row)
      return
    }
    if (row.kind === 'file') streamControl.current?.scrollTo(sectionKey(row.group, row.path))
  }, [onToggleDir])

  const move = useCallback(delta => {
    if (navRows.length === 0) return
    let next = Math.max(0, Math.min(cursor, navRows.length - 1)) + delta
    while (next >= 0 && next < navRows.length && navRows[next].kind === 'loading') next += delta
    if (next < 0 || next >= navRows.length) return
    setCursor(next)
    const row = navRows[next]
    if (row.kind === 'file') streamControl.current?.scrollTo(sectionKey(row.group, row.path))
    focusRow(next)
  }, [cursor, focusRow, navRows])

  useEffect(() => {
    control.current = {
      focusNav() {
        if (navRows.length === 0) {
          streamControl.current?.focus()
          return
        }
        focusRow(Math.max(0, Math.min(cursor, navRows.length - 1)))
      },
    }
    return () => { control.current = null }
  }, [control, cursor, focusRow, navRows.length])

  const summaryCounts = isWorktree ? worktreeSummary(status) : null
  const fileCount = sections.length
  const [inlineOpen, setInlineOpen] = useState(null)
  const inlineExpanded = inlineOpen ?? fileCount <= INLINE_NAV_OPEN

  const nav = navRows.length === 0 ? null : (
    <div ref={navRef} className="vcs-nav-host">
      <FileNav
        groups={navGroups}
        cursor={Math.max(0, Math.min(cursor, navRows.length - 1))}
        readingKey={readingKey}
        onActivate={activate}
        onMove={move}
        onLeave={onLeaveNav}
        truncated={isWorktree && status?.truncated === true}
        t={t}
        locale={locale}
      />
    </div>
  )

  const header = isWorktree
    ? <WorktreeHeader status={status} statusState={statusState} statusError={statusError} t={t} />
    : (
      <CommitHeader
        commitState={commitState}
        summary={summary}
        onSelectCommit={onSelectCommit}
        isLoaded={isLoaded}
        onRetry={() => { setAttempt(value => value + 1) }}
        t={t}
        locale={locale}
      />
    )

  const before = (
    <>
      {header}
      {navInline && nav !== null ? (
        <div className="vcs-inline-nav">
          <button
            type="button"
            className="vcs-inline-nav-toggle"
            aria-expanded={inlineExpanded}
            onClick={() => { setInlineOpen(!inlineExpanded) }}
          >
            <Chevron open={inlineExpanded} />
            {t('nav.files', { count: formatCount(fileCount, locale) })}
          </button>
          {inlineExpanded ? nav : null}
        </div>
      ) : null}
    </>
  )

  const refs = summary?.refs ?? commitState.commit?.refs ?? []

  return (
    <div
      className="vcs-detail"
      onKeyDown={event => {
        // Escape in the stream returns to the file it is reading.
        if (event.key !== 'Escape' || event.target?.dataset?.zone !== 'stream') return
        event.preventDefault()
        event.stopPropagation()
        if (nav !== null) control.current?.focusNav()
        else onLeaveNav()
      }}
    >
      <div className="vcs-detail-toolbar">
        {narrow ? <IconButton label={t('detail.back')} onClick={onBack}><BackIcon /></IconButton> : null}
        {isWorktree ? (
          <>
            <strong className="vcs-detail-title">{t('timeline.worktree')}</strong>
            {status?.branch?.name ? <span className="vcs-detail-branch vcs-dim"><BranchIcon />{status.branch.name}</span> : null}
            {summaryCounts !== null && summaryCounts.changed > 0 ? (
              <span className="vcs-detail-stat">
                <span className="vcs-dim">{t('detail.fileCount', { count: formatCount(summaryCounts.changed, locale) })}</span>
                {summaryCounts.added > 0 ? <span className="vcs-add">+{formatCount(summaryCounts.added, locale)}</span> : null}
                {summaryCounts.deleted > 0 ? <span className="vcs-del">−{formatCount(summaryCounts.deleted, locale)}</span> : null}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <ShaButton sha={commitState.commit?.sha ?? node} t={t} />
            <span className="vcs-detail-refs">
              {refs.map(reference => <RefBadge key={`${reference.kind}:${reference.name}`} reference={reference} />)}
            </span>
          </>
        )}
        <span className="vcs-detail-spacer" />
        <Segmented
          value={split ? 'split' : 'unified'}
          label={t('diff.layout')}
          options={[
            { value: 'unified', label: t('diff.unified') },
            { value: 'split', label: t('diff.split') },
          ]}
          onChange={value => { onToggleSplit(value === 'split') }}
        />
        <Button
          className="vcs-diff-wrap"
          aria-pressed={wrap}
          title={wrap ? t('diff.unwrap') : t('diff.wrap')}
          onClick={() => { onToggleWrap(!wrap) }}
        >
          {t('diff.wrapShort')}
        </Button>
      </div>
      <div className="vcs-detail-body" data-nav={navInline ? 'inline' : 'side'}>
        {!navInline && nav !== null ? <aside className="vcs-detail-nav">{nav}</aside> : null}
        <DiffStream
          api={api}
          repo={repo}
          sections={sections}
          groupLabels={groupLabels}
          defaults={defaults}
          folds={folds}
          onToggleFold={onToggleFold}
          split={split}
          wrap={wrap}
          revision={revision}
          cache={cache}
          initialAnchor={initialAnchor}
          onReading={onStreamReading}
          control={streamControl}
          before={before}
          t={t}
          locale={locale}
        />
      </div>
    </div>
  )
}
