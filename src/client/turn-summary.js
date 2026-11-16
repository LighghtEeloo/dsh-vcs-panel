/**
 * Fetch-once cache of per-turn repository head and line-diff summaries served
 * by `/api/vcs.turn`.
 *
 * A completed turn's recorded branch / `@` identity and change totals are
 * immutable facts of that turn: once resolved, a record stands for the browser
 * session's lifetime (bounded by LRU eviction of unsubscribed entries) so
 * scrolling Chat or returning from `VCS` paints synchronously without another
 * request. A `404` / `400` / `409` answer marks the turn `'missing'` so a
 * reopened conversation from before a Host restart never polls for gone data.
 */

import { createApi } from './api.js'

/** Most unsubscribed turn summaries kept in memory before the oldest is dropped. */
export const MAX_IDLE_TURN_SUMMARIES = 500

/**
 * Normalize a turn's repository head descriptor from `/api/vcs.turn`.
 * @param {unknown} value - decoded `head` field.
 * @returns {{ kind: 'branch', name: string } | { kind: 'detached' } | { kind: 'unborn' } | { kind: 'workingCopy', changeId: string | null } | null}
 */
export function normalizeTurnHead(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null
  switch (value.kind) {
    case 'branch':
      return typeof value.name === 'string' && value.name !== ''
        ? { kind: 'branch', name: value.name }
        : null
    case 'detached':
      return { kind: 'detached' }
    case 'unborn':
      return { kind: 'unborn' }
    case 'workingCopy':
      return {
        kind: 'workingCopy',
        changeId: typeof value.changeId === 'string' && value.changeId !== '' ? value.changeId : null,
      }
    default:
      return null
  }
}

/**
 * Normalize a decoded `/api/vcs.turn` answer.
 * @param {unknown} value - decoded JSON body.
 * @returns {{ head: ReturnType<typeof normalizeTurnHead>, changed: number | null, added: number | null, deleted: number | null } | null}
 */
export function normalizeTurnSummary(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const head = normalizeTurnHead(value.head)
  const hasCounts = Number.isSafeInteger(value.changed) && value.changed >= 0
    && Number.isSafeInteger(value.added) && value.added >= 0
    && Number.isSafeInteger(value.deleted) && value.deleted >= 0
  if (hasCounts) {
    return {
      head,
      changed: value.changed,
      added: value.added,
      deleted: value.deleted,
    }
  }
  const countsAbsent = (value.changed === null || value.changed === undefined)
    && (value.added === null || value.added === undefined)
    && (value.deleted === null || value.deleted === undefined)
  if (countsAbsent && head !== null) {
    return { head, changed: null, added: null, deleted: null }
  }
  return null
}

/** Build the cache key for one `(sessionId, turn, seq)` tuple, or null when invalid. */
function recordKey(sessionId, turn, seq) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (!Number.isSafeInteger(turn) || turn < 1) return null
  const validSeq = seq === null || seq === undefined || (Number.isSafeInteger(seq) && seq >= 0)
  if (!validSeq) return null
  return `${encodeURIComponent(sessionId)}:${turn}:${seq ?? 'none'}`
}

/** Whether a failed request indicates that the Host does not hold this turn's summary. */
function isPermanentAbsence(error) {
  return error?.code === 'not-found'
    || error?.code === 'bad-request'
    || error?.code === 'no-session'
    || error?.code === 'no-cwd'
    || error?.status === 404
    || error?.status === 400
    || error?.status === 409
}

/**
 * Create a per-turn summary cache.
 * @param {object} [options] - injection seams for tests.
 * @param {typeof createApi} [options.createApiImpl] - Session API factory.
 * @param {number} [options.maxIdle] - idle record cap.
 * @returns {object} the store.
 */
