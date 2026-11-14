/**
 * The file navigation of the detail pane, shared by the working tree and
 * commits: groups of files drawn as collapsible directory trees.
 *
 * Rows arrive flattened, so the keyboard order and the rendered order are the
 * same list. A file row does not open anything: it moves the diff stream to
 * that file's section, and the row of the section being read is marked.
 */

import { formatCount, lineCounts, splitPath, statusKey } from '../format.js'
import { Chevron, Spinner } from '../ui.jsx'
import { sectionKey } from './detail.js'

/** Indentation per tree level, in CSS pixels. */
const INDENT = 14

/** One directory, loading, or file row. */
function Row({ row, t, locale, focusable, reading, onActivate }) {
  const indent = { paddingLeft: `${8 + row.depth * INDENT}px` }
  if (row.kind === 'loading') {
    return (
      <div className="vcs-row vcs-loading-row" style={{ paddingLeft: `${20 + row.depth * INDENT}px` }} role="status">
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
        tabIndex={focusable ? 0 : -1}
        style={indent}
        onClick={() => { onActivate(row) }}
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
      aria-current={reading ? 'location' : undefined}
      tabIndex={focusable ? 0 : -1}
      style={indent}
      onClick={() => { onActivate(row) }}
      title={row.entry.origPath === undefined ? row.path : `${row.entry.origPath} → ${row.path}`}
    >
      <span className={`vcs-status vcs-status-${row.entry.status}`} aria-hidden="true">{row.entry.status}</span>
      <span className="vcs-sr-only">{t(statusKey(row.entry.status))}</span>
      <span className="vcs-row-name">
        {row.entry.origPath === undefined ? null : <span className="vcs-dim">{splitPath(row.entry.origPath).base} → </span>}
        {row.name}
      </span>
      {row.entry.binary ? (
        <span className="vcs-row-stat vcs-dim">{t('changes.binary')}</span>
      ) : (
        <span className="vcs-row-stat">
          {counts.added !== null && counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added, locale)}</span> : null}
          {counts.deleted !== null && counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted, locale)}</span> : null}
        </span>
      )}
    </button>
  )
}

/**
 * Render the navigation.
 * @param {{ groups: Array<{ id: string, label: string, rows: object[] }>, cursor: number, readingKey: string | null, onActivate: (row: object) => void, onMove: (delta: number) => void, onLeave: () => void, truncated: boolean, t: Function, locale?: string }} props - built groups and handlers.
 */
export function FileNav({ groups, cursor, readingKey, onActivate, onMove, onLeave, truncated, t, locale }) {
  /** Keys of the navigation: move, activate, return to the timeline. */
  const onKeyDown = event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault()
      onMove(1)
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault()
      onMove(-1)
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onLeave()
    }
  }

  return (
    <nav className="vcs-nav" aria-label={t('nav.label')} data-zone="nav" onKeyDown={onKeyDown}>
      {groups.map(group => (
        <div key={group.id} className="vcs-group" role="group" aria-label={group.label}>
          <div className="vcs-group-header"><span className="vcs-group-title">{group.label}</span></div>
          {group.rows.map(row => (
            <Row
              key={row.index}
              row={row}
              t={t}
              locale={locale}
              focusable={row.index === cursor}
              reading={row.kind === 'file' && sectionKey(row.group, row.path) === readingKey}
              onActivate={onActivate}
            />
          ))}
        </div>
      ))}
      {truncated ? <p className="vcs-note">{t('changes.truncatedMany')}</p> : null}
    </nav>
  )
}
