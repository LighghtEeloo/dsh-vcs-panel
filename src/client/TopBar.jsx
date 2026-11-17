/**
 * The panel header, left to right: repository choice, history range,
 * working-state facts with sync, the panel's message, then the read-only
 * marker and refresh.
 *
 * A backend with a separate working tree shows its branch; when it can sync,
 * the ahead/behind counts sit on the sync button beside the branch, so the
 * numbers and the action that settles them are one control. The message
 * (a sync outcome or a failure) follows them, so it reads next to what it
 * reports on. A backend whose working copy is a commit shows `@`, its change
 * id, and the refs pointing at it. The range options come from the backend's
 * capabilities, so a future backend only supplies labels.
 */

import { useEffect, useState } from 'react'
import {
  Arrow, BranchIcon, IconButton, LockIcon, RefreshIcon, RefBadge, Segmented, SyncIcon, Turning,
} from './ui.jsx'
import { formatCount, shortChangeId } from './format.js'

/** Range choices when no backend has answered yet. */
const FALLBACK_RANGES = [
  { value: 'HEAD', label: 'history.head', title: 'history.headTitle' },
  { value: 'all', label: 'history.all', title: 'history.allTitle' },
]

/** Ref badges shown in the header before the rest are left to the timeline. */
const HEADER_REFS = 3

/** Ahead/behind counts as two small arrows; zero sides are left out. */
function AheadBehind({ ahead, behind }) {
  return (
    <>
      {ahead > 0 ? <span className="vcs-ahead"><Arrow up />{ahead}</span> : null}
      {behind > 0 ? <span className="vcs-behind"><Arrow />{behind}</span> : null}
    </>
  )
}

/**
 * The sync control: icon plus the counts it would settle.
 *
 * It stays focusable while unavailable or running (`aria-disabled` rather
 * than `disabled`), so keyboard focus is not dropped mid-sync and the reason
 * it is unavailable remains readable.
 * @param {{ branch: object, syncing: boolean, onSync: Function, t: Function, locale?: string }} props - branch facts and sync state.
 */
function SyncButton({ branch, syncing, onSync, t, locale }) {
  const upstream = branch.upstream
  const ahead = branch.ahead ?? 0
  const behind = branch.behind ?? 0
  const available = upstream !== null && upstream !== undefined
  const label = available
    ? t('top.syncLabel', { upstream, ahead: formatCount(ahead, locale), behind: formatCount(behind, locale) })
    : t('top.syncNoUpstream')
  const inert = syncing || !available
  return (
    <button
      type="button"
      className="vcs-sync"
      aria-label={label}
      aria-disabled={inert ? 'true' : undefined}
      aria-busy={syncing ? 'true' : undefined}
      title={available ? `${label}\n${t('top.syncHint')}` : label}
      onClick={() => { if (!inert) onSync() }}
    >
      {/* The icon itself turns while the sync runs; the bar under the header announces it. */}
      <Turning turning={syncing} restEvery={180}><SyncIcon /></Turning>
      <AheadBehind ahead={ahead} behind={behind} />
    </button>
  )
}

/**
 * Render the header bar. `refreshing` is a refresh the refresh button
 * started; `syncing` covers a sync and the refresh it starts afterwards, so
 * one icon turns from the click until the counts it settles are back.
 * @param {{ repositories: object[], repo: string | null, onRepoChange: Function, status: object | null, capabilities: object | null, refMode: string, onRefMode: (ref: string) => void, onRefresh: Function, refreshing: boolean, revalidating?: boolean, onSync: Function, syncing: boolean, notice?: { tone: 'error' | 'info', text: string } | null, t: Function, locale?: string }} props - panel header state.
 */
