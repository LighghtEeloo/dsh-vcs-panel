import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultState, isNode, loadState, nodePatch, preferredNode, saveState, sanitizeState,
  SIDEBAR_MIN, SIDEBAR_MAX, storageKey, WORKING_COPY, WORKTREE,
} from '../src/client/state.js'
import {
  errorMessage, formatCommitTime, formatCount, formatDateTime, lineCounts, shortChangeId, shortSha, splitPath, statusKey,
  switchMessage, syncMessage,
} from '../src/client/format.js'
import {
  buildNodeRows, buildRows, dirKey, isRowKey, rowBodyId, sectionKey, summarizeEntries,
} from '../src/client/detail/tree.js'
import {
  FOLD_LINES, SPLIT_MIN_WIDTH, STREAM_BUDGET, allFileFolds, budgetFolds, changedLines, commitGroups,
  commitSummary, comparisonBase, diffTarget, estimateHeight, expandedFileFolds, hasUnfoldedFile, isFolded,
  rowAt, streamSections, worktreeGroups,
} from '../src/client/detail/detail.js'
import { createQueue } from '../src/client/detail/queue.js'
import { graphInput, headOf, nodeAt, rowOf, worktreeSummary } from '../src/client/history/timeline.js'
import { ApiError, createApi, queryString } from '../src/client/api.js'
import { hasSeveralAuthors, indexCommits, messageBody } from '../src/client/history/commits.js'

/** A Map-backed Storage stand-in. */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    map,
  }
}

test('defaultState is fresh each time', () => {
  const first = defaultState()
  const second = defaultState()
  assert.notEqual(first, second)
  assert.deepEqual(first, second)
  assert.equal(first.node, null)
  assert.equal(first.nodeChosen, false)
  assert.equal(first.anchor, null)
  assert.equal(first.sidebarWidth, 320)
})

test('sanitizeState keeps accepted values and drops unknown ones', () => {
  const state = sanitizeState({
    repo: '/repo',
    node: 'abcdef1234567890',
    nodeChosen: true,
    dirs: { 'unstaged|tmp': true, 'untracked|old': true, bad: 'yes' },
    collapsed: { 'staged|src': true, 'untracked|old': true },
    folds: { 'commit|a.js': true, 'commit|b.js': false, bad: 'x' },
    anchor: { key: 'commit|a.js', offset: 120 },
    ref: 'all',
    split: true,
    wrap: true,
    sidebarWidth: 9999,
    timelineScroll: 88,
    tab: 'history',
  })
  assert.equal(state.repo, '/repo')
  assert.equal(state.node, 'abcdef1234567890')
  assert.equal(state.nodeChosen, true)
  assert.deepEqual(state.dirs, { 'unstaged|tmp': true })
  assert.deepEqual(state.collapsed, { 'staged|src': true })
  assert.deepEqual(state.folds, { 'commit|a.js': true, 'commit|b.js': false })
  assert.deepEqual(state.anchor, { key: 'commit|a.js', offset: 120 })
  assert.equal(state.ref, 'all')
  assert.equal(state.split, true)
  assert.equal(state.wrap, true)
  assert.equal(state.sidebarWidth, SIDEBAR_MAX)
  assert.equal(state.timelineScroll, 88)
  assert.equal('tab' in state, false)
  assert.equal(sanitizeState({ node: WORKTREE }).node, WORKTREE)
  assert.equal(sanitizeState({ node: WORKING_COPY }).node, WORKING_COPY)
  assert.equal(sanitizeState({ ref: '@' }).ref, '@')
})

test('sanitizeState drops the old untracked row keys and keeps current ones', () => {
  const dropped = sanitizeState({
    dirs: { 'untracked|tmp': true },
    collapsed: { 'untracked|tmp': true },
    folds: { 'untracked|tmp/a.js': true },
    anchor: { key: 'untracked|tmp/a.js', offset: 10 },
  })
  assert.deepEqual(dropped.dirs, {})
  assert.deepEqual(dropped.collapsed, {})
  assert.deepEqual(dropped.folds, {})
  assert.equal(dropped.anchor, null, 'an old anchor returns to the default position')

  // Group rows, directories, and files of the current model all restore.
  for (const key of ['staged|', 'unstaged|src/client', 'commit|src/a.js']) {
    assert.deepEqual(
      sanitizeState({ anchor: { key, offset: 4 } }).anchor,
      { key, offset: 4 },
      key,
    )
  }
  assert.equal(sanitizeState({ anchor: { key: 'unknown|a', offset: 1 } }).anchor, null)
})

test('sanitizeState rejects malformed selections, anchors, and ranges', () => {
  const state = sanitizeState({
    node: 'not-hex',
    nodeChosen: true,
    anchor: { key: '', offset: 5 },
    ref: 'origin/main',
    sidebarWidth: -1,
    timelineScroll: -3,
  })
  assert.equal(state.node, null)
  assert.equal(state.nodeChosen, false, 'a choice without a node is no choice')
  assert.equal(state.anchor, null)
  assert.equal(state.ref, 'HEAD')
  assert.equal(state.sidebarWidth, SIDEBAR_MIN)
  assert.equal(state.timelineScroll, 0)
  assert.equal(sanitizeState({ anchor: { key: 'a', offset: Number.NaN } }).anchor, null)
  assert.equal(isNode('abc123'), false, 'shorter than an abbreviated id')
  assert.equal(isNode('ABCDEF1'), true)
  assert.equal(isNode(WORKING_COPY), true)
})

