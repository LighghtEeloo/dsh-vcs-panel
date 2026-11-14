/**
 * Turn-tail entry for a completed Turn that changed files.
 *
 * It replaces the file list DSH's changed-files card used to show with one
 * compact control whose target is the version control view. The button carries
 * no state of its own; the definition in `turn.js` decides whether the entry
 * appears.
 */

import { turnChangedFiles } from './turn.js'

/** The git-branch glyph; drawn inline so the bundle needs no icon package. */
function GitBranchIcon() {
  return (
    <svg className="vcs-turn-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.55" />
      <circle cx="4.5" cy="12.5" r="1.55" />
      <circle cx="11.5" cy="5.5" r="1.55" />
      <path d="M4.5 5.05v5.9" />
      <path d="M11.5 7.05c0 2.2-2.3 2.55-4.45 3.1" />
    </svg>
  )
}

/**
 * Render the VCS entry at the end of a Turn.
 * @param {object} props - Turn Location, localized copy, and the view opener.
 * @param {object} props.turn - Turn Location with this definition's data.
 * @param {(key: string) => string} props.t - this plugin's translator.
 * @param {() => void} props.onOpen - selects the version control view.
 * @returns {object | null} the entry, or null when the Turn changed no files.
 */
export function TurnTailChanges({ turn, t, onOpen }) {
  if (!turnChangedFiles(turn)) return null
  const label = t('turn.openHint')
  return (
    <div className="vcs-turn-tail">
      <button type="button" className="vcs-turn-icon" title={label} aria-label={label} onClick={onOpen}>
        <GitBranchIcon />
      </button>
    </div>
  )
}
