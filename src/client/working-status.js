/**
 * Session-scoped working-tree / working-copy (`@`) line-diff summary shared by
 * every turn-tail banner in a Conversation and kept in sync with `VcsView`.
 *
 * Multiple completed turns in one Session render multiple banners, all showing
 * the working-state line counts the `VCS` tab opens on. One record per Session
 * coalesces concurrent mounts into a single `vcs.repositories` + `vcs.status`
 * read, refreshes once when a newer changed turn settles or when the page
 * becomes visible again after the stale window, and accepts status answers
 * `VcsView` already loaded so returning to Chat paints without another request.
 */

import { createApi } from './api.js'
import { pickRepository, workingSummary } from './history/timeline.js'
import { loadState } from './state.js'

/** Reload when a subscribed Session returns to the foreground after this idle time. */
export const WORKING_STATUS_STALE_MS = 30_000

/** Idle Session summaries retained in memory before the oldest is dropped. */
const MAX_IDLE_SESSIONS = 20

/** Whether two head descriptors name the same pointer. */
function sameHead(left, right) {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) return false
  return left.kind === right.kind
    && (left.name ?? null) === (right.name ?? null)
    && (left.changeId ?? null) === (right.changeId ?? null)
}

/** Whether two summaries carry the same head and counts. */
function sameSummary(left, right) {
  if (left === right) return true
  if (left === null || right === null) return false
  return sameHead(left.head, right.head)
    && left.changed === right.changed
    && left.added === right.added
    && left.deleted === right.deleted
}

/** Normalize a positive safe integer coordinate, or zero when absent. */
function coordinate(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : 0
}

/** Whether a Session record has observed a turn beyond its last completed read. */
function hasNewerTurn(record) {
  return record.seenTurn > record.loadedTurn || record.seenSeq > record.loadedSeq
}

/**
 * Create a per-Session working-status store.
 * @param {object} [options] - test seams for API, state storage, and clock.
 * @param {typeof createApi} [options.createApiImpl] - Session API factory.
 * @param {typeof loadState} [options.loadStateImpl] - persisted panel state reader.
 * @param {() => number} [options.now] - millisecond clock.
 * @param {number} [options.staleMs] - staleness threshold in milliseconds.
 * @returns {object} the store.
 */
