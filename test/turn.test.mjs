import test from 'node:test'
import assert from 'node:assert/strict'

import { pickRepository, workingHead, workingSummary } from '../src/client/history/timeline.js'
import {
  createTurnChangesDefinition, isMutationCall, TURN_CHANGES_KIND, turnChangedFiles,
} from '../src/client/turn.js'
import { createWorkingStatusStore } from '../src/client/working-status.js'

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

test('pickRepository prefers the persisted path, then the enclosing repository, then the first', () => {
  const list = [
    { path: '/w/sub', enclosing: false },
    { path: '/w', enclosing: true },
  ]
  assert.deepEqual(pickRepository(list, '/w/sub'), { path: '/w/sub', enclosing: false })
  assert.deepEqual(pickRepository(list, '/gone'), { path: '/w', enclosing: true })
  assert.deepEqual(pickRepository([{ path: '/w/sub', enclosing: false }], null), { path: '/w/sub', enclosing: false })
  assert.equal(pickRepository([], '/w'), null)
  assert.equal(pickRepository(null, '/w'), null)
})

test('workingSummary reads Git working-tree groups and Jujutsu working-copy summaries', () => {
  assert.equal(workingSummary(null), null)
  assert.equal(workingSummary(undefined), null)
  assert.deepEqual(workingHead({ branch: { name: 'main', detached: false, unborn: false } }), {
    kind: 'branch',
    name: 'main',
  })
  assert.deepEqual(workingHead({ branch: { name: null, detached: true, unborn: false } }), {
    kind: 'detached',
  })
  assert.deepEqual(workingHead({ branch: { name: 'main', detached: false, unborn: true } }), {
    kind: 'unborn',
  })
  assert.deepEqual(workingSummary({
    capabilities: { workingCopy: 'row' },
    branch: { name: 'main', detached: false, unborn: false },
    total: 3,
    groups: {
      staged: [{ path: 'a', added: 10, deleted: 2 }],
      unstaged: [{ path: 'b', added: 4, deleted: 1 }],
      untracked: [{ path: 'c', added: 0, deleted: 0 }],
    },
  }), { head: { kind: 'branch', name: 'main' }, changed: 3, added: 14, deleted: 3 })

  assert.deepEqual(workingSummary({
    capabilities: { workingCopy: 'commit' },
    workingCopy: { changeId: 'qpvuntsm', summary: { changed: 2, added: 9, deleted: 5 } },
    groups: {},
    total: 2,
  }), { head: { kind: 'workingCopy', changeId: 'qpvuntsm' }, changed: 2, added: 9, deleted: 5 })
  assert.equal(workingSummary({ capabilities: { workingCopy: 'commit' } }), null)
})