test('preferredNode follows the working tree until the user chooses', () => {
  const dirty = { total: 3, branch: { oid: 'a'.repeat(40) } }
  const clean = { total: 0, branch: { oid: 'b'.repeat(40) } }
  const unborn = { total: 0, branch: { oid: null, unborn: true } }
  const unchosen = { node: null, nodeChosen: false }
  assert.equal(preferredNode(unchosen, dirty), WORKTREE)
  assert.equal(preferredNode(unchosen, clean), 'b'.repeat(40))
  assert.equal(preferredNode(unchosen, unborn), WORKTREE)
  assert.equal(preferredNode({ node: WORKTREE, nodeChosen: false }, clean), 'b'.repeat(40), 'a default moves with the tree')
  assert.equal(preferredNode({ node: WORKTREE, nodeChosen: true }, clean), WORKTREE, 'a choice stays')
  assert.equal(preferredNode({ node: 'c'.repeat(40), nodeChosen: true }, dirty), 'c'.repeat(40))
  assert.equal(preferredNode(unchosen, null), null, 'nothing to decide before the status answers')

  // A backend names its own default; the Jujutsu default is the working copy.
  const jj = { total: 2, branch: null, defaultNode: WORKING_COPY }
  assert.equal(preferredNode(unchosen, jj), WORKING_COPY)
  assert.equal(preferredNode({ node: 'c'.repeat(40), nodeChosen: true }, jj), 'c'.repeat(40))
})

test('nodePatch resets reading state and commit folders only when the node changes', () => {
  const state = {
    ...defaultState(),
    node: WORKTREE,
    nodeChosen: false,
    folds: { 'staged|a.js': true },
    anchor: { key: 'staged|a.js', offset: 10 },
    collapsed: { 'staged|src': true, 'commit|lib': true },
  }
  const moved = nodePatch(state, 'd'.repeat(40), true)
  assert.deepEqual(moved, {
    node: 'd'.repeat(40),
    nodeChosen: true,
    anchor: null,
    folds: {},
    collapsed: { 'staged|src': true },
  })
  assert.deepEqual(nodePatch(state, WORKTREE, true), { nodeChosen: true }, 'choosing the shown node keeps its reading state')
  assert.deepEqual(nodePatch(state, WORKTREE, false), {})
})

test('formatCount follows the supplied locale', () => {
  assert.equal(formatCount(1234, 'en-US'), '1,234')
  assert.equal(formatCount(1234, 'de-DE'), '1.234')
  assert.equal(formatCount(1234), new Intl.NumberFormat().format(1234))
})

test('loadState and saveState round-trip through sessionStorage', () => {
  const storage = fakeStorage()
  const stored = { ...defaultState(), repo: '/r', node: WORKTREE, nodeChosen: true, timelineScroll: 9, anchor: { key: 'staged|a', offset: 4 } }
  saveState('session-1', stored, storage)
  assert.equal(storage.map.has(storageKey('session-1')), true)
  assert.deepEqual(loadState('session-1', storage), stored)
  assert.deepEqual(loadState('missing', storage), defaultState())
})

test('loadState survives unreadable storage', () => {
  const storage = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }
  assert.deepEqual(loadState('s', storage), defaultState())
  assert.doesNotThrow(() => saveState('s', defaultState(), storage))
})

test('format helpers describe paths, ids, and statuses', () => {
  assert.deepEqual(splitPath('src/client/a.js'), { dir: 'src/client/', base: 'a.js' })
  assert.deepEqual(splitPath('README.md'), { dir: '', base: 'README.md' })
  assert.equal(shortSha('abcdef1234'), 'abcdef1')
  assert.equal(statusKey('A'), 'status.added')
  assert.equal(statusKey('Z'), 'status.changed')
  assert.deepEqual(lineCounts({ added: 3, deleted: 1 }), { added: 3, deleted: 1 })
  assert.deepEqual(lineCounts({}), { added: null, deleted: null })
  assert.deepEqual(lineCounts(null), { added: null, deleted: null })
})

test('errorMessage localizes known codes and falls back to the Host message', () => {
  const t = key => `t:${key}`
  assert.equal(errorMessage(t, { code: 'timeout', message: 'raw' }), 't:error.timeout')
  assert.equal(errorMessage(t, { code: 'network', message: 'raw' }), 't:error.network')
  assert.equal(errorMessage(t, { code: 'switch-blocked', message: 'raw' }), 't:error.switchBlocked')
  assert.equal(errorMessage(t, { code: 'switch-failed', message: 'raw' }), 't:error.switchFailed')
  assert.equal(errorMessage(t, { code: 'unheard-of', message: 'host text' }), 'host text')
  assert.equal(
    errorMessage(t, { code: 'vcs-missing', message: 'jj is not available on this host.' }),
    'jj is not available on this host.',
    'the missing-tool message names the backend',
  )
  assert.equal(errorMessage(t, null), 't:error.internal')
})

test('shortChangeId keeps change ids readable in a row', () => {
  assert.equal(shortChangeId('abcdefghijkl'), 'abcdefgh')
  assert.equal(shortChangeId('abc'), 'abc')
  assert.equal(shortChangeId(undefined), '')
  assert.equal(shortSha(undefined), '')
  assert.equal(formatDateTime(1e20, 'en-US'), '')
})

