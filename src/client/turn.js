/**
 * Per-turn file-change evidence for the turn-tail entry.
 *
 * DSH's changed-files card is fed by the `workspace/changes` recorder, which
 * this bundle asks to carry no file list so the card has nothing to show. The
 * recorder still announces every turn that changed files, and that
 * announcement is this entry's primary evidence: it covers shell commands and
 * subagent work, which the Session log alone cannot attribute to a mutation.
 * Successful file-tool calls are the fallback for a turn whose record the
 * recorder could not finish (for example when git failed).
 *
 * The fold is a state-only Conversation definition: it publishes one Turn
 * Location value and owns no Chat node.
 */

/**
 * Definition kind; the Engine requires the Location-data key to equal it, so
 * this one constant serves both purposes.
 */
export const TURN_CHANGES_KIND = 'vcs-changes'

/**
 * Whether an event data value names a top-level turn.
 * @param {unknown} value - decoded event data.
 * @returns {boolean} true for a positive safe integer `turn`.
 */
function isTurnRecord(value) {
  return value !== null && typeof value === 'object' && Number.isSafeInteger(value.turn) && value.turn >= 1
}

/**
 * Parse a tool call's raw argument JSON into an object.
 * @param {string} raw - arguments exactly as the model produced them.
 * @returns {object | null} the argument object, or null when it is not one.
 */
function argumentObject(raw) {
  if (typeof raw !== 'string') return null
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * Whether one tool call can change files in the working tree.
 *
 * Only tools whose successful result implies a content change count; reads,
 * `present`, shell commands, and workflow control carry no such claim. The
 * argument checks mirror the execution preconditions of each tool, so a call
 * that the tool will refuse does not mark the turn.
 *
 * @param {string} name - wire tool name.
 * @param {string} raw - raw argument JSON.
 * @returns {boolean} true when the call is a mutation.
 */
export function isMutationCall(name, raw) {
  switch (name) {
    case 'apply_patch':
      // A patch either applies or fails; the failure path checks the result.
      return true
    case 'write': {
      const args = argumentObject(raw)
      return args !== null && typeof args.content === 'string'
    }
    case 'edit': {
      const args = argumentObject(raw)
      return args !== null
        && typeof args.old_string === 'string'
        && args.old_string !== ''
        && typeof args.new_string === 'string'
        && args.old_string !== args.new_string
        && (args.replace_all === undefined || typeof args.replace_all === 'boolean')
    }
    case 'str_replace_editor': {
      const args = argumentObject(raw)
      if (args === null || typeof args.path !== 'string' || args.path === '') return false
      switch (args.command) {
        case 'create':
          return typeof args.file_text === 'string'
        case 'str_replace':
          return typeof args.old_str === 'string' && args.old_str !== ''
            && (args.new_str === undefined || typeof args.new_str === 'string')
        case 'insert':
          return typeof args.new_str === 'string'
            && Number.isInteger(args.insert_line)
            && args.insert_line >= 0
        default:
          return false
      }
    }
    default:
      return false
  }
}

/** Fold state of one Turn; `calls` remembers which calls may mutate. */
function initialState(turn) {
  return { turn, calls: new Map(), changed: false }
}

/**
 * Build the state-only definition that publishes whether a Turn changed files.
 * @returns {object} a Conversation node definition without a target.
 */
export function createTurnChangesDefinition() {
  return {
    kind: TURN_CHANGES_KIND,
    match(event) {
      if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
      if (event.type === 'workspace/changes' && isTurnRecord(event.data)) {
        return { id: String(event.data.turn), role: 'update' }
      }
      if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
      // Replacement copies shadow the model surface; the human transcript only
      // sees events that appended at their own log position.
      if (event.type === 'tool/result' && event.surfaceOp === 'append') {
        return { id: String(event.data.turn), role: 'update' }
      }
      return null
    },
    start(_context, match) {
      if (match.event.type !== 'turn/start') throw new Error('vcs turn changes require turn/start')
      return initialState(match.event.data.turn)
    },
    update(context, match) {
      const state = context.state
      if (match.event.type === 'workspace/changes') {
        return state.changed ? state : { ...state, changed: true }
      }
      if (match.event.type === 'tool/call') {
        const { callId, name, arguments: raw } = match.event.data
        if (callId === undefined || !isMutationCall(name, raw)) return state
        const calls = new Map(state.calls)
        calls.set(String(callId), true)
        return { ...state, calls }
      }
      if (match.event.type !== 'tool/result' || state.changed) return state
      if (match.event.data.message?.isError === true) return state
      const callId = match.event.data.message?.source?.callId
      if (callId === undefined || !state.calls.has(String(callId))) return state
      return { ...state, changed: true }
    },
    buildLocationData(context, scope, previous) {
      if (scope !== 'turn' || context.state === undefined || !context.state.changed) return null
      if (previous?.kind === 'turn'
        && previous.turn === context.state.turn
        && previous.key === TURN_CHANGES_KIND
        && previous.value?.changed === true) return previous
      return {
        kind: 'turn',
        turn: context.state.turn,
        key: TURN_CHANGES_KIND,
        value: { changed: true },
      }
    },
  }
}

/**
 * Whether a Turn Location says this Turn changed files.
 * @param {{ data?: { get(key: string): unknown } } | undefined} turn - turn location.
 * @returns {boolean} true when the definition published a change.
 */
export function turnChangedFiles(turn) {
  if (turn === undefined || turn === null || typeof turn.data?.get !== 'function') return false
  const value = turn.data.get(TURN_CHANGES_KIND)
  return value !== null && typeof value === 'object' && value.changed === true
}
