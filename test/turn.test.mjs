import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createTurnChangesDefinition, isMutationCall, TURN_CHANGES_KIND, turnChangedFiles,
} from '../src/client/turn.js'

/** One tool/call event in turn 3. */
function call(callId, name, args) {
  return { type: 'tool/call', data: { turn: 3, callId, name, arguments: JSON.stringify(args) } }
}

/** One successful tool/result in turn 3. */
function result(callId, { isError = false, surfaceOp = 'append' } = {}) {
  return {
    type: 'tool/result',
    surfaceOp,
    data: { turn: 3, message: { isError, source: { callId } } },
  }
}

/** Start the definition's Turn-3 context. */
function startContext(definition) {
  const match = {
    event: { type: 'turn/start', data: { turn: 3 } },
    role: 'start',
  }
  return { state: definition.start({ key: 'vcs-changes:3' }, match) }
}

/** Apply one event as an update. */
function apply(definition, context, event) {
  return definition.update(context, { event, role: 'update' })
}

test('mutation calls follow each tool\'s execution preconditions', () => {
  assert.equal(isMutationCall('write', JSON.stringify({ file_path: '/r/a.js', content: 'x' })), true)
  assert.equal(isMutationCall('write', JSON.stringify({ file_path: '/r/a.js' })), false)
  assert.equal(isMutationCall('write', 'not json'), false)

  const edit = { file_path: '/r/a.js', old_string: 'a', new_string: 'b' }
  assert.equal(isMutationCall('edit', JSON.stringify(edit)), true)
  assert.equal(isMutationCall('edit', JSON.stringify({ ...edit, old_string: '' })), false)
  assert.equal(isMutationCall('edit', JSON.stringify({ ...edit, new_string: 'a' })), false)
  assert.equal(isMutationCall('edit', JSON.stringify({ ...edit, replace_all: 'yes' })), false)

  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'create', path: '/r/a.js', file_text: 'x',
  })), true)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'str_replace', path: '/r/a.js', old_str: 'a', new_str: 'b',
  })), true)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'insert', path: '/r/a.js', insert_line: 2, new_str: 'b',
  })), true)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'view', path: '/r/a.js',
  })), false)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'insert', path: '/r/a.js', insert_line: -1, new_str: 'b',
  })), false)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'create', path: '', file_text: 'x',
  })), false)

  assert.equal(isMutationCall('apply_patch', JSON.stringify({ patchText: '*** Begin Patch' })), true)
  assert.equal(isMutationCall('read', JSON.stringify({ file_path: '/r/a.js' })), false)
  assert.equal(isMutationCall('present', JSON.stringify({ files: [{ path: '/r/a.js' }] })), false)
})

test('the definition matches the Turn, its record, its calls, and appended results only', () => {
  const definition = createTurnChangesDefinition()
  const start = { type: 'turn/start', data: { turn: 3 } }
  assert.deepEqual(definition.match(start), { id: '3', role: 'start' })
  assert.deepEqual(definition.match({ type: 'workspace/changes', data: { turn: 3 } }), { id: '3', role: 'update' })
  assert.equal(definition.match({ type: 'workspace/changes', data: { turn: 0 } }), null)
  assert.equal(definition.match({ type: 'workspace/changes', data: { turn: 3.5 } }), null)
  assert.equal(definition.match({ type: 'workspace/changes', data: {} }), null)
  assert.deepEqual(definition.match(call('c1', 'write', { content: '' })), { id: '3', role: 'update' })
  assert.deepEqual(definition.match(result('c1')), { id: '3', role: 'update' })
  assert.equal(definition.match(result('c1', { surfaceOp: { op: 'replace' } })), null)
  assert.equal(definition.match({ type: 'tool/call', data: { turn: 3 } }).id, '3')
  assert.equal(definition.match({ type: 'assistant/message', data: { turn: 3 } }), null)
})

test('the recorder record alone marks the Turn, covering shell and subagent edits', () => {
  const definition = createTurnChangesDefinition()
  const context = startContext(definition)
  assert.equal(definition.buildLocationData(context, 'turn', null), null)
  const changed = apply(definition, context, { type: 'workspace/changes', data: { turn: 3 } })
  assert.equal(changed.changed, true)
  assert.equal(apply(definition, { state: changed }, { type: 'workspace/changes', data: { turn: 3 } }), changed)
})

test('a successful mutation marks the Turn; failures and non-mutations do not', () => {
  const definition = createTurnChangesDefinition()
  const context = startContext(definition)

  // A mutation call alone changes nothing.
  let state = apply(definition, context, call('c1', 'edit', { file_path: '/r/a.js', old_string: 'a', new_string: 'b' }))
  assert.equal(state.changed, false)

  // Its successful result does.
  state = apply(definition, { state }, result('c1'))
  assert.equal(state.changed, true)

  // Failed results, unmatched results, and read calls stay unchanged.
  const clean = startContext(definition)
  let next = apply(definition, clean, call('c2', 'read', { file_path: '/r/a.js' }))
  next = apply(definition, { state: next }, result('c2'))
  assert.equal(next.changed, false)
  next = apply(definition, { state: next }, call('c3', 'write', { file_path: '/r/a.js', content: 'x' }))
  next = apply(definition, { state: next }, result('c3', { isError: true }))
  assert.equal(next.changed, false)
  next = apply(definition, { state: next }, result('missing'))
  assert.equal(next.changed, false)

  // Later successful mutations keep the first `changed` reference stable.
  let marked = startContext(definition)
  marked = { state: apply(definition, marked, call('c4', 'apply_patch', { patchText: 'x' })) }
  marked = { state: apply(definition, marked, result('c4')) }
  assert.equal(apply(definition, marked, result('c4')), marked.state)
})

test('location data publishes only changed Turns and keeps its identity', () => {
  const definition = createTurnChangesDefinition()
  let context = startContext(definition)
  assert.equal(definition.buildLocationData(context, 'step', null), null)
  assert.equal(definition.buildLocationData(context, 'turn', null), null)

  context = { state: apply(definition, context, call('c1', 'write', { file_path: '/r/a.js', content: 'x' })) }
  assert.equal(definition.buildLocationData(context, 'turn', null), null)
  context = { state: apply(definition, context, result('c1')) }

  const first = definition.buildLocationData(context, 'turn', null)
  // The Engine rejects Location data whose key differs from the definition kind,
  // and that rejection fails the whole conversation assembly for the Session.
  assert.equal(definition.kind, TURN_CHANGES_KIND)
  assert.deepEqual(first, { kind: 'turn', turn: 3, key: definition.kind, value: { changed: true } })
  assert.equal(definition.buildLocationData(context, 'turn', first), first)
  assert.equal(definition.buildLocationData(context, 'step', first), null)
})

test('turnChangedFiles reads the published Turn value defensively', () => {
  const data = new Map([[TURN_CHANGES_KIND, { changed: true }]])
  assert.equal(turnChangedFiles({ data }), true)
  assert.equal(turnChangedFiles({ data: new Map([[TURN_CHANGES_KIND, { changed: false }]]) }), false)
  assert.equal(turnChangedFiles({ data: new Map() }), false)
  assert.equal(turnChangedFiles(undefined), false)
  assert.equal(turnChangedFiles({}), false)
})
