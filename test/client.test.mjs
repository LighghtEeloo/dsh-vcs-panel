import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultState, loadState, preferredTab, saveState, sanitizeState, storageKey, SIDEBAR_MIN, SIDEBAR_MAX,
} from '../src/client/state.js'
import {
  errorMessage, formatCommitTime, formatCount, lineCounts, shortSha, splitPath, statusKey,
} from '../src/client/format.js'
import { buildRows, rowIndexOfFile, dirKey } from '../src/client/changes/tree.js'
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
  assert.equal(first.tab, 'changes')
  assert.equal(first.tabChosen, false)
  assert.equal(first.sidebarWidth, 320)
})

test('sanitizeState keeps accepted values and drops unknown ones', () => {
  const state = sanitizeState({
    repo: '/repo',
    tab: 'history',
    tabChosen: true,
    file: { group: 'staged', path: 'src/a.js' },
    dirs: { 'untracked|tmp/': true, bad: 'yes' },
    collapsed: { 'staged|src/': true },
    commit: 'abcdef1234567890',
    commitFile: 'src/a.js',
    ref: 'all',
    split: true,
    wrap: true,
    sidebarWidth: 9999,
    scroll: { changes: 12, history: -4 },
  })
  assert.equal(state.repo, '/repo')
  assert.equal(state.tab, 'history')
  assert.equal(state.tabChosen, true)
  assert.deepEqual(state.file, { group: 'staged', path: 'src/a.js' })
  assert.deepEqual(state.dirs, { 'untracked|tmp/': true })
  assert.deepEqual(state.collapsed, { 'staged|src/': true })
  assert.equal(state.ref, 'all')
  assert.equal(state.split, true)
  assert.equal(state.wrap, true)
  assert.equal(state.sidebarWidth, SIDEBAR_MAX)
  assert.deepEqual(state.scroll, { changes: 12, history: 0 })
})

test('sanitizeState rejects malformed selections and ranges', () => {
  const state = sanitizeState({
    tab: 'nope',
    file: { group: 'staged' },
    commit: 'not-hex',
    ref: 'origin/main',
    sidebarWidth: -1,
    scroll: 'nope',
  })
  assert.equal(state.tab, 'changes')
  assert.equal(state.tabChosen, false)
  assert.equal(state.file, null)
  assert.equal(state.commit, null)
  assert.equal(state.ref, 'HEAD')
  assert.equal(state.sidebarWidth, SIDEBAR_MIN)
  assert.deepEqual(state.scroll, { changes: 0, history: 0 })
})

test('preferredTab opens History for a clean tree unless the tab was chosen', () => {
  assert.equal(preferredTab({ tab: 'changes', tabChosen: false }, 0), 'history')
  assert.equal(preferredTab({ tab: 'changes', tabChosen: false }, 3), 'changes')
  assert.equal(preferredTab({ tab: 'history', tabChosen: false }, 3), 'changes')
  assert.equal(preferredTab({ tab: 'changes', tabChosen: true }, 0), 'changes')
  assert.equal(preferredTab({ tab: 'history', tabChosen: true }, 0), 'history')
  assert.equal(preferredTab({ tab: 'changes', tabChosen: false }, undefined), 'changes')
})

test('formatCount follows the supplied locale', () => {
  assert.equal(formatCount(1234, 'en-US'), '1,234')
  assert.equal(formatCount(1234, 'de-DE'), '1.234')
  assert.equal(formatCount(1234), new Intl.NumberFormat().format(1234))
})

test('loadState and saveState round-trip through sessionStorage', () => {
  const storage = fakeStorage()
  const stored = { ...defaultState(), repo: '/r', tab: 'history', scroll: { changes: 5, history: 9 } }
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

test('rowIndexOfFile finds the row for a selection', () => {
  const rows = buildRows('staged', [{ path: 'a.txt', status: 'M', added: 1, deleted: 0 }])
  assert.equal(rowIndexOfFile(rows, { group: 'staged', path: 'a.txt' }), 0)
  assert.equal(rowIndexOfFile(rows, { group: 'unstaged', path: 'a.txt' }), -1)
  assert.equal(rowIndexOfFile(rows, null), -1)
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
