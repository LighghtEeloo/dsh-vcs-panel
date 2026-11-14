/**
 * The panel header: repository choice, branch facts, change summary, refresh.
 */

import { formatCount } from './format.js'
import { Arrow, BranchIcon, IconButton, RefreshIcon, Spinner } from './ui.jsx'

/**
 * Render the header bar.
 * @param {{ repositories: object[], repo: string | null, onRepoChange: Function, status: object | null, changed: number, onRefresh: Function, refreshing: boolean, t: Function, locale?: string }} props - panel header state.
 */
export function TopBar({ repositories, repo, onRepoChange, status, changed, onRefresh, refreshing, t, locale }) {
  const branch = status?.branch
  let branchText = ''
  if (branch !== undefined && branch !== null) {
    if (branch.unborn) branchText = t('top.unborn')
    else if (branch.detached) branchText = t('top.detached')
    else branchText = branch.name ?? t('top.detached')
  }
  const ahead = branch?.ahead ?? 0
  const behind = branch?.behind ?? 0
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
      {branchText === '' ? null : (
        <span className="vcs-branch" title={branch?.upstream ?? undefined}>
          <BranchIcon />
          <span className="vcs-branch-name">{branchText}</span>
          {ahead > 0 ? <span className="vcs-ahead"><Arrow up />{ahead}</span> : null}
          {behind > 0 ? <span className="vcs-behind"><Arrow />{behind}</span> : null}
        </span>
      )}
      <span className="vcs-changed">
        {changed > 0
          ? <>{t('top.changed', { count: formatCount(changed, locale) })}</>
          : status === null ? null : <span className="vcs-dim">{t('changes.clean')}</span>}
      </span>
      <span className="vcs-topbar-spacer" />
      <span className="vcs-readonly-badge">{t('top.readonly')}</span>
      <IconButton label={t('top.refresh')} onClick={onRefresh} disabled={refreshing} className={refreshing ? 'vcs-refreshing' : ''}>
        {refreshing ? <Spinner label={t('top.refreshing')} /> : <RefreshIcon />}
      </IconButton>
    </div>
  )
}