test('formatCommitTime is relative within a week and absolute beyond', () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0)
  const fiveMinutes = formatCommitTime(now - 5 * 60_000, now, 'en-US')
  assert.match(fiveMinutes, /^5 min/)
  assert.doesNotMatch(fiveMinutes, /minutes/)
  const old = formatCommitTime(now - 30 * 86400_000, now, 'en-US')
  assert.match(old, /2026/)
})

test('buildRows nests staged files and respects collapsed directories', () => {
  const entries = [
    { path: 'src/b.js', status: 'M', added: 2, deleted: 1 },
    { path: 'src/a.js', status: 'A', added: 4, deleted: 0 },
    { path: 'README.md', status: 'M', added: 1, deleted: 1 },
  ]
  const rows = buildRows('staged', entries)
  assert.deepEqual(rows.map(row => row.kind), ['dir', 'file', 'file', 'file'])
  assert.equal(rows[0].name, 'src')
  assert.equal(rows[0].expanded, true)
  assert.deepEqual(rows.filter(row => row.kind === 'file').map(row => row.name), ['a.js', 'b.js', 'README.md'])
  assert.equal(rows[0].key, dirKey('staged', 'src'))
  assert.equal(rows[1].key, sectionKey('staged', 'src/a.js'))
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[1].depth, 1)

  const collapsed = buildRows('staged', entries, { collapsed: { [dirKey('staged', 'src')]: true } })
  assert.deepEqual(collapsed.filter(row => row.kind === 'file').map(row => row.name), ['README.md'])
  assert.equal(collapsed[0].expanded, false)
})

test('buildRows starts a working-tree group with a group row that counts its files', () => {
  const entries = [
    { path: 'src/a.js', status: 'M', added: 3, deleted: 1 },
    { path: 'b.txt', status: '?', added: 0, deleted: 0 },
    { path: 'docs/', status: '?', directory: true, added: 0, deleted: 0 },
  ]
  const rows = buildRows('unstaged', entries, {}, { header: true })
  assert.equal(rows[0].kind, 'group')
  assert.equal(rows[0].key, dirKey('unstaged', ''))
  assert.equal(rows[0].expanded, true)
  assert.equal(rows[0].count, 3, 'untracked files and directories count')
  assert.equal(rows[0].added, 3)
  assert.equal(rows[0].deleted, 1)

  const closed = buildRows('unstaged', entries, { collapsed: { [dirKey('unstaged', '')]: true } }, { header: true })
  assert.deepEqual(closed.map(row => row.kind), ['group'])
  assert.equal(closed[0].expanded, false)
})

test('buildRows compresses a chain of single-child directories into one row', () => {
  const entries = [
    { path: 'src/client/detail/a.js', status: 'M', added: 1, deleted: 0 },
    { path: 'src/client/detail/b.js', status: 'M', added: 1, deleted: 0 },
    { path: 'top.txt', status: 'M', added: 1, deleted: 0 },
  ]
  const rows = buildRows('commit', entries)
  assert.deepEqual(rows.map(row => `${row.kind}:${row.name}`), [
    'dir:src/client/detail', 'file:a.js', 'file:b.js', 'file:top.txt',
  ])
  assert.equal(rows[0].path, 'src/client/detail/')
  assert.equal(rows[0].key, dirKey('commit', 'src/client/detail'))
  assert.equal(rows[1].depth, 1)
  assert.equal(rows[3].depth, 0)
})

