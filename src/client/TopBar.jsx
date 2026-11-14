/**
 * The panel header: repository choice, branch facts, history range, the
 * read-only marker, and refresh. The working-tree summary lives on the
 * timeline's first row, next to the history it precedes.
 */

import { Arrow, BranchIcon, IconButton, LockIcon, RefreshIcon, Segmented, Spinner } from './ui.jsx'

/**
 * Render the header bar.
 * @param {{ repositories: object[], repo: string | null, onRepoChange: Function, status: object | null, refMode: string, onRefMode: (ref: string) => void, onRefresh: Function, refreshing: boolean, t: Function }} props - panel header state.
 */
export function TopBar({ repositories, repo, onRepoChange, status, refMode, onRefMode, onRefresh, refreshing, t }) {
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
      <Segmented
        value={refMode}
        label={t('history.refLabel')}
        options={[
          { value: 'HEAD', label: t('history.head'), title: t('history.headTitle') },
          { value: 'all', label: t('history.all'), title: t('history.allTitle') },
        ]}
        onChange={onRefMode}
      />
      <span className="vcs-topbar-spacer" />
      <span className="vcs-readonly" role="img" aria-label={t('top.readonly')} title={t('top.readonlyHint')}>
        <LockIcon />
      </span>
      <IconButton label={t('top.refresh')} onClick={onRefresh} disabled={refreshing} className={refreshing ? 'vcs-refreshing' : ''}>
        {refreshing ? <Spinner label={t('top.refreshing')} /> : <RefreshIcon />}
      </IconButton>
    </div>
  )
}