/** Drain pending microtasks of an async store turn. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

test('the working-status store coalesces concurrent banner mounts and refreshes on newer turns', async () => {
  let clock = 1_000
  let currentSummary = { branch: 'main', added: 12, deleted: 3 }
  const calls = []
  let persistedRepo = null
  const store = createWorkingStatusStore({
    now: () => clock,
    staleMs: 30_000,
    loadStateImpl: () => ({ repo: persistedRepo }),
    createApiImpl: sessionId => ({
      async repositories() {
        calls.push(['repositories', sessionId])
        return { repositories: [{ path: '/repo', enclosing: true }] }
      },
      async status(repo) {
        calls.push(['status', sessionId, repo])
        return {
          branch: { name: currentSummary.branch, detached: false, unborn: false },
          total: 1,
          groups: { unstaged: [{ path: 'a.js', added: currentSummary.added, deleted: currentSummary.deleted }] },
        }
      },
    }),
  })

  const notifications = []
  const off1 = store.subscribe('s1', () => { notifications.push(store.get('s1')) })
  const off2 = store.subscribe('s1', () => { notifications.push(store.get('s1')) })
  store.observe('s1', { turn: 1, seq: 10 })
  store.observe('s1', { turn: 2, seq: 25 })
  await settle()

  assert.deepEqual(calls, [['repositories', 's1'], ['status', 's1', '/repo']])
  assert.deepEqual(store.get('s1'), {
    head: { kind: 'branch', name: 'main' },
    changed: 1,
    added: 12,
    deleted: 3,
  })
  assert.equal(notifications.length, 2, 'each subscribed banner hears the resolved summary once')

  // Remounting an already-covered turn within the freshness window makes no request.
  store.observe('s1', { turn: 2, seq: 25 })
  await settle()
  assert.equal(calls.length, 2)

  // A new changed turn refreshes status directly on the known repository.
  currentSummary = { branch: 'main', added: 30, deleted: 8 }
  store.observe('s1', { turn: 3, seq: 40 })
  await settle()
  assert.deepEqual(calls, [
    ['repositories', 's1'],
    ['status', 's1', '/repo'],
    ['status', 's1', '/repo'],
  ])
  assert.deepEqual(store.get('s1'), {
    head: { kind: 'branch', name: 'main' },
    changed: 1,
    added: 30,
    deleted: 8,
  })

  // Returning after the stale window refreshes active Sessions once, including branch switches.
  currentSummary = { branch: 'feat', added: 0, deleted: 0 }
  clock += 31_000
  store.refreshStale()
  await settle()
  assert.equal(calls.length, 4)
  assert.deepEqual(store.get('s1'), {
    head: { kind: 'branch', name: 'feat' },
    changed: 1,
    added: 0,
    deleted: 0,
  })

  // Switching the persisted repository resets the summary and queries the new root.
  persistedRepo = '/repo-b'
  currentSummary = { branch: 'dev', added: 5, deleted: 1 }
  store.observe('s1', { turn: 3, seq: 40 })
  assert.equal(store.get('s1'), null)
  await settle()
  assert.deepEqual(calls.at(-1), ['status', 's1', '/repo-b'])
  assert.deepEqual(store.get('s1'), {
    head: { kind: 'branch', name: 'dev' },
    changed: 1,
    added: 5,
    deleted: 1,
  })

  off1()
  off2()
  store.dispose()
})

test('the working-status store accepts VcsView publications, recovers from missing repos, and aborts on unmount', async () => {
  let aborted = false
  let failRepoOnce = true
  const calls = []
  const store = createWorkingStatusStore({
    loadStateImpl: sessionId => ({ repo: sessionId === 's2' ? '/hang' : '/stale' }),
    createApiImpl: () => ({
      async repositories() {
        calls.push('repositories')
        return { repositories: [{ path: '/fresh', enclosing: true }] }
      },
      async status(repo, signal) {
        calls.push(`status:${repo}`)
        if (repo === '/stale' && failRepoOnce) {
          failRepoOnce = false
          const err = new Error('gone')
          err.code = 'not-a-repo'
          throw err
        }
        if (repo === '/hang') {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true
              const abortErr = new Error('aborted')
              abortErr.name = 'AbortError'
              reject(abortErr)
            })
          })
        }
        return {
          capabilities: { workingCopy: 'commit' },
          workingCopy: { changeId: 'zyxw9876', summary: { changed: 1, added: 7, deleted: 2 } },
        }
      },
    }),
  })

  // Direct publication from VcsView warms the summary without a fetch.
  store.publish('s1', '/stale', {
    capabilities: { workingCopy: 'commit' },
    workingCopy: { changeId: 'abcd1234', summary: { changed: 1, added: 4, deleted: 0 } },
  })
  assert.deepEqual(store.get('s1'), {
    head: { kind: 'workingCopy', changeId: 'abcd1234' },
    changed: 1,
    added: 4,
    deleted: 0,
  })

  // A newer turn hits `/stale`, gets `not-a-repo`, re-discovers `/fresh`, and updates.
  const off = store.subscribe('s1', () => {})
  store.observe('s1', { turn: 2, seq: 20 })
  await settle()
  assert.deepEqual(calls, ['status:/stale', 'repositories', 'status:/fresh'])
  assert.deepEqual(store.get('s1'), {
    head: { kind: 'workingCopy', changeId: 'zyxw9876' },
    changed: 1,
    added: 7,
    deleted: 2,
  })
  off()

  // Unsubscribing the last banner cancels an in-flight status read.
  store.publish('s2', '/hang', { total: 0, groups: {} })
  const offHang = store.subscribe('s2', () => {})
  store.observe('s2', { turn: 1, seq: 5 })
  await Promise.resolve()
  offHang()
  await settle()
  assert.equal(aborted, true)
  store.dispose()
})