test('buildRows expands untracked directories only after their children load', () => {
  const entries = [
    { path: 'notes/', status: '?', directory: true, added: 0, deleted: 0 },
    { path: 'scratch.txt', status: '?', added: 0, deleted: 0 },
  ]
  const key = dirKey('unstaged', 'notes/')
  const closed = buildRows('unstaged', entries)
  assert.deepEqual(closed.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'file:scratch.txt'])
  assert.equal(closed[0].expanded, false)
  assert.equal(closed[0].loadable, true, 'a directory Git reported whole loads on demand')

  const loading = buildRows('unstaged', entries, { dirs: { [key]: true }, loadingDirs: { [key]: true } })
  assert.deepEqual(loading.map(row => row.kind), ['dir', 'loading', 'file'])

  const opened = buildRows('unstaged', entries, {
    dirs: { [key]: true },
    dirChildren: {
      [key]: [
        { name: 'inner/', path: 'notes/inner/', type: 'directory' },
        { name: 'a.txt', path: 'notes/a.txt', type: 'file' },
      ],
    },
  })
  assert.deepEqual(opened.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:a.txt', 'file:scratch.txt'])
  const innerKey = dirKey('unstaged', 'notes/inner/')
  assert.equal(opened[1].expanded, false)
  const deeper = buildRows('unstaged', entries, {
    dirs: { [key]: true, [innerKey]: true },
    dirChildren: {
      [key]: [{ name: 'inner/', path: 'notes/inner/', type: 'directory' }],
      [innerKey]: [{ name: 'b.txt', path: 'notes/inner/b.txt', type: 'file' }],
    },
  })
  assert.deepEqual(deeper.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:b.txt', 'file:scratch.txt'])
})

test('buildRows expands untracked directories only after their children load', () => {
  const entries = [
    { path: 'notes/', status: '?', directory: true, added: 0, deleted: 0 },
    { path: 'scratch.txt', status: '?', added: 0, deleted: 0 },
  ]
  const key = dirKey('untracked', 'notes/')
  const closed = buildRows('untracked', entries)
  assert.deepEqual(closed.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'file:scratch.txt'])
  assert.equal(closed[0].expanded, false)

  const loading = buildRows('untracked', entries, { dirs: { [key]: true }, loadingDirs: { [key]: true } })
  assert.deepEqual(loading.map(row => row.kind), ['dir', 'loading', 'file'])

  const opened = buildRows('untracked', entries, {
    dirs: { [key]: true },
    dirChildren: {
      [key]: [
        { name: 'inner/', path: 'notes/inner/', type: 'directory' },
        { name: 'a.txt', path: 'notes/a.txt', type: 'file' },
      ],
    },
  })
  assert.deepEqual(opened.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:a.txt', 'file:scratch.txt'])
  const innerKey = dirKey('untracked', 'notes/inner/')
  assert.equal(opened[1].expanded, false)
  const deeper = buildRows('untracked', entries, {
    dirs: { [key]: true, [innerKey]: true },
    dirChildren: {
      [key]: [{ name: 'inner/', path: 'notes/inner/', type: 'directory' }],
      [innerKey]: [{ name: 'b.txt', path: 'notes/inner/b.txt', type: 'file' }],
    },
  })
  assert.deepEqual(deeper.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:b.txt', 'file:scratch.txt'])
})

test('queryString skips absent values and escapes the rest', () => {
  assert.equal(queryString({ a: 'x y', b: undefined, c: null, d: 2 }), '?a=x+y&d=2')
  assert.equal(queryString({}), '')
})

test('createApi builds exact Host routes', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url) => {
      calls.push(url)
      return {
        ok: true,
        async json() { return { ok: true } },
      }
    },
  })
  assert.deepEqual(await api.repositories(), { ok: true })
  await api.status('/repo')
  await api.branches('/repo')
  await api.untracked('/repo', 'dir/')
  await api.diff('/repo', { scope: 'commit', path: 'a.js', oldPath: 'old/a.js', rev: 'abc1234' })
  await api.log('/repo', { ref: 'all', skip: 300, limit: 300 })
  await api.commit('/repo', 'abc1234')
  await api.turn(3, 42)
  await api.turn(4, null)
  assert.equal(calls.length, 9)
  assert.match(calls[0], /^\/api\/vcs\.repositories\?sessionId=session\+1$/)
  assert.match(calls[1], /^\/api\/vcs\.status\?sessionId=session\+1&repo=%2Frepo$/)
  assert.match(calls[2], /^\/api\/vcs\.branches\?sessionId=session\+1&repo=%2Frepo$/)
  assert.match(calls[3], /path=dir%2F/)
  assert.match(calls[4], /scope=commit/)
  assert.match(calls[4], /oldPath=old%2Fa.js/)
  assert.match(calls[4], /rev=abc1234/)
  assert.match(calls[5], /skip=300/)
  assert.match(calls[5], /limit=300/)
  assert.match(calls[6], /sha=abc1234/)
  assert.equal(calls[7], '/api/vcs.turn?sessionId=session+1&turn=3&seq=42')
  assert.equal(calls[8], '/api/vcs.turn?sessionId=session+1&turn=4')
})

test('createApi sends sync as an uncancellable same-origin JSON POST and maps its refusals', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, async json() { return { upstream: 'origin/main', pulled: 0, pushed: 2 } } }
    },
  })
  assert.deepEqual(await api.sync('/repo'), { upstream: 'origin/main', pulled: 0, pushed: 2 })
  assert.equal(calls.length, 1)
  const [{ url, init }] = calls
  assert.equal(url, '/api/vcs.sync', 'the session and repository travel in the body, not the URL')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), { sessionId: 'session 1', repo: '/repo' })
  assert.equal(init.signal, undefined, 'leaving the panel does not cut a push short')

  const diverged = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() { return { error: { code: 'diverged', message: 'The branch and its upstream have diverged.' } } },
    }),
  })
  await assert.rejects(diverged.sync('/r'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'diverged')
    assert.equal(error.status, 409)
    return true
  })

  const offline = createApi('s', { fetchImpl: async () => { throw new TypeError('offline') } })
  await assert.rejects(offline.sync('/r'), error => error.code === 'network')
})

test('createApi sends switch as a same-origin JSON POST and maps a refusal', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, async json() { return { branch: 'topic' } } }
    },
  })
  assert.deepEqual(await api.switchBranch('/repo', 'topic'), { branch: 'topic' })
  assert.equal(calls.length, 1)
  const [{ url, init }] = calls
  assert.equal(url, '/api/vcs.switch', 'the session, repository, and branch travel in the body')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), { sessionId: 'session 1', repo: '/repo', branch: 'topic' })
  assert.equal(init.signal, undefined, 'leaving the panel does not cut a switch short')

  const blocked = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() {
        return { error: { code: 'switch-blocked', message: 'Git refused to switch because local changes would be overwritten.' } }
      },
    }),
  })
  await assert.rejects(blocked.switchBranch('/r', 'topic'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'switch-blocked')
    assert.equal(error.status, 409)
    return true
  })
})

test('switchMessage names the branch now checked out', () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  assert.equal(switchMessage(t, { branch: 'topic' }, 'requested'), 'switch.done:{"branch":"topic"}')
  assert.equal(switchMessage(t, { branch: '' }, 'requested'), 'switch.done:{"branch":"requested"}', 'a malformed answer falls back to the pick')
  assert.equal(switchMessage(t, null, 'topic'), 'switch.done:{"branch":"topic"}')
})

