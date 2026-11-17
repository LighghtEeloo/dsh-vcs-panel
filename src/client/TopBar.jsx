/**
 * The panel header, left to right: repository choice, history range,
 * working-state facts with sync and branch switching, the panel's message,
 * then the read-only marker and refresh.
 *
 * A backend with a separate working tree shows its branch; when it can sync,
 * the ahead/behind counts sit on the sync button beside the branch, so the
 * numbers and the action that settles them are one control. When it can
 * switch, the branch name itself opens the local-branch menu, and a right-click
 * hands the branch to the panel's shared actions menu. The message (a sync,
 * switch, or branch-action outcome, or a failure) follows them, so it reads
 * next to what it reports on. A backend whose working copy is a commit shows
 * `@`, its change id, and the refs pointing at it. The range options come from
 * the backend's capabilities, so a future backend only supplies labels.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Arrow, BranchIcon, CheckIcon, Chevron, IconButton, LockIcon, RefreshIcon, RefBadge, Segmented, SyncIcon, Turning,
} from './ui.jsx'
import { errorMessage, formatCount, shortChangeId } from './format.js'
import { BRANCH_BUSY_KEYS } from './branch.js'

/** Range choices when no backend has answered yet. */
const FALLBACK_RANGES = [
  { value: 'HEAD', label: 'history.head', title: 'history.headTitle' },
  { value: 'all', label: 'history.all', title: 'history.allTitle' },
]

/** Ref badges shown in the header before the rest are left to the timeline. */
const HEADER_REFS = 3

/** Width of the branch menu in CSS pixels, and its viewport inset. */
const MENU_WIDTH = 260
const MENU_MARGIN = 8
const MENU_GAP = 6

/** Ahead/behind counts as two small arrows; zero sides are left out. */
function AheadBehind({ ahead, behind }) {
  return (
    <>
      {ahead > 0 ? <span className="vcs-ahead"><Arrow up />{ahead}</span> : null}
      {behind > 0 ? <span className="vcs-behind"><Arrow />{behind}</span> : null}
    </>
  )
}

/** Keys the branch menu consumes so the panel's movement keys stay outside. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'])

/**
 * The branch control: a button that opens the repository's local branches,
 * with a right-click actions menu on the current branch and on each listed
 * branch. The actions menu itself lives at the panel root so the timeline's
 * branch ref badges can open the same menu.
 *
 * The header clips its children, so the branch menu is positioned `fixed`
 * rather than inside its flow. It closes on Escape, an outside press, a
 * resize, or a scroll, and gives focus back to the button. Arrow keys, Home,
 * and End move between items, and the checked-out branch is marked. Right-click
 * and Shift+F10 hand the branch to `onOpenActions`.
 *
 * @param {{ branch: object, branchText: string, branches: object[], branchesStatus: string, branchesError: object | null, branchesTruncated: boolean, onOpen: Function, onSwitch: Function, onOpenActions: Function, switching: boolean, busy: boolean, canOps: boolean, syncable: boolean, t: Function, locale?: string }} props - branch facts and menu state.
 */
