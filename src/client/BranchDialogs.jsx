/**
 * The branch actions that need a decision: rename, delete, merge, and rebase.
 *
 * The dialog sits over the panel, names the branch it acts on, and states what
 * the action does before it runs. A delete that Git reports as not fully
 * merged keeps the dialog open and turns its confirmation into an explicit
 * "delete anyway", so removing unmerged commits is always a second, informed
 * click. Escape cancels unless the write is already running; focus stays
 * inside the dialog while it is open.
 */

import { useEffect, useRef, useState } from 'react'

import { errorMessage } from './format.js'

/** Elements a Tab press may land on inside the dialog. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The copy and confirmation label for one dialog kind. */
const DIALOG_COPY = {
  rename: { title: 'branch.renameTitle', action: 'branch.renameAction' },
  delete: { title: 'branch.deleteTitle', action: 'branch.deleteAction' },
  merge: { title: 'branch.mergeTitle', action: 'branch.mergeAction' },
  rebase: { title: 'branch.rebaseTitle', action: 'branch.rebaseAction' },
}

/**
 * Render the open branch dialog.
 * @param {{ request: { kind: 'rename'|'delete'|'merge'|'rebase', branch: string, current?: string | null } | null, error: object | null, busy: boolean, onCancel: Function, onConfirm: Function, t: Function }} props - dialog state and callbacks.
 */
export function BranchDialog({ request, error, busy, onCancel, onConfirm, t }) {
  const rootRef = useRef(null)
  const [name, setName] = useState(request?.branch ?? '')

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const target = root.querySelector('[data-autofocus]') ?? root.querySelector(FOCUSABLE)
    target?.focus()
    if (target?.tagName === 'INPUT') target.select()
  }, [])

  if (request === null) return null

  const copy = DIALOG_COPY[request.kind]
  const unmerged = request.kind === 'delete' && error?.code === 'branch-unmerged'
  const trimmed = name.trim()
  const canSubmit = !busy && (request.kind !== 'rename' || (trimmed !== '' && trimmed !== request.branch))
  const confirmLabel = request.kind === 'delete' && unmerged
    ? t('branch.deleteAnyway')
    : t(copy.action)

  const submit = () => {
    if (!canSubmit) return
    onConfirm(request.kind === 'rename' ? { name: trimmed } : { force: unmerged })
  }

  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const items = Array.from(rootRef.current?.querySelectorAll(FOCUSABLE) ?? [])
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement)
    if (event.shiftKey && index <= 0) {
      event.preventDefault()
      items[items.length - 1]?.focus()
    } else if (!event.shiftKey && (index < 0 || index === items.length - 1)) {
      event.preventDefault()
      items[0]?.focus()
    }
  }

  return (
    <div
      className="vcs-dialog-layer"
      onPointerDown={event => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
      onKeyDown={onKeyDown}
    >
      <form
        ref={rootRef}
        className="vcs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vcs-branch-dialog-title"
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        <h2 className="vcs-dialog-title" id="vcs-branch-dialog-title">{t(copy.title)}</h2>
        {request.kind === 'rename' ? (
          <>
            <p className="vcs-dialog-text">{t('branch.renameText', { branch: request.branch })}</p>
            <label className="vcs-dialog-label" htmlFor="vcs-branch-name">{t('branch.newName')}</label>
            <input
              id="vcs-branch-name"
              className="vcs-dialog-input"
              type="text"
              value={name}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              disabled={busy}
              data-autofocus=""
              onChange={event => { setName(event.currentTarget.value) }}
            />
          </>
        ) : null}
        {request.kind === 'delete' ? (
          <>
            <p className="vcs-dialog-text">{t('branch.deleteText', { branch: request.branch })}</p>
            {unmerged ? (
              <p className="vcs-dialog-warning" role="alert">{errorMessage(t, error)}</p>
            ) : null}
          </>
        ) : null}
        {request.kind === 'merge' ? (
          <p className="vcs-dialog-text">{t('branch.mergeText', { branch: request.branch, current: request.current ?? '' })}</p>
        ) : null}
        {request.kind === 'rebase' ? (
          <p className="vcs-dialog-text">{t('branch.rebaseText', { branch: request.branch, current: request.current ?? '' })}</p>
        ) : null}
        {error !== null && !unmerged ? (
          <p className="vcs-dialog-error" role="alert">{errorMessage(t, error)}</p>
        ) : null}
        {busy ? <p className="vcs-dialog-busy" role="status">{t('branch.working')}</p> : null}
        <div className="vcs-dialog-actions">
          <button type="button" className="vcs-button" data-autofocus={request.kind === 'rename' ? undefined : ''} disabled={busy} onClick={onCancel}>
            {t('branch.cancel')}
          </button>
          <button
            type="submit"
            className={`vcs-button${request.kind === 'delete' ? ' vcs-button-danger' : ''}`}
            aria-disabled={!canSubmit ? 'true' : undefined}
            aria-busy={busy ? 'true' : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