test('syncMessage names what moved, preferring the push, and reports a level branch', () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  assert.equal(syncMessage(t, { upstream: 'origin/main', pulled: 0, pushed: 1 }), 'sync.pushedOne:{"upstream":"origin/main"}')
  assert.equal(
    syncMessage(t, { upstream: 'origin/main', pulled: 0, pushed: 1200 }, 'en-US'),
    'sync.pushedMany:{"upstream":"origin/main","count":"1,200"}',
  )
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 1, pushed: 0 }), 'sync.pulledOne:{"upstream":"up/x"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 3, pushed: 0 }, 'en-US'), 'sync.pulledMany:{"upstream":"up/x","count":"3"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 0, pushed: 0 }), 'sync.level:{"upstream":"up/x"}')
  assert.equal(syncMessage(t, { pushed: -1, pulled: 'many' }), 'sync.level:{"upstream":""}', 'a malformed answer reads as level')
})

test('createApi maps failure bodies and transport failures', async () => {
  const failing = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      async json() { return { error: { code: 'not-found', message: 'File unavailable.' } } },
    }),
  })
  await assert.rejects(failing.diff('/r', { scope: 'unstaged', path: 'x' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'not-found')
    assert.equal(error.status, 404)
    assert.equal(error.message, 'File unavailable.')
    return true
  })

  const offline = createApi('s', {
    fetchImpl: async () => { throw new TypeError('offline') },
  })
  await assert.rejects(offline.repositories(), error => {
    assert.equal(error.code, 'network')
    return true
  })

  // A body-less non-2xx failure still carries its HTTP status.
  const gateway = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async json() { throw new SyntaxError('bad gateway html') },
    }),
  })
  await assert.rejects(gateway.status('/r'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'internal')
    assert.equal(error.status, 502)
    return true
  })
})

test('createApi preserves AbortError when cancelled during response body decoding and rejects malformed 200 bodies', async () => {
  // Cancelling a diff after 200 headers arrive (for example stepping past an
  // unloaded file with the keyboard) must reject as AbortError rather than
  // resolving null into FileDiff.
  const midBodyController = new AbortController()
  const abortedMidBody = createApi('s', {
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      async json() {
        midBodyController.abort()
        assert.equal(options.signal.aborted, true)
        throw new DOMException('The request was aborted.', 'AbortError')
      },
    }),
  })
  await assert.rejects(
    abortedMidBody.diff('/r', { scope: 'unstaged', path: 'a.js' }, midBodyController.signal),
    error => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  // Some runtimes reject an aborted body stream with a TypeError while
  // signal.aborted is true; that is still an abort, not a null payload.
  const streamAbortController = new AbortController()
  const abortedStream = createApi('s', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        streamAbortController.abort()
        throw new TypeError('BodyStreamBuffer was aborted')
      },
    }),
  })
  await assert.rejects(
    abortedStream.diff('/r', { scope: 'unstaged', path: 'a.js' }, streamAbortController.signal),
    error => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  // A transport rejection while signal.aborted is true also normalizes to AbortError.
  const fetchAbortController = new AbortController()
  fetchAbortController.abort('cancelled')
  const abortedFetch = createApi('s', {
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
  })
  await assert.rejects(
    abortedFetch.repositories(fetchAbortController.signal),
    error => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  // An uncancelled 200 response with unreadable JSON or a null body fails cleanly.
  const truncated200 = createApi('s', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { throw new SyntaxError('Unexpected end of JSON input') },
    }),
  })
  await assert.rejects(truncated200.diff('/r', { scope: 'unstaged', path: 'a.js' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'internal')
    return true
  })

  const null200 = createApi('s', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return null },
    }),
  })
  await assert.rejects(null200.diff('/r', { scope: 'unstaged', path: 'a.js' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'internal')
    return true
  })
})

test('messageBody drops the subject paragraph and keeps the body verbatim', () => {
  assert.equal(messageBody('incr: one line'), '')
  assert.equal(messageBody('incr: subject\n'), '')
  assert.equal(messageBody('feat: subject\n\nWhy it changed.\n\n- detail'), 'Why it changed.\n\n- detail')
  // Git's %s joins a multi-line first paragraph; the body still starts after it.
  assert.equal(messageBody('first line\nsecond line\n\nbody'), 'body')
  // Whitespace-only separator lines, extra blank lines, and CRLF still split.
  assert.equal(messageBody('subject\n  \n\n\n  indented body\n\n'), '  indented body')
  assert.equal(messageBody('subject\r\n\r\nbody\r\n'), 'body')
  assert.equal(messageBody('subject\n\n   \n'), '')
  assert.equal(messageBody(''), '')
  assert.equal(messageBody(undefined), '')
})

test('hasSeveralAuthors is false for one author or none', () => {
  assert.equal(hasSeveralAuthors([]), false)
  assert.equal(hasSeveralAuthors([{ author: 'Ada' }, { author: 'Ada' }]), false)
  assert.equal(hasSeveralAuthors([{ author: 'Ada' }, { author: 'Ada' }, { author: 'Bob' }]), true)
})

test('indexCommits answers which commits are loaded and where', () => {
  const index = indexCommits([{ sha: 'a'.repeat(40) }, { sha: 'b'.repeat(40) }])
  assert.equal(index.get('b'.repeat(40)), 1)
  assert.equal(index.has('a'.repeat(40)), true)
  // A parent beyond the loaded pages is not selectable.
  assert.equal(index.has('c'.repeat(40)), false)
  assert.equal(indexCommits([]).size, 0)
})