export function createTurnSummaryStore({
  createApiImpl = createApi,
  maxIdle = MAX_IDLE_TURN_SUMMARIES,
} = {}) {
  const records = new Map()
  const apis = new Map()
  let disposed = false

  /** Reuse one API client per Session. */
  function apiFor(sessionId) {
    let api = apis.get(sessionId)
    if (api === undefined) {
      api = createApiImpl(sessionId)
      apis.set(sessionId, api)
    }
    return api
  }

  /** Touch or create the record for validated coordinates. */
  function ensure(key, sessionId, turn, seq) {
    let record = records.get(key)
    if (record !== undefined) {
      records.delete(key)
      records.set(key, record)
      return record
    }
    record = {
      sessionId,
      turn,
      seq: seq ?? null,
      phase: 'idle',
      summary: null,
      awaitingSummary: null,
      listeners: new Set(),
    }
    records.set(key, record)
    return record
  }

  /** Drop the oldest unsubscribed records past `maxIdle`. */
  function evictIdle() {
    let idle = 0
    for (const record of records.values()) {
      if (record.listeners.size === 0) idle += 1
    }
    for (const [key, record] of records) {
      if (idle <= maxIdle) break
      if (record.listeners.size > 0) continue
      record.awaitingSummary?.abort()
      records.delete(key)
      idle -= 1
    }
  }

  /** Notify subscribers of one record. */
  function notify(record) {
    for (const listener of [...record.listeners]) listener()
  }

  /** Start one `/api/vcs.turn` read for `record`. */
  async function loadRecord(key, record) {
    if (disposed || record.phase === 'ready' || record.phase === 'missing' || record.phase === 'awaitingSummary') {
      return
    }
    const controller = new AbortController()
    record.phase = 'awaitingSummary'
    record.awaitingSummary = controller
    try {
      const answer = await apiFor(record.sessionId).turn(
        record.turn,
        record.seq ?? undefined,
        controller.signal,
      )
      if (disposed || controller.signal.aborted || records.get(key) !== record) return
      record.awaitingSummary = null
      const summary = normalizeTurnSummary(answer)
      if (summary === null) {
        record.phase = 'missing'
        evictIdle()
        return
      }
      record.phase = 'ready'
      record.summary = summary
      notify(record)
      evictIdle()
    } catch (error) {
      if (disposed || error?.name === 'AbortError' || controller.signal.aborted || records.get(key) !== record) {
        return
      }
      record.awaitingSummary = null
      record.phase = isPermanentAbsence(error) ? 'missing' : 'failed'
      evictIdle()
    }
  }

  return {
    /** Resolved summary for one turn, or null while pending or unavailable. */
    get(sessionId, turn, seq = null) {
      const key = recordKey(sessionId, turn, seq)
      if (key === null) return null
      const record = records.get(key)
      return record?.phase === 'ready' ? record.summary : null
    },

    /** Subscribe to summary resolution for one turn. */
    subscribe(sessionId, turn, seq, listener) {
      const key = recordKey(sessionId, turn, seq)
      if (disposed || key === null) return () => {}
      const record = ensure(key, sessionId, turn, seq)
      record.listeners.add(listener)
      return () => {
        record.listeners.delete(listener)
        if (record.listeners.size === 0) {
          if (record.phase === 'awaitingSummary') {
            record.awaitingSummary?.abort()
            record.awaitingSummary = null
            records.delete(key)
          } else {
            evictIdle()
          }
        }
      }
    },

    /** Trigger a summary read when not already resolved, missing, or in flight. */
    observe(sessionId, turn, seq = null) {
      const key = recordKey(sessionId, turn, seq)
      if (disposed || key === null) return
      const record = ensure(key, sessionId, turn, seq)
      void loadRecord(key, record)
    },

    /** Clear transient or missing entries on Host connection replacement; settled turns stay valid. */
    reset() {
      if (disposed) return
      for (const [key, record] of [...records]) {
        if (record.phase === 'ready') continue
        record.awaitingSummary?.abort()
        record.awaitingSummary = null
        if (record.listeners.size === 0) {
          records.delete(key)
        } else {
          record.phase = 'idle'
          void loadRecord(key, record)
        }
      }
    },

    /** Cancel all in-flight reads and drop cached state. */
    dispose() {
      disposed = true
      for (const record of records.values()) {
        record.awaitingSummary?.abort()
      }
      records.clear()
      apis.clear()
    },
  }
}