function BranchSwitcher({
  branch, branchText, branches, branchesStatus, branchesError, branchesTruncated,
  onOpen, onSwitch, onOpenActions, switching, busy, canOps, syncable, t, locale,
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  // The checked-out branch's name, or null on a detached HEAD.
  const currentName = branch?.detached === true || typeof branch?.name !== 'string' ? null : branch.name

  const close = useCallback(returnFocus => {
    setOpen(false)
    setPosition(null)
    if (returnFocus) {
      requestAnimationFrame(() => { triggerRef.current?.focus() })
    }
  }, [])

  const toggle = () => {
    if (open) {
      close(true)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect !== undefined) {
      const viewport = typeof window === 'undefined' ? rect.left + MENU_WIDTH + MENU_MARGIN * 2 : window.innerWidth
      const left = Math.max(MENU_MARGIN, Math.min(rect.left, viewport - MENU_WIDTH - MENU_MARGIN))
      setPosition({ left, top: rect.bottom + MENU_GAP })
    }
    setOpen(true)
    onOpen()
  }

  const openActions = (entry, point, returnElement) => {
    if (!canOps) return
    close(false)
    onOpenActions(entry, { clientX: point.clientX, clientY: point.clientY }, returnElement)
  }

  // Dismissal: anything outside the trigger and the menu.
  useEffect(() => {
    if (!open) return undefined
    const dismiss = event => {
      if (menuRef.current?.contains(event.target)) return
      if (triggerRef.current?.contains(event.target)) return
      close(false)
    }
    const onResize = () => { close(false) }
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [close, open])

  // Move focus into the menu once it has rows (or itself when it has none).
  useEffect(() => {
    if (!open || branchesStatus === 'loading') return undefined
    const frame = requestAnimationFrame(() => {
      const current = menuRef.current?.querySelector('[data-branch-current="true"]')
      const first = menuRef.current?.querySelector('[data-branch-item]')
      const target = current ?? first ?? menuRef.current
      target?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [branchesStatus, open])

  const onMenuKeyDown = event => {
    if (!MENU_KEYS.has(event.key)) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    const items = Array.from(menuRef.current?.querySelectorAll('[data-branch-item]') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement)
    let next
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length
    else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <span
      className="vcs-branch-wrap"
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        if (open) close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="vcs-branch vcs-branch-button"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : undefined}
        aria-label={t('top.switchBranchLabel', { branch: branchText })}
        title={t('top.switchBranchHint')}
        aria-busy={switching || busy ? 'true' : undefined}
        onClick={toggle}
        onContextMenu={event => {
          if (!canOps || currentName === null) return
          event.preventDefault()
          openActions({ name: currentName, current: true }, event, triggerRef.current)
        }}
        onKeyDown={event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            if (currentName !== null) {
              const rect = triggerRef.current?.getBoundingClientRect()
              if (rect !== undefined) {
                openActions(
                  { name: currentName, current: true },
                  { clientX: rect.left + 12, clientY: rect.bottom },
                  triggerRef.current,
                )
              }
            }
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          if (!open) toggle()
        }}
      >
        <Turning turning={switching || busy}><BranchIcon /></Turning>
        <span className="vcs-branch-name">{branchText}</span>
        {syncable ? null : <AheadBehind ahead={branch?.ahead ?? 0} behind={branch?.behind ?? 0} />}
        <Chevron open={open} />
      </button>
      {open && position !== null ? (
        <div
          ref={menuRef}
          className="vcs-branch-menu"
          role="menu"
          aria-label={t('top.switchBranch')}
          tabIndex={-1}
          style={{ left: `${position.left}px`, top: `${position.top}px` }}
          onKeyDown={onMenuKeyDown}
        >
          <p className="vcs-branch-menu-title">{t('top.switchBranch')}</p>
          {branchesStatus === 'loading' ? (
            <p className="vcs-branch-menu-note">{t('switch.loading')}</p>
          ) : null}
          {branchesStatus === 'error' ? (
            <p className="vcs-branch-menu-note" role="alert">{errorMessage(t, branchesError)}</p>
          ) : null}
          {branchesStatus === 'ready' && branches.length === 0 ? (
            <p className="vcs-branch-menu-note">{t('switch.empty')}</p>
          ) : null}
          {branches.map(entry => (
            <button
              key={entry.name}
              type="button"
              role="menuitemradio"
              aria-checked={entry.current ? 'true' : 'false'}
              className="vcs-branch-item"
              data-branch-item=""
              data-branch-current={entry.current ? 'true' : undefined}
              title={entry.name}
              onClick={() => {
                if (!entry.current) onSwitch(entry.name)
                close(true)
              }}
              onContextMenu={event => {
                if (!canOps) return
                event.preventDefault()
                event.stopPropagation()
                openActions(entry, event, event.currentTarget)
              }}
              onKeyDown={event => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                openActions(entry, { clientX: rect.left + 12, clientY: rect.bottom }, event.currentTarget)
              }}
            >
              <span className="vcs-branch-item-name">{entry.name}</span>
              {entry.current ? <CheckIcon /> : null}
            </button>
          ))}
          {branchesTruncated ? (
            <p className="vcs-branch-menu-note">
              {t('switch.truncated', { count: formatCount(branches.length, locale) })}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
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
 * one icon turns from the click until the counts it settles are back;
 * `switching` is a branch switch and `branchBusy` one of the other branch
 * actions in flight.
 * @param {{ repositories: object[], repo: string | null, onRepoChange: Function, status: object | null, capabilities: object | null, refMode: string, onRefMode: (ref: string) => void, onRefresh: Function, refreshing: boolean, revalidating?: boolean, onSync: Function, syncing: boolean, branches?: object[], branchesStatus?: string, branchesError?: object | null, branchesTruncated?: boolean, onLoadBranches?: Function, onSwitchBranch?: Function, onBranchActions?: Function, switching?: boolean, branchBusy?: string | null, notice?: { tone: 'error' | 'info', text: string } | null, t: Function, locale?: string }} props - panel header state.
 */
export function TopBar({
  repositories, repo, onRepoChange, status, capabilities, refMode, onRefMode, onRefresh, refreshing,
  revalidating = false, onSync, syncing, branches = [], branchesStatus = 'idle', branchesError = null,
  branchesTruncated = false, onLoadBranches = () => {}, onSwitchBranch = () => {}, onBranchActions = () => {},
  switching = false, branchBusy = null, notice, t, locale,
}) {
  // Work on data already on screen shows as one thin bar under the header,
  // whether the user asked for it (refresh, sync, switch, a branch action) or
  // the panel did (a refresh on becoming visible); the content stays put.
  const busy = refreshing || syncing || switching || branchBusy !== null || revalidating
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
  // Switching needs a repository with commits; a detached HEAD is the most
  // useful case, so it stays switchable even though it has no branch name.
  const branchSwitchable = capabilities?.branchSwitch === true
    && branch !== undefined && branch !== null
    && branch.unborn !== true
  const ranges = capabilities?.ranges ?? FALLBACK_RANGES
  const capacity = capabilities
  const branchOps = capacity?.branchOps === true
  let readonlyLabel = t('top.readonly')
  let readonlyHint = t('top.readonlyHint')
  if (capacity?.sync === true) {
    if (branchOps) {
      readonlyLabel = t('top.readonlySyncBranch')
      readonlyHint = t('top.readonlyHintSyncBranch')
    } else if (capacity.branchSwitch === true) {
      readonlyLabel = t('top.readonlySyncSwitch')
      readonlyHint = t('top.readonlyHintSyncSwitch')
    } else {
      readonlyLabel = t('top.readonlySync')
      readonlyHint = t('top.readonlyHintSync')
    }
  } else if (capacity?.snapshots === true) {
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
      ) : branchText === '' ? null : branchSwitchable ? (
        <BranchSwitcher
          branch={branch}
          branchText={branchText}
          branches={branches}
          branchesStatus={branchesStatus}
          branchesError={branchesError}
          branchesTruncated={branchesTruncated}
          onOpen={onLoadBranches}
          onSwitch={onSwitchBranch}
          onOpenActions={onBranchActions}
          switching={switching}
          busy={branchBusy !== null}
          canOps={branchOps}
          syncable={syncable}
          t={t}
          locale={locale}
        />
      ) : (
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
      <ProgressLine
        busy={busy}
        label={syncing
          ? t('top.syncing')
          : switching
            ? t('top.switching')
            : branchBusy !== null && BRANCH_BUSY_KEYS[branchBusy] !== undefined
              ? t(BRANCH_BUSY_KEYS[branchBusy])
              : t('top.refreshing')}
      />
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
