/**
 * Per-Session turn head recorder.
 *
 * DSH's `workspaceChanges` service records which files a turn changed and their
 * line counts, while the repository's active branch or Jujutsu working-copy
 * change id (`@`) can move in later turns. This tracker records the enclosing
 * repository's read-only head at the end of each turn that ran tools or emitted
 * `workspace/changes`, serialized per Session so the next turn's tools cannot
 * switch branches before the closing turn's head is read.
 *
 * Records live in Host memory for the lifetime of their Session, matching
 * `workspaceChanges`.
 */

import { abortError } from './errors.js'
import { findEnclosingRepository } from './repositories.js'
import { createBackends } from './vcs/index.js'

/** Most turn heads retained in memory for one long-running Session. */
export const MAX_TURNS_PER_SESSION = 2_000

/** First-party file tools that can mutate a subagent Session's working tree. */
const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** Whether a Session is a delegated subagent rather than a top-level conversation. */
function isSubagentSession(session) {
  const header = session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

/** Whether a positive safe integer turn number was supplied. */
function isTurnNumber(value) {
  return Number.isSafeInteger(value) && value >= 1
}

/** Empty per-turn state before the first `turn/start`. */
function freshTurn(turn) {
  return {
    turn,
    mutationCalls: new Set(),
    shouldRecord: false,
    lastSignalSeq: -1,
    attemptedAfterSeq: -1,
  }
}

/** Race a promise against an AbortSignal when one is provided. */
function waitWithSignal(promise, signal) {
  if (signal === undefined || signal === null) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(abortError()) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Create the Host tracker that records each turn's active repository head.
 * @param {object} ctx - Host context carrying `fs` and `subprocess`.
 * @param {object} [options] - shared backends and plugin lifetime signal.
 * @param {Map<string, object>} [options.backends] - backend instances by VCS id.
 * @param {AbortSignal} [options.signal] - plugin lifetime signal.
 * @returns {{ attach: () => (() => void), read: (sessionId: string, turn: number, signal?: AbortSignal) => Promise<{ head: object | null } | undefined>, dispose: () => void }}
 */
export function createTurnTracker(ctx, { backends = createBackends(ctx), signal } = {}) {
  const bySession = new Map()
  const byId = new Map()
  const lifetime = new AbortController()
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) lifetime.abort()
    else signal.addEventListener('abort', () => lifetime.abort(), { once: true })
  }

  /** Read the enclosing repository's head for one working directory. */
  async function readEnclosingHead(cwd, readSignal) {
    const enclosing = await findEnclosingRepository(ctx, cwd, readSignal)
    if (enclosing === null) return null
    const backend = backends.get(enclosing.vcs)
    if (backend === undefined || typeof backend.head !== 'function') return null
    return await backend.head(enclosing.path, readSignal)
  }

  /** Create or look up the recorder for one live Session with a `cwd`. */
  function recorderFor(session) {
    let recorder = bySession.get(session)
    if (recorder !== undefined) return recorder
    const cwd = session?.header?.cwd
    const sessionId = session?.id
    if (typeof cwd !== 'string' || cwd === '' || typeof sessionId !== 'string' || sessionId === '') {
      return undefined
    }
    const subagent = isSubagentSession(session)
    const sessionLifetime = new AbortController()
    const combinedSignal = AbortSignal.any([lifetime.signal, sessionLifetime.signal])
    const records = new Map()
    const pendingTurns = new Set()
    let chain = Promise.resolve()
    let state = freshTurn(0)

    const storeHead = (turn, head) => {
      records.delete(turn)
      records.set(turn, { head })
      while (records.size > MAX_TURNS_PER_SESSION) {
        const oldest = records.keys().next().value
        records.delete(oldest)
      }
    }

    const enqueue = task => {
      const next = chain.then(async () => {
        if (combinedSignal.aborted) return
        try {
          await task(combinedSignal)
        } catch (error) {
          if (!combinedSignal.aborted) {
            ctx.logger?.warn?.(
              `dsh-vcs-panel: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      })
      chain = next
      return next
    }

    const recordTurn = turnState => {
      pendingTurns.add(turnState.turn)
      return enqueue(async activeSignal => {
        try {
          if (!turnState.shouldRecord) return
          turnState.attemptedAfterSeq = turnState.lastSignalSeq
          const head = await readEnclosingHead(cwd, activeSignal)
          if (activeSignal.aborted) return
          storeHead(turnState.turn, head)
        } finally {
          pendingTurns.delete(turnState.turn)
        }
      })
    }

    recorder = {
      start(turn) {
        state = freshTurn(turn)
      },
      observeEvent(event) {
        const turn = event?.data?.turn
        if (!isTurnNumber(turn) || turn !== state.turn) return
        if (event.type === 'workspace/changes') {
          state.shouldRecord = true
          state.lastSignalSeq = Math.max(state.lastSignalSeq, event.seq ?? 0)
          return
        }
        if (event.type === 'tool/call') {
          if (subagent && MUTATION_TOOLS.has(event.data.name) && event.data.callId !== undefined) {
            state.mutationCalls.add(String(event.data.callId))
          }
          return
        }
        if (event.type === 'tool/result') {
          if (subagent) {
            if (event.data.message?.isError === true) return
            const callId = event.data.message?.source?.callId
            if (callId === undefined || !state.mutationCalls.has(String(callId))) return
          }
          state.shouldRecord = true
          state.lastSignalSeq = Math.max(state.lastSignalSeq, event.seq ?? 0)
        }
      },
      async stopping(turn) {
        const current = state
        if (turn !== current.turn || !current.shouldRecord) return undefined
        await recordTurn(current)
        return undefined
      },
      end(turn) {
        const current = state
        if (turn !== current.turn || !current.shouldRecord) return
        if (current.attemptedAfterSeq >= current.lastSignalSeq) return
        void recordTurn(current)
      },
      settled() {
        return chain
      },
      async read(turn, requestSignal) {
        if (pendingTurns.has(turn) || (state.turn === turn && state.shouldRecord && !records.has(turn))) {
          await waitWithSignal(chain, requestSignal)
        }
        return records.get(turn)
      },
      dispose() {
        sessionLifetime.abort()
        pendingTurns.clear()
        records.clear()
      },
    }

    bySession.set(session, recorder)
    byId.set(sessionId, recorder)
    return recorder
  }

  /** Forget one Session and cancel any queued read for it. */
  function forget(session) {
    const recorder = bySession.get(session)
    if (recorder === undefined) return
    bySession.delete(session)
    if (typeof session?.id === 'string' && byId.get(session.id) === recorder) {
      byId.delete(session.id)
    }
    recorder.dispose()
  }

  /** Cancel every Session recorder. */
  function dispose() {
    lifetime.abort()
    for (const session of [...bySession.keys()]) forget(session)
    byId.clear()
  }

  /** Subscribe to Host Session and Agent lifecycle events when `ctx.on` exists. */
  function attach() {
    if (typeof ctx?.on !== 'function') return () => { dispose() }
    const disposers = [
      ctx.on('session/event', (session, event) => {
        if (event?.type === 'turn/start' && isTurnNumber(event.data?.turn)) {
          recorderFor(session)?.start(event.data.turn)
          return
        }
        if (event?.type === 'turn/end' && isTurnNumber(event.data?.turn)) {
          bySession.get(session)?.end(event.data.turn)
          return
        }
        bySession.get(session)?.observeEvent(event)
      }),
      ctx.on('session/disposed', session => {
        forget(session)
      }),
      ctx.on('agent/turn-stopping', async payload => {
        const session = payload?.agent?.session
        if (session === undefined || !isTurnNumber(payload?.turn)) return undefined
        await bySession.get(session)?.stopping(payload.turn)
        return undefined
      }),
      ctx.on('tools/pre-execute', async (exec, next) => {
        const session = exec?.agent?.session
        const recorder = session === undefined ? undefined : bySession.get(session)
        if (recorder !== undefined) await recorder.settled()
        return next()
      }),
    ]
    return () => {
      for (const off of disposers) {
        if (typeof off === 'function') off()
      }
      dispose()
    }
  }

  return {
    attach,
    async read(sessionId, turn, requestSignal) {
      const recorder = byId.get(sessionId)
      if (recorder === undefined) return undefined
      return await recorder.read(turn, requestSignal)
    },
    dispose,
  }
}
