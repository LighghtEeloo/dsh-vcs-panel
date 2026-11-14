/**
 * The Changes list: staged, unstaged, and untracked groups as a flat row list.
 *
 * Rows arrive already flattened (directories expanded/collapsed, untracked
 * children attached) so the keyboard order and the rendered order are the same
 * list. Each row carries the index the root uses to move focus.
 */

import { formatCount, lineCounts, splitPath, statusKey } from '../format.js'
import { Chevron, Spinner } from '../ui.jsx'

/** One group heading plus its rows. */
function Group({ group, t, activeIndex, onSelect, onToggle }) {
  if (group.rows.length === 0) return null
  return (
    <div className="vcs-group" role="group" aria-label={group.label}>
      <div className="vcs-group-header">
        <span className="vcs-group-title">{group.label}</span>
      </div>
      {group.rows.map(row => (
        <Row
          key={row.index}
          row={row}
          t={t}
          active={row.index === activeIndex}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

/** One directory, loading, or file row. */
function Row({ row, t, active, onSelect, onToggle }) {
  if (row.kind === 'loading') {
    return (
      <div className="vcs-row vcs-loading-row" style={{ paddingLeft: `${20 + row.depth * 14}px` }} role="status">
        <Spinner label={t('changes.loadingDirectory')} />
        <span className="vcs-row-name vcs-dim">{t('changes.loadingDirectory')}</span>
      </div>
    )
  }
  if (row.kind === 'dir') {
    return (
      <button
        type="button"
        className="vcs-row vcs-dir-row"
        data-row-index={row.index}
        aria-expanded={row.expanded}
        aria-current={active ? 'true' : undefined}
        tabIndex={active ? 0 : -1}
        style={{ paddingLeft: `${8 + row.depth * 14}px` }}
        onClick={() => { onToggle(row) }}
        title={row.path}
      >
        <Chevron open={row.expanded} />
        <span className="vcs-row-name">{row.name}</span>
      </button>
    )
  }
  const counts = lineCounts(row.entry)
  return (
    <button
      type="button"
      className="vcs-row vcs-file-row"
      data-row-index={row.index}
      aria-current={active ? 'true' : undefined}
      tabIndex={active ? 0 : -1}
      style={{ paddingLeft: `${8 + row.depth * 14}px` }}
      onClick={() => { onSelect(row) }}
      title={row.path}
    >
      <span className={`vcs-status vcs-status-${row.entry.status}`} aria-hidden="true">
        {row.entry.status}
      </span>
      <span className="vcs-sr-only">{t(statusKey(row.entry.status))}</span>
      <span className="vcs-row-name">
        {row.entry.origPath === undefined ? null : <span className="vcs-dim">{splitPath(row.entry.origPath).base} → </span>}
        {row.name}
      </span>
      {row.entry.binary ? (
        <span className="vcs-row-stat vcs-dim">{t('changes.binary')}</span>
      ) : (
        <span className="vcs-row-stat">
          {counts.added === null || counts.deleted === null ? null : (
            <>
              {counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added)}</span> : null}
              {counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted)}</span> : null}
            </>
          )}
        </span>
      )}
    </button>
  )
}

/**
 * Render every non-empty group, or the clean state.
 * @param {{ groups: object[], t: Function, empty: boolean, activeIndex: number, onSelect: Function, onToggle: Function, truncated: boolean }} props - built groups and copy.
 */
export function ChangesList({ groups, t, empty, loading, activeIndex, onSelect, onToggle, truncated }) {
  if (loading) {
    return <div className="vcs-empty"><Spinner label={t('changes.loading')} /><p className="vcs-note">{t('changes.loading')}</p></div>
  }
  if (empty) {
    return <div className="vcs-empty"><p className="vcs-empty-title">{t('changes.clean')}</p><p className="vcs-note">{t('changes.cleanHint')}</p></div>
  }
  return (
    <div className="vcs-groups" aria-label={t('tabs.changes')}>
      {groups.map(group => (
        <Group key={group.id} group={group} t={t} activeIndex={activeIndex} onSelect={onSelect} onToggle={onToggle} />
      ))}
      {truncated ? <p className="vcs-note">{t('changes.truncatedMany')}</p> : null}
    </div>
  )
}