test('timeline rows put the working tree first and map back to nodes', () => {
  const commits = [{ sha: 'c1', parents: ['c2'], refs: [] }, { sha: 'c2', parents: [], refs: [] }]
  const index = indexCommits(commits)
  assert.equal(nodeAt(commits, 0), WORKTREE)
  assert.equal(nodeAt(commits, 1), 'c1')
  assert.equal(nodeAt(commits, 3), null)
  assert.equal(rowOf(index, WORKTREE), 0)
  assert.equal(rowOf(index, 'c2'), 2)
  assert.equal(rowOf(index, 'missing'), -1)
  assert.equal(rowOf(index, null), -1)

  const input = graphInput(commits, 'c1')
  assert.deepEqual(input[0], { sha: WORKTREE, parents: ['c1'], refs: [], worktree: true })
  assert.equal(input.length, 3)
  assert.deepEqual(graphInput([], null)[0].parents, [], 'no commit yet: the working tree has no parent')

  // Without a synthetic row, the loaded commit at row 0 is the node.
  assert.equal(nodeAt(commits, 0, { worktreeRow: false }), 'c1')
  const jjCommits = [{ sha: 'c1', workingCopy: true }, { sha: 'c2' }]
  const jjIndex = indexCommits(jjCommits)
  assert.equal(nodeAt(jjCommits, 0, { worktreeRow: false }), WORKING_COPY)
  assert.equal(rowOf(jjIndex, WORKING_COPY, { worktreeRow: false }), 0)
  assert.equal(jjIndex.get(WORKING_COPY), 0)
  assert.equal(jjIndex.get('c1'), 0)
  assert.equal(nodeAt(commits, 1, { worktreeRow: false }), 'c2')
  assert.equal(nodeAt(commits, 2, { worktreeRow: false }), null)
  assert.equal(rowOf(index, 'c1', { worktreeRow: false }), 0)
  assert.equal(rowOf(index, 'c2', { worktreeRow: false }), 1)
  assert.equal(rowOf(index, WORKING_COPY, { worktreeRow: false }), -1)
  assert.deepEqual(graphInput(commits, 'c1', { worktreeRow: false }), commits)
})

test('headOf prefers the status answer and falls back to the HEAD range', () => {
  const commits = [{ sha: 'c1' }]
  assert.equal(headOf({ branch: { oid: 'o1' } }, commits, 'all'), 'o1')
  assert.equal(headOf({ branch: { oid: null, unborn: true } }, commits, 'HEAD'), null)
  assert.equal(headOf(null, commits, 'HEAD'), 'c1')
  assert.equal(headOf(null, commits, 'all'), null, 'an all-branch range does not start at HEAD')
})

test('worktreeSummary counts tracked lines and every changed entry', () => {
  const status = {
    total: 3,
    groups: {
      staged: [{ path: 'a', added: 2, deleted: 1 }],
      unstaged: [{ path: 'b', added: 5, deleted: 0 }],
      untracked: [{ path: 'c', added: 0, deleted: 0 }],
    },
  }
  assert.deepEqual(worktreeSummary(status), { changed: 3, added: 7, deleted: 1 })
  assert.deepEqual(worktreeSummary(null), { changed: 0, added: 0, deleted: 0 })
})

test('the working tree has staged and unstaged groups, with untracked files merged', () => {
  const status = {
    groups: {
      staged: [{ path: 's.js', status: 'M', added: 1, deleted: 0 }],
      unstaged: [{ path: 'u.js', status: 'M', added: 2, deleted: 1 }],
      untracked: [{ path: 'n.txt', status: '?', added: 0, deleted: 0 }],
    },
  }
  const groups = worktreeGroups(status)
  assert.deepEqual(groups.map(group => group.id), ['staged', 'unstaged'])
  assert.deepEqual(groups.map(group => group.header), [true, true])
  assert.deepEqual(groups[1].entries.map(entry => entry.path), ['u.js', 'n.txt'])
  assert.deepEqual(worktreeGroups(null), [])
  assert.deepEqual(worktreeGroups({ groups: {} }), [])

  // A working tree with only untracked files still has one group.
  assert.deepEqual(
    worktreeGroups({ groups: { untracked: [{ path: 'n.txt', status: '?' }] } }).map(group => group.id),
    ['unstaged'],
  )

  assert.deepEqual(commitGroups({ files: [{ path: 'x' }] }).map(group => group.id), ['commit'])
  assert.equal(commitGroups({ files: [{ path: 'x' }] })[0].header, false, 'commits draw no group row')
  assert.deepEqual(commitGroups({ files: [] }), [])
  assert.deepEqual(commitGroups(null), [])
})

test('streamSections follow the fully expanded row order, not the current folds', () => {
  const groups = [
    { id: 'staged', entries: [{ path: 'src/b.js', status: 'M', added: 1, deleted: 0 }, { path: 'README.md', status: 'M' }], header: true },
    { id: 'unstaged', entries: [{ path: 'notes/', status: '?', directory: true }, { path: 'z.txt', status: '?' }], header: true },
  ]
  const closed = streamSections(groups, {}, null)
  assert.deepEqual(closed.map(section => section.key), ['staged|src/b.js', 'staged|README.md', 'unstaged|z.txt'])

  const opened = streamSections(groups, { [dirKey('unstaged', 'notes/')]: [{ name: 'a.txt', path: 'notes/a.txt', type: 'file' }] }, null)
  assert.deepEqual(opened.map(section => section.key), ['staged|src/b.js', 'staged|README.md', 'unstaged|notes/a.txt', 'unstaged|z.txt'])
  assert.deepEqual(opened[0].target, { scope: 'staged', path: 'src/b.js' })
  assert.deepEqual(opened[2].target, { scope: 'untracked', path: 'notes/a.txt' })
})

