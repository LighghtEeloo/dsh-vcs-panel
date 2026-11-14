import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultState, isNode, loadState, nodePatch, preferredNode, saveState, sanitizeState, storageKey,
  SIDEBAR_MIN, SIDEBAR_MAX, WORKTREE,
} from '../src/client/state.js'
import {
  errorMessage, formatCommitTime, formatCount, lineCounts, shortSha, splitPath, statusKey,
} from '../src/client/format.js'
import { buildRows, dirKey } from '../src/client/detail/tree.js'
import {
  FOLD_LINES, STREAM_BUDGET, changedLines, commitGroups, defaultFolds, diffTarget, estimateHeight, isFolded,
  sectionAt, streamSections, worktreeGroups,
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
    dirs: { 'untracked|tmp': true, bad: 'yes' },
    collapsed: { 'staged|src': true },
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
  assert.deepEqual(state.dirs, { 'untracked|tmp': true })
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
  assert.equal(errorMessage(t, { code: 'unheard-of', message: 'host text' }), 'host text')
  assert.equal(errorMessage(t, null), 't:error.internal')
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
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[1].depth, 1)

  const collapsed = buildRows('staged', entries, { collapsed: { [dirKey('staged', 'src')]: true } })
  assert.deepEqual(collapsed.filter(row => row.kind === 'file').map(row => row.name), ['README.md'])
  assert.equal(collapsed[0].expanded, false)
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
  await api.untracked('/repo', 'dir/')
  await api.diff('/repo', { scope: 'commit', path: 'a.js', oldPath: 'old/a.js', rev: 'abc1234' })
  await api.log('/repo', { ref: 'all', skip: 300, limit: 300 })
  await api.commit('/repo', 'abc1234')
  assert.equal(calls.length, 6)
  assert.match(calls[0], /^\/api\/vcs\.repositories\?sessionId=session\+1$/)
  assert.match(calls[1], /^\/api\/vcs\.status\?sessionId=session\+1&repo=%2Frepo$/)
  assert.match(calls[2], /path=dir%2F/)
  assert.match(calls[3], /scope=commit/)
  assert.match(calls[3], /oldPath=old%2Fa.js/)
  assert.match(calls[3], /rev=abc1234/)
  assert.match(calls[4], /skip=300/)
  assert.match(calls[4], /limit=300/)
  assert.match(calls[5], /sha=abc1234/)
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

test('file groups come from the status or the commit, without empty groups', () => {
  const status = { groups: { staged: [], unstaged: [{ path: 'a.js' }], untracked: [{ path: 'n.txt' }] } }
  assert.deepEqual(worktreeGroups(status).map(group => group.id), ['unstaged', 'untracked'])
  assert.deepEqual(worktreeGroups(null), [])
  assert.deepEqual(commitGroups({ files: [{ path: 'x' }] }).map(group => group.id), ['commit'])
  assert.deepEqual(commitGroups({ files: [] }), [])
  assert.deepEqual(commitGroups(null), [])
})

test('streamSections follow the navigation tree order with every folder open', () => {
  const groups = [
    { id: 'staged', entries: [{ path: 'src/b.js', status: 'M', added: 1, deleted: 0 }, { path: 'README.md', status: 'M' }] },
    { id: 'untracked', entries: [{ path: 'notes/', status: '?', directory: true }, { path: 'z.txt', status: '?' }] },
  ]
  const closed = streamSections(groups, {}, null)
  assert.deepEqual(closed.map(section => section.key), ['staged|src/b.js', 'staged|README.md', 'untracked|z.txt'])

  const opened = streamSections(groups, { [dirKey('untracked', 'notes/')]: [{ name: 'a.txt', path: 'notes/a.txt', type: 'file' }] }, null)
  assert.deepEqual(opened.map(section => section.key), ['staged|src/b.js', 'staged|README.md', 'untracked|notes/a.txt', 'untracked|z.txt'])
  assert.deepEqual(opened[0].target, { scope: 'staged', path: 'src/b.js' })
})

test('diffTarget carries the rename source and the commit', () => {
  assert.deepEqual(diffTarget('commit', { path: 'new.js', origPath: 'old.js' }, 'c1'), {
    scope: 'commit', path: 'new.js', oldPath: 'old.js', rev: 'c1',
  })
  assert.deepEqual(diffTarget('unstaged', { path: 'a.js' }, 'ignored'), { scope: 'unstaged', path: 'a.js' })
})

test('defaultFolds folds large sections and everything past the stream budget', () => {
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
  const folds = defaultFolds(sections)
  assert.equal(folds.get('huge'), 'large')
  assert.equal(folds.has('a'), false)
  assert.equal(folds.has(`full${fill - 1}`), false, 'the section that crosses the budget still renders')
  assert.equal(folds.get('c'), 'budget')
  assert.equal(folds.get('d'), 'budget')
  assert.equal(defaultFolds([section('edge', FOLD_LINES)]).size, 0, 'exactly the limit stays open')

  assert.equal(isFolded('c', folds, {}), true)
  assert.equal(isFolded('c', folds, { c: false }), false, 'the user can unfold a default fold')
  assert.equal(isFolded('a', folds, { a: true }), true, 'and fold an open section')
})

test('changedLines and estimateHeight treat binaries and unknown counts as small', () => {
  assert.equal(changedLines({ added: 3, deleted: 2 }), 5)
  assert.equal(changedLines({ added: 3, deleted: 2, binary: true }), 0)
  assert.equal(changedLines({}), 0)
  assert.equal(estimateHeight({ binary: true }), 56)
  assert.equal(estimateHeight({ added: 0, deleted: 0 }), 120)
  assert.ok(estimateHeight({ added: 40, deleted: 0 }) > 40 * 22)
  assert.equal(estimateHeight({ added: 1e6, deleted: 0 }), 5000 * 22 + 24, 'capped at the rendered line limit')
})

test('sectionAt finds the section a scroll offset is reading', () => {
  const tops = [0, 100, 250, 900]
  assert.equal(sectionAt(tops, 0), 0)
  assert.equal(sectionAt(tops, 99), 0)
  assert.equal(sectionAt(tops, 100), 1)
  assert.equal(sectionAt(tops, 5000), 3)
  assert.equal(sectionAt([], 10), -1)
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