export function createWorkingStatusStore({
  createApiImpl = createApi,
  loadStateImpl = loadState,
  now = Date.now,
  staleMs = WORKING_STATUS_STALE_MS,
} = {}) {
  const records = new Map()
  let disposed = false

  /** Touch or create the record for one Session. */
  function ensure(sessionId) {
    let record = records.get(sessionId)
    if (record !== undefined) {
      records.delete(sessionId)
      records.set(sessionId, record)
      return record
    }
    record = {
      api: createApiImpl(sessionId),
      repo: null,
      repoResolved: false,
      summary: null,
      loadedAt: 0,
      loadedTurn: 0,
      loadedSeq: 0,
      seenTurn: 0,
      seenSeq: 0,
      awaitingStatus: null,
      listeners: new Set(),
    }
    records.set(sessionId, record)
    evictIdle()
    return record
  }

  /** Drop the oldest unsubscribed Session records past the cap. */
  function evictIdle() {
    let idle = 0
    for (const record of records.values()) {
      if (record.listeners.size === 0) idle += 1
    }
    for (const [key, record] of records) {
      if (idle <= MAX_IDLE_SESSIONS) break
      if (record.listeners.size > 0) continue
      record.awaitingStatus?.abort()
      records.delete(key)
      idle -= 1
    }
  }

  /** Notify every mounted banner in one Session that its summary changed. */
  function notify(record) {
    for (const listener of [...record.listeners]) listener()
  }

  /** Set the summary on a record and notify listeners only when it changed. */
  function setSummary(record, next) {
    if (sameSummary(record.summary, next)) return
    record.summary = next
    notify(record)
  }

  /** Align the record with the repository persisted by `VcsView`, if it switched. */
  function syncPreferredRepo(sessionId, record) {
    const preferred = loadStateImpl(sessionId)?.repo ?? null
    if (preferred === null || record.repo === null || preferred === record.repo) return
    record.awaitingStatus?.abort()
    record.awaitingStatus = null
    record.repo = preferred
    record.repoResolved = true
    record.loadedAt = 0
    setSummary(record, null)
  }

  /** Run one coalesced status read for a Session. */
  async function runRefresh(sessionId, record) {
    if (disposed || record.awaitingStatus !== null) return
    const controller = new AbortController()
    record.awaitingStatus = controller
    try {
      // Yield one microtask so every banner mounting in the same commit
      // registers its turn coordinates before the request starts.
      await Promise.resolve()
      if (disposed || controller.signal.aborted || record.listeners.size === 0) return

      const targetTurn = record.seenTurn
      const targetSeq = record.seenSeq
      const preferred = loadStateImpl(sessionId)?.repo ?? null

      if (!record.repoResolved || record.repo === null) {
        const discovered = await record.api.repositories(controller.signal)
        if (controller.signal.aborted) return
        const chosen = pickRepository(discovered?.repositories, preferred)
        record.repo = chosen?.path ?? null
        record.repoResolved = true
      }

      if (record.repo === null) {
        record.loadedAt = now()
        record.loadedTurn = Math.max(record.loadedTurn, targetTurn)
        record.loadedSeq = Math.max(record.loadedSeq, targetSeq)
        setSummary(record, null)
        return
      }

      let statusData
      try {
        statusData = await record.api.status(record.repo, controller.signal)
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) return
        if (error?.code !== 'not-a-repo') throw error
        const discovered = await record.api.repositories(controller.signal)
        if (controller.signal.aborted) return
        const chosen = pickRepository(discovered?.repositories, null)
        record.repo = chosen?.path ?? null
        record.repoResolved = true
        statusData = record.repo === null
          ? null
          : await record.api.status(record.repo, controller.signal)
      }
      if (controller.signal.aborted) return

      record.loadedAt = now()
      record.loadedTurn = Math.max(record.loadedTurn, targetTurn)
      record.loadedSeq = Math.max(record.loadedSeq, targetSeq)
      setSummary(record, statusData === null ? null : workingSummary(statusData))
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      record.loadedAt = now()
      record.loadedTurn = Math.max(record.loadedTurn, record.seenTurn)
      record.loadedSeq = Math.max(record.loadedSeq, record.seenSeq)
      if (record.repo === null) record.repoResolved = false
      setSummary(record, null)
    } finally {
      if (record.awaitingStatus === controller) {
        record.awaitingStatus = null
        if (!disposed && !controller.signal.aborted && record.listeners.size > 0 && hasNewerTurn(record)) {
          void runRefresh(sessionId, record)
        }
      }
    }
  }

  return {
    /** Current working summary for one Session, or null when unknown. */
    get(sessionId) {
      return records.get(sessionId)?.summary ?? null
    },

    /** Subscribe to summary changes for one Session. */
    subscribe(sessionId, listener) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return () => {}
      const record = ensure(sessionId)
      record.listeners.add(listener)
      return () => {
        record.listeners.delete(listener)
        if (record.listeners.size === 0) {
          record.awaitingStatus?.abort()
          record.awaitingStatus = null
          evictIdle()
        }
      }
    },

    /** Record a mounted changed-turn banner and refresh when needed. */
    observe(sessionId, { turn, seq } = {}) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return
      const record = ensure(sessionId)
      record.seenTurn = Math.max(record.seenTurn, coordinate(turn))
      record.seenSeq = Math.max(record.seenSeq, coordinate(seq))
      syncPreferredRepo(sessionId, record)

      const neverLoaded = record.loadedAt === 0
      const newer = hasNewerTurn(record)
      const stale = !neverLoaded && now() - record.loadedAt >= staleMs
      if (!neverLoaded && !newer && !stale) return

      // A previously empty workspace may gain a repository in a later turn (`git init`).
      if (newer && record.repo === null) record.repoResolved = false
      if (record.listeners.size > 0) void runRefresh(sessionId, record)
    },

    /** Accept a fresh status answer already loaded by `VcsView`. */
    publish(sessionId, repo, statusData) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return
      const record = ensure(sessionId)
      record.awaitingStatus?.abort()
      record.awaitingStatus = null
      record.repo = typeof repo === 'string' && repo !== '' ? repo : null
      record.repoResolved = true
      record.loadedAt = now()
      record.loadedTurn = record.seenTurn
      record.loadedSeq = record.seenSeq
      setSummary(record, record.repo === null ? null : workingSummary(statusData))
      evictIdle()
    },

    /** Refresh active Sessions whose status is older than `staleMs`. */
    refreshStale() {
      if (disposed) return
      const current = now()
      for (const [sessionId, record] of records) {
        if (record.listeners.size === 0) continue
        syncPreferredRepo(sessionId, record)
        if (record.loadedAt === 0 || current - record.loadedAt >= staleMs) {
          void runRefresh(sessionId, record)
        }
      }
    },

    /** Cancel all in-flight reads and clear cached state. */
    dispose() {
      disposed = true
      for (const record of records.values()) {
        record.awaitingStatus?.abort()
      }
      records.clear()
    },
  }
}
