/**
 * The detail pane for one working-tree or commit file comparison.
 *
 * It owns the request lifecycle for `vcs.diff` and the presentation controls;
 * the rendered hunks come from the vendored `FileDiff` component.
 */

import { useEffect, useState } from 'react'
import { FileDiff } from '../diff/FileDiff.jsx'
import { statusKey, splitPath, formatCount, lineCounts } from '../format.js'
import { BackIcon, Button, IconButton, RefreshIcon, Segmented } from '../ui.jsx'

/** A comparison target or none. */
function targetKey(target) {
  return target === null ? '' : `${target.scope}|${target.path}|${target.oldPath ?? ''}|${target.rev ?? ''}`
}

/**
 * Render the selected file's comparison.
 * @param {{ api: object, repo: string | null, target: object | null, entry: object | null, t: Function, locale?: string, split: boolean, wrap: boolean, onToggleSplit: Function, onToggleWrap: Function, onBack: Function, narrow: boolean }} props - panel state.
 */
export function DiffPane({ api, repo, target, entry, t, locale, split, wrap, onToggleSplit, onToggleWrap, onBack, narrow, revision = 0 }) {
  const [state, setState] = useState({ status: 'idle', diff: null, error: null })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (target === null || repo === null) {
      setState({ status: 'idle', diff: null, error: null })
      return undefined
    }
    const controller = new AbortController()
    setState({ status: 'loading', diff: null, error: null })
    api.diff(repo, target, controller.signal).then(diff => {
      setState({ status: 'ready', diff, error: null })
    }).catch(error => {
      if (error?.name === 'AbortError') return
      setState({
        status: error?.code === 'not-found' ? 'missing' : 'error',
        diff: null,
        error,
      })
    })
    return () => { controller.abort() }
  }, [api, repo, targetKey(target), attempt, revision])

  if (target === null) {
    return (
      <div className="vcs-detail vcs-detail-empty">
        <p className="vcs-empty-title">{t('diff.selectFile')}</p>
        <p className="vcs-note">{t('diff.selectFileHint')}</p>
      </div>
    )
  }

  const counts = lineCounts(entry)
  const parts = splitPath(target.path)
  const diffState = state.status === 'ready'
    ? state.diff
    : state.status === 'loading'
      ? 'loading'
      : state.status === 'missing'
        ? 'missing'
        : state.status === 'error'
          ? 'error'
          : 'loading'

  return (
    <div className="vcs-detail">
      <div className="vcs-detail-header">
        {narrow || target.scope === 'commit' ? (
          <IconButton label={t('diff.back')} onClick={onBack}><BackIcon /></IconButton>
        ) : null}
        <span className={`vcs-status vcs-status-${entry?.status ?? 'M'}`} aria-hidden="true">
          {entry?.status ?? 'M'}
        </span>
        <span className="vcs-sr-only">{t(statusKey(entry?.status ?? 'M'))}</span>
        <span className="vcs-detail-path" title={target.oldPath === undefined ? target.path : `${target.oldPath} → ${target.path}`}>
          {target.oldPath === undefined ? null : <span className="vcs-dim">{splitPath(target.oldPath).base} → </span>}
          {parts.dir === '' ? null : <span className="vcs-dim">{parts.dir}</span>}
          <strong>{parts.base}</strong>
        </span>
        {counts.added === null || counts.deleted === null ? null : (
          <span className="vcs-detail-stat">
            {counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added, locale)}</span> : null}
            {counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted, locale)}</span> : null}
          </span>
        )}
        <span className="vcs-detail-spacer" />
        <Segmented
          value={split ? 'split' : 'unified'}
          label={t('diff.layout')}
          options={[
            { value: 'unified', label: t('diff.unified'), title: t('diff.unified') },
            { value: 'split', label: t('diff.split'), title: t('diff.split') },
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
        <IconButton label={t('top.refresh')} onClick={() => { setAttempt(value => value + 1) }}>
          <RefreshIcon />
        </IconButton>
      </div>
      <div className="vcs-detail-body">
        <FileDiff
          state={diffState}
          split={split}
          wrap={wrap}
          retry={() => { setAttempt(value => value + 1) }}
          t={t}
          locale={locale}
        />
      </div>
    </div>
  )
}