export function TopBar({
  repositories, repo, onRepoChange, status, capabilities, refMode, onRefMode, onRefresh, refreshing,
  revalidating = false, onSync, syncing, notice, t, locale,
}) {
  // Work on data already on screen shows as one thin bar under the header,
  // whether the user asked for it (refresh, sync) or the panel did (a
  // refresh on becoming visible); the content stays put meanwhile.
  const busy = refreshing || syncing || revalidating
  const branch = status?.branch
  const workingCopy = status?.workingCopy
  const showsWorkingCopy = capabilities?.workingCopy === 'commit'
  let branchText = ''
  if (branch !== undefined && branch !== null) {
    if (branch.unborn) branchText = t('top.unborn')
    else if (branch.detached) branchText = t('top.detached')
    else branchText = branch.name ?? t('top.detached')
  }
  // Sync needs a named branch with commits; the button then owns the counts.
  const syncable = capabilities?.sync === true
    && branch !== undefined && branch !== null
    && !branch.unborn && !branch.detached && typeof branch.name === 'string'
  const ranges = capabilities?.ranges ?? FALLBACK_RANGES
  let readonlyLabel = t('top.readonly')
  let readonlyHint = t('top.readonlyHint')
  if (capabilities?.sync === true) {
    readonlyLabel = t('top.readonlySync')
    readonlyHint = t('top.readonlyHintSync')
  } else if (capabilities?.snapshots === true) {
    readonlyHint = t('top.readonlyHintSnapshots')
  }
  return (
    <div className="vcs-topbar">
      <select
        className="vcs-repo-select"
        aria-label={t('top.repositories')}
        value={repo ?? ''}
        disabled={repositories.length === 0}
        onChange={event => { onRepoChange(event.currentTarget.value === '' ? null : event.currentTarget.value) }}
      >
        {repositories.length === 0 ? <option value="">{t('top.noRepository')}</option> : null}
        {repositories.map(entry => (
          <option key={entry.path} value={entry.path}>{entry.enclosing ? entry.name : `${entry.name}  (${entry.path})`}</option>
        ))}
      </select>
      <Segmented
        value={refMode}
        label={t('history.refLabel')}
        options={ranges.map(range => ({
          value: range.value,
          label: t(range.label),
          title: t(range.title),
        }))}
        onChange={onRefMode}
      />
      {showsWorkingCopy ? (
        workingCopy === null || workingCopy === undefined ? null : (
          <span className="vcs-working-copy" title={t('top.workingCopyTitle')}>
            <span className="vcs-working-badge">@</span>
            {typeof workingCopy.changeId === 'string' && workingCopy.changeId !== ''
              ? <code className="vcs-working-change">{shortChangeId(workingCopy.changeId)}</code>
              : null}
            {workingCopy.refs.slice(0, HEADER_REFS).map(reference => (
              <RefBadge key={`${reference.kind}:${reference.name}`} reference={reference} />
            ))}
            {workingCopy.conflict === true ? <span className="vcs-conflict-badge">{t('status.conflict')}</span> : null}
          </span>
        )
      ) : branchText === '' ? null : (
        <span className="vcs-branch" title={branch?.upstream ?? undefined}>
          <BranchIcon />
          <span className="vcs-branch-name">{branchText}</span>
          {syncable ? null : <AheadBehind ahead={branch?.ahead ?? 0} behind={branch?.behind ?? 0} />}
        </span>
      )}
      {syncable ? <SyncButton branch={branch} syncing={syncing} onSync={onSync} t={t} locale={locale} /> : null}
      {notice === null || notice === undefined ? null : (
        <p
          className={notice.tone === 'info' ? 'vcs-notice vcs-notice-info' : 'vcs-notice'}
          role={notice.tone === 'info' ? 'status' : 'alert'}
          title={notice.text}
        >
          {notice.text}
        </p>
      )}
      <span className="vcs-topbar-spacer" />
      <span
        className="vcs-readonly"
        role="img"
        aria-label={readonlyLabel}
        title={readonlyHint}
      >
        <LockIcon />
      </span>
      <IconButton label={t('top.refresh')} onClick={() => { onRefresh() }} busy={refreshing}>
        <Turning turning={refreshing}><RefreshIcon /></Turning>
      </IconButton>
      <ProgressLine busy={busy} label={syncing ? t('top.syncing') : t('top.refreshing')} />
    </div>
  )
}

/** Milliseconds the progress line takes to fade out; matches `.vcs-progress` in `styles.css`. */
const PROGRESS_FADE = 240

/**
 * The thin sweep along the header's bottom edge. It stays mounted, so it
 * fades out from wherever its fade-in had got to instead of vanishing
 * mid-sweep; the sweep itself only runs while busy and during the fade.
 * @param {{ busy: boolean, label: string }} props - whether work is running and what to announce.
 */
function ProgressLine({ busy, label }) {
  // Set once work starts; cleared when the fade-out after it has finished.
  const [sweeping, setSweeping] = useState(busy)
  useEffect(() => {
    if (busy) {
      setSweeping(true)
      return undefined
    }
    const timer = setTimeout(() => { setSweeping(false) }, PROGRESS_FADE)
    return () => { clearTimeout(timer) }
  }, [busy])
  return (
    <span
      className="vcs-progress"
      role="status"
      data-busy={busy ? 'true' : undefined}
      data-sweeping={busy || sweeping ? 'true' : undefined}
    >
      {busy ? <span className="vcs-sr-only">{label}</span> : null}
    </span>
  )
}
