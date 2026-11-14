/**
 * The History detail pane: one commit's metadata, message, and changed files.
 *
 * Selecting a file swaps this pane for its comparison; the comparison's back
 * action returns to the commit without losing the selected commit itself.
 */

import { useEffect, useState } from 'react'
import { DiffPane } from '../changes/DiffPane.jsx'
import { errorMessage, formatCount, formatDateTime, lineCounts, shortSha, splitPath, statusKey } from '../format.js'
import { messageBody } from './commits.js'
import { BackIcon, Button, CheckIcon, CopyIcon, IconButton, RefBadge, Spinner } from '../ui.jsx'

/**
 * Render a commit, or the selected file's comparison inside it.
 * @param {{ api: object, repo: string | null, sha: string | null, summary: object | null, selectedFile: string | null, onSelectFile: Function, isLoaded: (sha: string) => boolean, onSelectCommit: (sha: string) => void, split: boolean, wrap: boolean, onToggleSplit: Function, onToggleWrap: Function, onBack: Function, narrow: boolean, t: Function, locale?: string }} props - commit detail state.
 */
export function CommitPane({
  api, repo, sha, summary, selectedFile, onSelectFile, isLoaded, onSelectCommit, split, wrap,
  onToggleSplit, onToggleWrap, onBack, narrow, t, locale, revision = 0,
}) {
  const [state, setState] = useState({ status: 'idle', commit: null, truncated: false, error: null })
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (sha === null || repo === null) {
      setState({ status: 'idle', commit: null, truncated: false, error: null })
      return undefined
    }
    const controller = new AbortController()
    setState({ status: 'loading', commit: null, truncated: false, error: null })
    api.commit(repo, sha, controller.signal).then(answer => {
      setState({ status: 'ready', commit: answer.commit, truncated: answer.truncated === true, error: null })
    }).catch(error => {
      if (error?.name === 'AbortError') return
      setState({ status: 'error', commit: null, truncated: false, error })
    })
    return () => { controller.abort() }
  }, [api, repo, sha, attempt, revision])

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => { setCopied(false) }, 1600)
    return () => { clearTimeout(timer) }
  }, [copied])

  if (sha === null) {
    return (
      <div className="vcs-detail vcs-detail-empty">
        <p className="vcs-empty-title">{t('commit.selectCommit')}</p>
        <p className="vcs-note">{t('commit.selectCommitHint')}</p>
      </div>
    )
  }

  const detail = state.commit
  const body = messageBody(detail?.message)
  // Log rows mark the branch HEAD points to; the detail's for-each-ref list cannot.
  const refs = summary?.refs ?? detail?.refs ?? []
  const file = selectedFile === null ? null : detail?.files.find(entry => entry.path === selectedFile) ?? null

  if (file !== null) {
    return (
      <DiffPane
        api={api}
        repo={repo}
        target={{ scope: 'commit', path: file.path, oldPath: file.origPath, rev: sha }}
        entry={file}
        t={t}
        locale={locale}
        split={split}
        wrap={wrap}
        onToggleSplit={onToggleSplit}
        onToggleWrap={onToggleWrap}
        onBack={() => { onSelectFile(null) }}
        narrow={narrow}
      />
    )
  }

  const copy = () => {
    const full = detail?.sha ?? sha
    if (navigator.clipboard?.writeText === undefined) {
      setCopied(false)
      return
    }
    navigator.clipboard.writeText(full).then(() => { setCopied(true) }).catch(() => { setCopied(false) })
  }

  return (
    <div className="vcs-detail">
      <div className="vcs-detail-header">
        {narrow ? <IconButton label={t('commit.back')} onClick={onBack}><BackIcon /></IconButton> : null}
        <Button className="vcs-sha-button" onClick={copy} title={t('commit.copySha')} aria-label={t('commit.copySha')}>
          <code>{shortSha(detail?.sha ?? sha)}</code>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
        <span className="vcs-detail-path"><strong>{summary?.subject ?? detail?.subject ?? ''}</strong></span>
        <span className="vcs-detail-spacer" />
        {refs.map(reference => <RefBadge key={`${reference.kind}:${reference.name}`} reference={reference} />)}
      </div>
      {state.status !== 'ready' && state.status !== 'error' ? (
        <div className="vcs-detail-body vcs-detail-status"><Spinner label={t('commit.loading')} /><p className="vcs-note">{t('commit.loading')}</p></div>
      ) : state.status === 'error' ? (
        <div className="vcs-detail-body vcs-detail-status">
          <p className="vcs-empty-title">{t('commit.error')}</p>
          <p className="vcs-note">{errorMessage(t, state.error)}</p>
          <Button onClick={() => { setAttempt(value => value + 1) }}>{t('error.retry')}</Button>
        </div>
      ) : (
        <div className="vcs-detail-body vcs-commit-body">
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
          <div className="vcs-commit-files">
            <div className="vcs-group-header">
              <span className="vcs-group-title">{t('commit.files', { count: formatCount(detail.files.length, locale) })}</span>
              {state.truncated ? <span className="vcs-note">{t('commit.filesTruncated', { count: formatCount(detail.files.length, locale) })}</span> : null}
            </div>
            {detail.files.length === 0 ? <p className="vcs-note">{t('commit.noFiles')}</p> : detail.files.map(entry => {
              const counts = lineCounts(entry)
              return (
                <button key={entry.path} type="button" className="vcs-row vcs-file-row" title={entry.path} onClick={() => { onSelectFile(entry.path) }}>
                  <span className={`vcs-status vcs-status-${entry.status}`} aria-hidden="true">{entry.status}</span>
                  <span className="vcs-sr-only">{t(statusKey(entry.status))}</span>
                  <span className="vcs-row-name">
                    {entry.origPath === undefined ? null : <span className="vcs-dim">{splitPath(entry.origPath).base} → </span>}
                    <span className="vcs-dim">{splitPath(entry.path).dir}</span><strong>{splitPath(entry.path).base}</strong>
                  </span>
                  {entry.binary ? <span className="vcs-row-stat vcs-dim">{t('changes.binary')}</span> : (
                    <span className="vcs-row-stat">
                      {counts.added !== null && counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added, locale)}</span> : null}
                      {counts.deleted !== null && counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted, locale)}</span> : null}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
