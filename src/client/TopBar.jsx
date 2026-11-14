/**
 * The panel header: repository choice, working-state facts, history range, the
 * read-only marker, and refresh.
 *
 * A backend with a separate working tree shows its branch and ahead/behind
 * counts. A backend whose working copy is a commit shows `@`, its change id,
 * and the refs pointing at it. The range options come from the backend's
 * capabilities, so a future backend only supplies labels.
 */

import {
  Arrow, BranchIcon, IconButton, LockIcon, RefreshIcon, RefBadge, Segmented, Spinner,
} from './ui.jsx'
import { shortChangeId } from './format.js'

/** Range choices when no backend has answered yet. */
const FALLBACK_RANGES = [
  { value: 'HEAD', label: 'history.head', title: 'history.headTitle' },
  { value: 'all', label: 'history.all', title: 'history.allTitle' },
]

/** Ref badges shown in the header before the rest are left to the timeline. */
const HEADER_REFS = 3

/**
 * Render the header bar.
 * @param {{ repositories: object[], repo: string | null, onRepoChange: Function, status: object | null, capabilities: object | null, refMode: string, onRefMode: (ref: string) => void, onRefresh: Function, refreshing: boolean, t: Function }} props - panel header state.
 */
export function TopBar({
  repositories, repo, onRepoChange, status, capabilities, refMode, onRefMode, onRefresh, refreshing, t,
}) {
  const branch = status?.branch
  const workingCopy = status?.workingCopy
  const showsWorkingCopy = capabilities?.workingCopy === 'commit'
  let branchText = ''
  if (branch !== undefined && branch !== null) {
    if (branch.unborn) branchText = t('top.unborn')
    else if (branch.detached) branchText = t('top.detached')
    else branchText = branch.name ?? t('top.detached')
  }
  const ahead = branch?.ahead ?? 0
  const behind = branch?.behind ?? 0
  const ranges = capabilities?.ranges ?? FALLBACK_RANGES
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
          {ahead > 0 ? <span className="vcs-ahead"><Arrow up />{ahead}</span> : null}
          {behind > 0 ? <span className="vcs-behind"><Arrow />{behind}</span> : null}
        </span>
      )}
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
      <span className="vcs-topbar-spacer" />
      <span
        className="vcs-readonly"
        role="img"
        aria-label={t('top.readonly')}
        title={capabilities?.snapshots === true ? t('top.readonlyHintSnapshots') : t('top.readonlyHint')}
      >
        <LockIcon />
      </span>
      <IconButton label={t('top.refresh')} onClick={onRefresh} disabled={refreshing} className={refreshing ? 'vcs-refreshing' : ''}>
        {refreshing ? <Spinner label={t('top.refreshing')} /> : <RefreshIcon />}
      </IconButton>
    </div>
  )
}