test('buildNodeRows lists every group in order, group rows included', () => {
  const groups = [
    { id: 'staged', entries: [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }], header: true },
    { id: 'unstaged', entries: [{ path: 'b.js', status: 'M', added: 1, deleted: 0 }], header: true },
  ]
  assert.deepEqual(buildNodeRows(groups).map(row => `${row.kind}:${row.key}`), [
    'group:staged|', 'file:staged|a.js', 'group:unstaged|', 'file:unstaged|b.js',
  ])
})

test('diffTarget takes its scope from the file, not from its group', () => {
  assert.deepEqual(diffTarget('commit', { path: 'new.js', origPath: 'old.js' }, 'c1'), {
    scope: 'commit', path: 'new.js', oldPath: 'old.js', rev: 'c1',
  })
  assert.deepEqual(diffTarget('unstaged', { path: 'a.js', status: 'M' }, 'ignored'), { scope: 'unstaged', path: 'a.js' })
  assert.deepEqual(
    diffTarget('unstaged', { path: 'n.txt', status: '?' }, null),
    { scope: 'untracked', path: 'n.txt' },
    'an untracked file compares its whole content against the index',
  )
})

test('budgetFolds reports the files that stay folded when every file is expanded', () => {
  const section = (key, added) => ({ key, entry: { added, deleted: 0 } })
  // Sections at the per-file limit fill the budget after this many.
  const fill = STREAM_BUDGET / FOLD_LINES
  const sections = [
    section('a', 10),
    section('huge', FOLD_LINES + 1),
    ...Array.from({ length: fill }, (_, index) => section(`full${index}`, FOLD_LINES)),
    section('c', 1),
    section('d', 1),
  ]
  const folds = budgetFolds(sections)
  assert.equal(folds.get('huge'), 'large')
  assert.equal(folds.has('a'), false)
  assert.equal(folds.has(`full${fill - 1}`), false, 'the section that crosses the budget still renders')
  assert.equal(folds.get('c'), 'budget')
  assert.equal(folds.get('d'), 'budget')
  assert.equal(budgetFolds([section('edge', FOLD_LINES)]).size, 0, 'exactly the limit stays open')

  assert.equal(isFolded('c', {}), true, 'files start folded')
  assert.equal(isFolded('c', { c: false }), false, 'the user can open a budget fold')
  assert.equal(isFolded('a', { a: false }), false, 'the user can open any file')
  assert.equal(isFolded('a', { a: true }), true, 'and fold it again')
})

test('changedLines and estimateHeight treat binaries and unknown counts as small', () => {
  assert.equal(changedLines({ added: 3, deleted: 2 }), 5)
  assert.equal(changedLines({ added: 3, deleted: 2, binary: true }), 0)
  assert.equal(changedLines({}), 0)
  assert.equal(estimateHeight({ binary: true }), 56)
  assert.equal(estimateHeight({ added: 0, deleted: 0 }), 120)
  assert.ok(estimateHeight({ added: 40, deleted: 0 }) > 40 * 20)
  assert.equal(estimateHeight({ added: 1e6, deleted: 0 }), 5000 * 20 + 24, 'capped at the rendered line limit')
})

test('rowAt finds the row a scroll offset is reading', () => {
  const tops = [0, 100, 250, 900]
  assert.equal(rowAt(tops, 0), 0)
  assert.equal(rowAt(tops, 99), 0)
  assert.equal(rowAt(tops, 100), 1)
  assert.equal(rowAt(tops, 5000), 3)
  assert.equal(rowAt([], 10), -1)
})

test('createQueue limits concurrency and drops cancelled waiting tasks', async () => {
  const queue = createQueue(2)
  const started = []
  const releases = []
  const task = name => () => {
    started.push(name)
    return new Promise(resolve => { releases.push(resolve) })
  }
  queue.enqueue(task('a'))
  queue.enqueue(task('b'))
  const cancelC = queue.enqueue(task('c'))
  queue.enqueue(task('d'))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(queue.running, 2)
  assert.equal(queue.waiting, 2)

  cancelC()
  assert.equal(queue.waiting, 1)
  releases[0]()
  await new Promise(resolve => { setTimeout(resolve, 0) })
  assert.deepEqual(started, ['a', 'b', 'd'], 'the cancelled task never starts')

  // A failing task frees its slot too.
  const failing = createQueue(1)
  const order = []
  failing.enqueue(() => Promise.reject(new Error('boom')))
  failing.enqueue(async () => { order.push('next') })
  await new Promise(resolve => { setTimeout(resolve, 0) })
  assert.deepEqual(order, ['next'])
})

test('summarizeEntries counts untracked entries but only sums measured lines', () => {
  assert.deepEqual(summarizeEntries([]), { count: 0, added: 0, deleted: 0 })
  assert.deepEqual(summarizeEntries([
    { path: 'a', added: 3, deleted: 1 },
    { path: 'dir/', status: '?', added: 0, deleted: 0, directory: true },
    { path: 'b', added: null, deleted: null },
  ]), { count: 3, added: 3, deleted: 1 })
})

test('row keys, body ids, and the row key predicate agree', () => {
  assert.equal(isRowKey('staged|'), true)
  assert.equal(isRowKey('unstaged|src/a.js'), true)
  assert.equal(isRowKey('commit|src'), true)
  assert.equal(isRowKey('untracked|a'), false)
  assert.equal(isRowKey('bad'), false)
  assert.equal(isRowKey(null), false)
  assert.equal(rowBodyId('staged|src/a b.js'), rowBodyId('staged|src/a b.js'))
  assert.notEqual(rowBodyId('staged|a'), rowBodyId('staged|b'))
  assert.doesNotMatch(rowBodyId('staged|src/a b.js'), /\s/u, 'a DOM id cannot contain spaces')
})

test('comparisonBase names the comparison each commit kind uses', () => {
  const sha = 'a'.repeat(40)
  assert.deepEqual(comparisonBase({ parents: [sha] }, {}), { kind: 'parent', parent: sha })
  assert.deepEqual(comparisonBase({ parents: [sha, 'b'.repeat(40)] }, {}), { kind: 'merge', parent: sha })
  assert.deepEqual(comparisonBase({ parents: [] }, {}), { kind: 'root' })
  assert.deepEqual(comparisonBase(null, null), { kind: 'root' })
  // A backend with change ids compares against the parents' automatic merge.
  assert.deepEqual(comparisonBase({ parents: [sha] }, { changeId: true }), { kind: 'autoMerge', parent: sha })
  assert.deepEqual(comparisonBase({ parents: [] }, { changeId: true }), { kind: 'root' })
})

test('commitSummary counts the files and lines of a commit toolbar', () => {
  assert.deepEqual(commitSummary([{ added: 2, deleted: 1 }, { added: 5, deleted: 0 }, { binary: true, added: 0, deleted: 0 }]), {
    count: 3, added: 7, deleted: 1,
  })
  assert.deepEqual(commitSummary(null), { count: 0, added: 0, deleted: 0 })
})

test('the bulk fold button collapses every file and expansion follows the budget', () => {
  const large = { key: 'commit|large.js', entry: { added: FOLD_LINES + 1, deleted: 0 } }
  const small = { key: 'commit|small.js', entry: { added: 4, deleted: 0 } }
  const sections = [small, large]
  const budget = budgetFolds(sections)
  assert.equal(isFolded(small.key, {}), true, 'every file starts collapsed')
  assert.equal(hasUnfoldedFile(sections, {}), false)
  assert.equal(budget.get(large.key), 'large')

  // "Expand all files" opens the small file and leaves the large one folded.
  const expanded = expandedFileFolds(sections, budget)
  assert.deepEqual(expanded, { 'commit|small.js': false, 'commit|large.js': true })
  assert.equal(hasUnfoldedFile(sections, expanded), true)
  assert.equal(isFolded(small.key, expanded), false)
  assert.equal(isFolded(large.key, expanded), true, 'the budget keeps the large file folded')

  // "Collapse all files" folds the ones that were open, including hidden ones.
  const collapsed = allFileFolds(sections)
  assert.deepEqual(collapsed, { 'commit|small.js': true, 'commit|large.js': true })
  assert.equal(hasUnfoldedFile(sections, collapsed), false)
  assert.equal(isFolded(small.key, collapsed), true)
})

test('the folding budget does not depend on which directories are collapsed', () => {
  const entries = [
    { path: 'src/a.js', status: 'M', added: 10, deleted: 0 },
    { path: 'src/b.js', status: 'M', added: 10, deleted: 0 },
    { path: 'other/c.js', status: 'M', added: 10, deleted: 0 },
  ]
  const groups = [{ id: 'commit', entries, header: false }]
  const budget = budgetFolds(streamSections(groups, {}, 'rev'))
  const rowsClosed = buildNodeRows([groups[0]], { collapsed: { [dirKey('commit', 'src')]: true } })
  assert.deepEqual(rowsClosed.filter(row => row.kind === 'file').map(row => row.name), ['c.js'])
  assert.deepEqual([...budget.keys()], [], 'no file folds, so collapsing nothing else changes')
  const allFolds = allFileFolds(streamSections(groups, {}, 'rev'))
  assert.deepEqual(allFolds, { 'commit|other/c.js': true, 'commit|src/a.js': true, 'commit|src/b.js': true })
})

test('untracked files sort next to tracked files in the same directory', () => {
  const entries = [
    { path: 'src/a.js', status: 'M', added: 2, deleted: 0 },
    { path: 'src/b.txt', status: '?', added: 0, deleted: 0 },
    { path: 'notes/', status: '?', directory: true, added: 0, deleted: 0 },
  ]
  const rows = buildRows('unstaged', entries)
  assert.deepEqual(rows.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:src', 'file:a.js', 'file:b.txt'])
  assert.equal(rows[1].depth, 0)
  assert.equal(rows[2].depth, 1)
  assert.equal(rows[3].depth, 1)
  assert.equal(rows[3].entry.status, '?')
  assert.equal(rows[0].loadable, true, 'the untracked directory stays a load-on-demand row')
})

test('a loadable directory is not compressed into the directory above it', () => {
  const entries = [{ path: 'src/tmp/', status: '?', directory: true, added: 0, deleted: 0 }]
  const rows = buildRows('unstaged', entries)
  assert.deepEqual(rows.map(row => `${row.kind}:${row.name}`), ['dir:src', 'dir:tmp'])
  assert.equal(rows[1].loadable, true)
})

test('the split fallback width is the documented one', () => {
  assert.equal(SPLIT_MIN_WIDTH, 640)
})
