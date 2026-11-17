import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn as spawnProcess } from 'node:child_process'
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, join, basename, resolve as resolvePath, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, createHandlers, createTurnTracker, normalizeConfig } from '../index.js'

// Keep the fixtures independent of the user's global git configuration.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'

const GIT_ENV = { ...process.env }

/** Whether this host can build and read a Jujutsu fixture. */
const HAS_JJ = (() => {
  try {
    execFileSync('jj', ['--version'], { encoding: 'utf8', env: { ...process.env, JJ_CONFIG: '/dev/null' } })
    return true
  } catch {
    return false
  }
})()

// Keep Jujutsu fixtures and the Host's jj commands independent of the user's
// config, and create a fixed identity so signed-commit settings do not apply.
process.env.JJ_CONFIG = '/dev/null'
process.env.JJ_USER = 'Test User'
process.env.JJ_EMAIL = 'test@example.com'

const JJ_ENV = { ...process.env }

/**
 * Run jj during fixture setup and for read-only assertions.
 * @param {string} cwd - working directory.
 * @param {string[]} args - jj arguments.
 * @returns {string} trimmed stdout.
 */
function jj(cwd, args) {
  return execFileSync('jj', args, { cwd, env: JJ_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * Run git during fixture setup and for read-only assertions.
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed stdout.
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

/**
 * Run git and keep raw bytes (needed for `-z` output).
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @returns {string} raw stdout.
 */
function gitRaw(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
}

/**
 * Create one throwaway repository with a fixed identity.
 * @param {string} path - directory to create.
 * @returns {void}
 */
function initRepo(path) {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'main'])
  git(path, ['config', 'user.email', 'test@example.com'])
  git(path, ['config', 'user.name', 'Test User'])
  git(path, ['config', 'commit.gpgsign', 'false'])
}

/**
 * Build the shared fixture: one repository with two commits and a rich working
 * tree, one nested repository, one repository under node_modules, one unborn
 * repository, and one plain directory.
 * @returns {object} the fixture paths and commit ids.
 */
function buildFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'vcs-panel-'))
  const main = join(scratch, 'main')
  initRepo(main)

  writeFileSync(join(main, '.gitignore'), 'nested/\nnode_modules/\n*.ignored\n')
  writeFileSync(join(main, 'tracked.txt'), 'one\ntwo\n')
  writeFileSync(join(main, 'to-rename.txt'), 'r\n')
  writeFileSync(join(main, 'to-delete.txt'), 'd\n')
  writeFileSync(join(main, 'image.bin'), Buffer.from([0, 1, 2]))
  writeFileSync(join(main, 'untouched.txt'), 'u\n')
  git(main, ['add', '-A'])
  git(main, ['commit', '-qm', 'initial commit'])
  const rootSha = git(main, ['rev-parse', 'HEAD'])

  writeFileSync(join(main, 'tracked.txt'), 'one\ntwo\nthree\n')
  git(main, ['mv', 'to-rename.txt', 'renamed.txt'])
  git(main, ['rm', '-q', 'to-delete.txt'])
  writeFileSync(join(main, 'added.txt'), 'added\n')
  writeFileSync(join(main, 'both.txt'), 'both\n')
  git(main, ['add', '-A'])
  git(main, ['commit', '-qm', 'second commit'])
  const headSha = git(main, ['rev-parse', 'HEAD'])

  const nested = join(main, 'nested')
  initRepo(nested)
  writeFileSync(join(nested, 'nested.txt'), 'nested\n')
  git(nested, ['add', '-A'])
  git(nested, ['commit', '-qm', 'nested commit'])

  const inner = join(main, 'node_modules', 'inner')
  initRepo(inner)
  writeFileSync(join(inner, 'inner.txt'), 'inner\n')
  git(inner, ['add', '-A'])
  git(inner, ['commit', '-qm', 'inner commit'])

  const secret = join(scratch, 'secret')
  mkdirSync(secret)
  writeFileSync(join(secret, 'secret.txt'), 'top secret\n')
  symlinkSync('../secret', join(main, 'leak'))

  writeFileSync(join(main, 'tracked.txt'), 'one\nTWO\nthree\n')
  writeFileSync(join(main, 'both.txt'), 'both\nstaged\n')
  git(main, ['add', 'both.txt'])
  writeFileSync(join(main, 'both.txt'), 'both\nstaged\nworktree\n')
  writeFileSync(join(main, 'staged.txt'), 'staged\n')
  git(main, ['add', 'staged.txt'])
  git(main, ['mv', 'untouched.txt', 'moved.txt'])
  writeFileSync(join(main, 'image.bin'), Buffer.from([9, 9, 0, 9]))

  const untracked = join(main, 'scratch')
  mkdirSync(join(untracked, 'deep'), { recursive: true })
  writeFileSync(join(untracked, 'notes.md'), '# notes\n')
  writeFileSync(join(untracked, 'deep', 'file.txt'), 'deep\n')
  writeFileSync(join(untracked, 'skip.ignored'), 'skip\n')
  writeFileSync(join(untracked, 'blob.bin'), Buffer.from([1, 2, 0]))
  writeFileSync(
    join(untracked, 'large.txt'),
    Array.from({ length: 5001 }, (_, index) => `line ${index}`).join('\n') + '\n',
  )
  writeFileSync(join(untracked, 'huge.txt'), 'a'.repeat(2 * 1024 * 1024 + 1))

  const unborn = join(scratch, 'unborn')
  initRepo(unborn)
  writeFileSync(join(unborn, 'first.txt'), 'first\n')

  const plain = join(scratch, 'plain')
  mkdirSync(plain)

  // A separate repository whose HEAD is a real merge, so commit detail can be
  // checked against the first parent rather than an empty file list.
  const merge = join(scratch, 'merge')
  initRepo(merge)
  writeFileSync(join(merge, 'base.txt'), 'base\n')
  git(merge, ['add', '-A'])
  git(merge, ['commit', '-qm', 'base'])
  git(merge, ['checkout', '-qb', 'side'])
  writeFileSync(join(merge, 'side.txt'), 'side\n')
  git(merge, ['add', '-A'])
  git(merge, ['commit', '-qm', 'side'])
  git(merge, ['checkout', '-q', 'main'])
  writeFileSync(join(merge, 'main.txt'), 'main\n')
  git(merge, ['add', '-A'])
  git(merge, ['commit', '-qm', 'main'])
  git(merge, ['merge', '-q', '--no-ff', 'side', '-m', 'merge side'])
  const mergeSha = git(merge, ['rev-parse', 'HEAD'])
  const mergeFirstParent = git(merge, ['rev-parse', 'HEAD^1'])
  const mergeSecondParent = git(merge, ['rev-parse', 'HEAD^2'])

  // A colocated Jujutsu repository: @ is a working-copy commit with changes,
  // its parent is an ordinary commit with `main`, and @ carries `feature`.
  let jjRepo = null
  let jjParentSha = null
  let jjHeadSha = null
  if (HAS_JJ) {
    jjRepo = join(scratch, 'jj')
    mkdirSync(jjRepo)
    jj(jjRepo, ['git', 'init'])
    writeFileSync(join(jjRepo, 'tracked.txt'), 'one\ntwo\n')
    writeFileSync(join(jjRepo, 'to-rename.txt'), 'r\n')
    writeFileSync(join(jjRepo, 'to-delete.txt'), 'd\n')
    writeFileSync(join(jjRepo, 'image.bin'), Buffer.from([0, 1, 2]))
    jj(jjRepo, ['describe', '-m', 'initial commit'])
    jj(jjRepo, ['bookmark', 'create', 'main', '-r', '@'])
    jjParentSha = jj(jjRepo, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])

    jj(jjRepo, ['new', '-m', 'second commit'])
    writeFileSync(join(jjRepo, 'tracked.txt'), 'one\ntwo\nthree\n')
    renameSync(join(jjRepo, 'to-rename.txt'), join(jjRepo, 'renamed.txt'))
    rmSync(join(jjRepo, 'to-delete.txt'))
    writeFileSync(join(jjRepo, 'added.txt'), 'added\n')
    writeFileSync(join(jjRepo, 'image.bin'), Buffer.from([9, 9, 0, 9]))
    jj(jjRepo, ['bookmark', 'create', 'feature', '-r', '@'])
    jj(jjRepo, ['status'])
    jjHeadSha = jj(jjRepo, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
  }

  return {
    scratch,
    main,
    nested,
    unborn,
    plain,
    merge,
    jj: jjRepo,
    rootSha,
    headSha,
    mergeSha,
    mergeFirstParent,
    mergeSecondParent,
    jjParentSha,
    jjHeadSha,
  }
}

const fixture = buildFixture()
const mainPath = realpathSync(fixture.main)
const nestedPath = realpathSync(fixture.nested)
const unbornPath = realpathSync(fixture.unborn)
const plainPath = realpathSync(fixture.plain)
const mergePath = realpathSync(fixture.merge)
const jjPath = fixture.jj === null ? null : realpathSync(fixture.jj)

after(() => {
  rmSync(fixture.scratch, { recursive: true, force: true })
})

/** Canonicalize a path the way the local filesystem backend does. */
async function canonicalize(path) {
  const absolute = resolvePath(path)
  let current = absolute
  const tail = []
  for (;;) {
    try {
      const base = await realpath(current)
      return tail.length === 0 ? base : join(base, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * A filesystem adapter matching the `ctx.fs` contract the handlers use:
 * resolve/processPath/contains/stat/lstat/readBytes/listDir.
 * @returns {object} the adapter.
 */
function createFakeFs() {
  const target = async path => {
    const canonical = await canonicalize(path)
    return { targetKey: canonical, displayPath: canonical }
  }

  return {
    resolve: path => target(path),
    processPath: resolved => resolved.displayPath,
    contains: (parent, child) =>
      child.targetKey === parent.targetKey
      || child.targetKey.startsWith(parent.targetKey.endsWith(sep) ? parent.targetKey : `${parent.targetKey}${sep}`),
    stat: async resolved => {
      try {
        const info = await stat(resolved.targetKey)
        return {
          version: 'fixture',
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    lstat: async (path, _options, _signal) => {
      try {
        const info = await lstat(path)
        return {
          version: 'fixture',
          type: info.isFile()
            ? 'file'
            : info.isDirectory()
              ? 'directory'
              : info.isSymbolicLink()
                ? 'symlink'
                : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    readBytes: async (resolved, _signal, maxBytes) => {
      const bytes = await readFile(resolved.targetKey)
      if (bytes.byteLength > maxBytes) {
        const error = new Error('File too large')
        error.code = 'FS_TOO_LARGE'
        throw error
      }
      return new Uint8Array(bytes)
    },
    listDir: async resolved => {
      const dirents = await readdir(resolved.targetKey, { withFileTypes: true })
      const entries = []
      for (const dirent of dirents) {
        entries.push({
          name: dirent.name,
          type: dirent.isDirectory() ? 'directory' : 'file',
          target: await target(join(resolved.targetKey, dirent.name)),
        })
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return entries
    },
  }
}

/** Find an executable on PATH, as the subprocess provider does. */
function resolveOnPath(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next directory.
    }
  }
  throw new Error(`${command} is not on PATH`)
}

/** A collector that keeps at most `maxBytes` and reports whether it cut. */
function createCollector(maxBytes) {
  const chunks = []
  let size = 0
  let lossy = false
  return {
    push(chunk) {
      if (size >= maxBytes) {
        lossy = true
        return
      }
      const room = maxBytes - size
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room)
      chunks.push(take)
      size += take.length
      if (take.length < chunk.length) lossy = true
    },
    readFrom(offset) {
      const buffer = Buffer.concat(chunks)
      const start = Math.min(Math.max(offset, 0), buffer.length)
      return { text: buffer.subarray(start).toString('utf8'), nextOffset: buffer.length, lossy }
    },
  }
}

/**
 * A subprocess adapter matching the `ctx.subprocess` contract: fixed argv,
 * collected streams, a deadline signal, and a terminating grace period.
 * @returns {object} the adapter.
 */
function createFakeSubprocess() {
  return {
    resolveExecutable: async command => resolveOnPath(command),
    spawn(spec) {
      const [command, ...args] = spec.argv
      const child = spawnProcess(command, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout = createCollector(spec.stdio.stdout.maxBytes)
      const stderr = createCollector(spec.stdio.stderr.maxBytes)
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.stdin.on('error', () => {})
      if (typeof spec.stdio.stdin === 'object' && spec.stdio.stdin !== null) {
        child.stdin.end(spec.stdio.stdin.data)
      } else {
        child.stdin.end()
      }

      let grace
      const terminate = () => {
        try {
          child.kill('SIGTERM')
        } catch {
          // Already gone.
        }
        grace = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        }, spec.graceMs)
        grace.unref?.()
      }
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate()
        else spec.signal.addEventListener('abort', terminate, { once: true })
      }

      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => {
          if (grace !== undefined) clearTimeout(grace)
          resolve({ exitCode, signal })
        })
      })

      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: { stdout, stderr },
        done,
        terminate,
        waitForExit: () => done.then(() => true, () => false),
      }
    },
  }
}

const fakeFs = createFakeFs()
const fakeSubprocess = createFakeSubprocess()

const sessions = new Map([
  ['s-main', { header: { cwd: fixture.main } }],
  ['s-unborn', { header: { cwd: fixture.unborn } }],
  ['s-plain', { header: { cwd: fixture.plain } }],
  ['s-merge', { header: { cwd: fixture.merge } }],
  ['s-nocwd', { header: {} }],
])
if (fixture.jj !== null) sessions.set('s-jj', { header: { cwd: fixture.jj } })

/** A host context the handlers accept. */
function createHost(overrides = {}) {
  return {
    sessions: { get: id => sessions.get(id) },
    fs: fakeFs,
    subprocess: fakeSubprocess,
    ...overrides,
  }
}

const handlers = createHandlers(createHost())

/** Build one route URL with encoded query parameters. */
function route(path, params) {
  return `${path}?${new URLSearchParams(params)}`
}

/** Call one handler and decode its JSON answer. */
async function call(handler, url) {
  const response = await handler(new Request(`http://127.0.0.1${url}`))
  return { status: response.status, body: await response.json(), headers: response.headers }
}

test('repositories lists the enclosing repository and one-level children only', async () => {
  const { status, body } = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-main' }),
  )
  assert.equal(status, 200)
  assert.equal(body.cwd, mainPath)
  assert.equal(body.truncated, false)
  assert.deepEqual(
    body.repositories.map(repo => [basename(repo.path), repo.enclosing]),
    [['main', true], ['nested', false]],
  )
  assert.equal(body.repositories[0].path, mainPath)
  assert.equal(body.repositories[1].path, nestedPath)
  assert.equal(body.repositories[0].vcs, 'git')
  assert.equal(body.repositories[0].capabilities.workingCopy, 'row')
  assert.deepEqual(body.repositories[0].capabilities.ranges.map(range => range.value), ['HEAD', 'all'])
})

test('repositories is empty rather than an error when the cwd is not in a repository', async () => {
  const { status, body } = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-plain' }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.repositories, [])
  assert.equal(body.cwd, plainPath)
  assert.equal(body.truncated, false)
})

test('repositories distinguishes unknown sessions from sessions without a cwd', async () => {
  const missing = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-missing' }),
  )
  assert.equal(missing.status, 409)
  assert.equal(missing.body.error.code, 'no-session')

  const noCwd = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-nocwd' }),
  )
  assert.equal(noCwd.status, 409)
  assert.equal(noCwd.body.error.code, 'no-cwd')

  const noSessionId = await call(handlers.repositories, '/api/vcs.repositories')
  assert.equal(noSessionId.status, 400)
  assert.equal(noSessionId.body.error.code, 'bad-request')
})

test('status reports branch facts and all three groups with counts', async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.repo, { path: mainPath, name: 'main' })
  assert.deepEqual(body.branch, {
    name: 'main',
    oid: fixture.headSha,
    detached: false,
    unborn: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  })
  assert.deepEqual(body.groups.staged, [
    { path: 'both.txt', status: 'M', added: 1, deleted: 0 },
    { path: 'moved.txt', status: 'R', origPath: 'untouched.txt', added: 0, deleted: 0 },
    { path: 'staged.txt', status: 'A', added: 1, deleted: 0 },
  ])
  assert.deepEqual(body.groups.unstaged, [
    { path: 'both.txt', status: 'M', added: 1, deleted: 0 },
    { path: 'image.bin', status: 'M', added: 0, deleted: 0, binary: true },
    { path: 'tracked.txt', status: 'M', added: 1, deleted: 1 },
  ])
  assert.deepEqual(body.groups.untracked, [
    { path: 'leak', status: '?', added: 0, deleted: 0 },
    { path: 'scratch/', status: '?', added: 0, deleted: 0, directory: true },
  ])
  assert.equal(body.truncated, false)
  assert.equal(body.total, 7)
})

test('status reports an unborn branch and stays an empty history', async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-unborn', repo: unbornPath }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.branch, {
    name: 'main',
    oid: null,
    detached: false,
    unborn: true,
    upstream: null,
    ahead: 0,
    behind: 0,
  })
  assert.deepEqual(body.groups.staged, [])
  assert.deepEqual(body.groups.unstaged, [])
  assert.deepEqual(body.groups.untracked, [
    { path: 'first.txt', status: '?', added: 0, deleted: 0 },
  ])
  assert.equal(body.total, 1)
})

test('status accepts a trailing-slash repository path echoed by the client', async () => {
  const { status } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: `${mainPath}/` }),
  )
  assert.equal(status, 200)
})

test('status refuses a repo query discovery did not offer', async () => {
  const fromPlain = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-plain', repo: mainPath }),
  )
  assert.equal(fromPlain.status, 400)
  assert.equal(fromPlain.body.error.code, 'not-a-repo')

  const arbitrary = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: '/etc' }),
  )
  assert.equal(arbitrary.status, 400)
  assert.equal(arbitrary.body.error.code, 'not-a-repo')

  const missing = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main' }),
  )
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'bad-request')
})

test('status refuses an unknown session', async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-missing', repo: mainPath }),
  )
  assert.equal(status, 409)
  assert.equal(body.error.code, 'no-session')
})

test('untracked lists direct children, filters ignored paths, and sorts', async () => {
  const { status, body } = await call(
    handlers.untracked,
    route('/api/vcs.untracked', { sessionId: 's-main', repo: mainPath, path: 'scratch/' }),
  )
  assert.equal(status, 200)
  assert.equal(body.path, 'scratch/')
  assert.equal(body.truncated, false)
  assert.deepEqual(body.entries, [
    { name: 'blob.bin', path: 'scratch/blob.bin', type: 'file' },
    { name: 'deep', path: 'scratch/deep', type: 'directory' },
    { name: 'huge.txt', path: 'scratch/huge.txt', type: 'file' },
    { name: 'large.txt', path: 'scratch/large.txt', type: 'file' },
    { name: 'notes.md', path: 'scratch/notes.md', type: 'file' },
  ])
})

test('untracked refuses paths that are not contained directories', async () => {
  const cases = [
    { path: 'scratch' },
    { path: '../outside/' },
    { path: '/etc/' },
    { path: 'leak/' },
    { path: 'scratch/notes.md/' },
    { path: 'scratch//' },
  ]
  for (const params of cases) {
    const { status, body } = await call(
      handlers.untracked,
      route('/api/vcs.untracked', { sessionId: 's-main', repo: mainPath, ...params }),
    )
    assert.ok(status === 400 || status === 404, `expected refusal for ${params.path}, got ${status}`)
    assert.equal(typeof body.error.code, 'string')
  }

  const missing = await call(
    handlers.untracked,
    route('/api/vcs.untracked', {
      sessionId: 's-main',
      repo: mainPath,
      path: 'nope/',
    }),
  )
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not-found')
})

test('diff reports an unstaged text change', async () => {
  const { status, body } = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'tracked.txt',
    }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, {
    kind: 'text',
    path: 'tracked.txt',
    before: true,
    after: true,
    hunks: [{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [' one', '-two', '+TWO', ' three'],
    }],
  })
})

test('diff with oldPath keeps a staged rename instead of reading it as a new file', async () => {
  const renamed = await call(handlers.diff, route('/api/vcs.diff', {
    sessionId: 's-main',
    repo: mainPath,
    scope: 'staged',
    path: 'renamed.txt',
    oldPath: 'to-rename.txt',
  }))
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.kind, 'text')
  assert.equal(renamed.body.path, 'renamed.txt')
  assert.equal(renamed.body.before, true)
  assert.equal(renamed.body.after, true)
  assert.equal(renamed.body.hunks.length, 0)

  const escaped = await call(handlers.diff, route('/api/vcs.diff', {
    sessionId: 's-main',
    repo: mainPath,
    scope: 'staged',
    path: 'renamed.txt',
    oldPath: '../secret/secret.txt',
  }))
  assert.equal(escaped.status, 400)
})

test('diff reports a staged new file', async () => {
  const { status, body } = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'staged',
      path: 'staged.txt',
    }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, {
    kind: 'text',
    path: 'staged.txt',
    before: false,
    after: true,
    hunks: [{
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ['+staged'],
    }],
  })
})

test('diff shows both sides of the same file without mixing them', async () => {
  const staged = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'staged',
      path: 'both.txt',
    }),
  )
  assert.equal(staged.status, 200)
  assert.equal(staged.body.before, true)
  assert.equal(staged.body.after, true)
  assert.deepEqual(staged.body.hunks, [{
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    lines: [' both', '+staged'],
  }])

  const unstaged = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'both.txt',
    }),
  )
  assert.equal(unstaged.status, 200)
  assert.deepEqual(unstaged.body.hunks, [{
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 3,
    lines: [' both', ' staged', '+worktree'],
  }])
})

test('diff reports an untracked text file as one all-additions hunk', async () => {
  const { status, body } = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/notes.md',
    }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, {
    kind: 'text',
    path: 'scratch/notes.md',
    before: false,
    after: true,
    hunks: [{
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ['+# notes'],
    }],
  })
})

test('diff reports binaries and oversized files instead of text', async () => {
  const binary = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/blob.bin',
    }),
  )
  assert.equal(binary.status, 200)
  assert.deepEqual(binary.body, { kind: 'binary', path: 'scratch/blob.bin' })

  const unstagedBinary = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'image.bin',
    }),
  )
  assert.deepEqual(unstagedBinary.body, { kind: 'binary', path: 'image.bin' })

  const lineCapped = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/large.txt',
    }),
  )
  assert.deepEqual(lineCapped.body, { kind: 'oversized', path: 'scratch/large.txt' })

  const byteCapped = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/huge.txt',
    }),
  )
  assert.deepEqual(byteCapped.body, { kind: 'oversized', path: 'scratch/huge.txt' })
})

test('diff compares a commit with its first parent and a root commit with the empty tree', async () => {
  const normal = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'tracked.txt',
      rev: fixture.headSha,
    }),
  )
  assert.equal(normal.status, 200)
  assert.equal(normal.body.before, true)
  assert.equal(normal.body.after, true)
  assert.deepEqual(normal.body.hunks[0].lines, [' one', ' two', '+three'])

  const root = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'tracked.txt',
      rev: fixture.rootSha,
    }),
  )
  assert.equal(root.body.before, false)
  assert.equal(root.body.after, true)
  assert.deepEqual(root.body.hunks[0].lines, ['+one', '+two'])

  const deleted = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'to-delete.txt',
      rev: fixture.headSha,
    }),
  )
  assert.equal(deleted.body.before, true)
  assert.equal(deleted.body.after, false)
  assert.deepEqual(deleted.body.hunks[0].lines, ['-d'])

  const binary = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'image.bin',
      rev: fixture.rootSha,
    }),
  )
  assert.deepEqual(binary.body, { kind: 'binary', path: 'image.bin' })
})

test('diff rejects escapes, invalid scopes, bad revisions, and missing files', async () => {
  const base = { sessionId: 's-main', repo: mainPath }
  const cases = [
    [{ ...base, scope: 'worktree', path: 'tracked.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: '../secret/secret.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: '/etc/passwd' }, 400],
    [{ ...base, scope: 'unstaged', path: '-rf.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: 'leak/secret.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: 'scratch' }, 400],
    [{ ...base, scope: 'untracked', path: 'scratch/deep' }, 400],
    [{ ...base, scope: 'unstaged', path: 'nope.txt' }, 404],
    [{ ...base, scope: 'staged', path: 'nope.txt' }, 404],
    [{ ...base, scope: 'commit', path: 'tracked.txt' }, 400],
    [{ ...base, scope: 'commit', path: 'tracked.txt', rev: 'zzzzzzz' }, 400],
    [{ ...base, scope: 'commit', path: 'tracked.txt', rev: 'f'.repeat(40) }, 404],
    [{ ...base, scope: 'commit', path: 'nope.txt', rev: fixture.headSha }, 404],
  ]
  for (const [params, expected] of cases) {
    const { status } = await call(handlers.diff, route('/api/vcs.diff', params))
    assert.equal(status, expected, `expected ${expected} for ${JSON.stringify(params)}`)
  }

  // A path that looks like pathspec magic must not widen the comparison; the
  // literal pathspec makes it a nonexistent file instead of a repository-wide diff.
  const magic = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, scope: 'unstaged', path: ':(glob)*' }),
  )
  assert.equal(magic.status, 404)
})

test('log pages HEAD and all history with parsed refs and times', async () => {
  const head = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, ref: 'HEAD', limit: 1 }),
  )
  assert.equal(head.status, 200)
  assert.equal(head.body.commits.length, 1)
  assert.equal(head.body.commits[0].sha, fixture.headSha)
  assert.deepEqual(head.body.commits[0].parents, [fixture.rootSha])
  assert.deepEqual(head.body.commits[0].refs, [
    { name: 'main', kind: 'branch', current: true },
  ])
  assert.equal(head.body.commits[0].author, 'Test User')
  assert.equal(typeof head.body.commits[0].authorTime, 'number')
  assert.equal(head.body.commits[0].subject, 'second commit')
  assert.equal(head.body.truncated, false)
  assert.equal(head.body.nextSkip, 1)

  const all = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, ref: 'all', limit: 10 }),
  )
  assert.equal(all.body.commits.length, 2)
  assert.equal(all.body.nextSkip, 2)

  const secondPage = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, skip: 1, limit: 10 }),
  )
  assert.equal(secondPage.body.commits.length, 1)
  assert.equal(secondPage.body.commits[0].sha, fixture.rootSha)

  const clamped = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, limit: 0 }),
  )
  assert.equal(clamped.body.commits.length, 1)
})

test('log answers an unborn branch with an empty page', async () => {
  const { status, body } = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-unborn', repo: unbornPath }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, { commits: [], truncated: false, nextSkip: null })

  const all = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-unborn', repo: unbornPath, ref: 'all' }),
  )
  assert.deepEqual(all.body, { commits: [], truncated: false, nextSkip: null })
})

test('log rejects unknown refs and malformed paging values', async () => {
  const base = { sessionId: 's-main', repo: mainPath }
  for (const params of [
    { ...base, ref: 'main' },
    { ...base, limit: 'seven' },
    { ...base, skip: 'later' },
  ]) {
    const { status, body } = await call(handlers.log, route('/api/vcs.log', params))
    assert.equal(status, 400)
    assert.equal(body.error.code, 'bad-request')
  }
})

test('commit returns metadata, refs, and a stat-ed file list', async () => {
  const { status, body } = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-main', repo: mainPath, sha: fixture.headSha }),
  )
  assert.equal(status, 200)
  assert.equal(body.truncated, false)
  assert.equal(body.commit.sha, fixture.headSha)
  assert.deepEqual(body.commit.parents, [fixture.rootSha])
  assert.deepEqual(body.commit.refs, [{ name: 'main', kind: 'branch' }])
  assert.equal(body.commit.author, 'Test User')
  assert.equal(typeof body.commit.authorTime, 'number')
  assert.equal(body.commit.committer, 'Test User')
  assert.equal(typeof body.commit.committerTime, 'number')
  assert.equal(body.commit.subject, 'second commit')
  assert.equal(body.commit.message, 'second commit')

  const files = new Map(body.commit.files.map(file => [file.path, file]))
  assert.deepEqual(files.get('added.txt'), { path: 'added.txt', status: 'A', added: 1, deleted: 0, binary: false })
  assert.deepEqual(files.get('both.txt'), { path: 'both.txt', status: 'A', added: 1, deleted: 0, binary: false })
  assert.deepEqual(files.get('renamed.txt'), {
    path: 'renamed.txt',
    status: 'R',
    origPath: 'to-rename.txt',
    added: 0,
    deleted: 0,
    binary: false,
  })
  assert.deepEqual(files.get('to-delete.txt'), {
    path: 'to-delete.txt',
    status: 'D',
    added: 0,
    deleted: 1,
    binary: false,
  })
  assert.deepEqual(files.get('tracked.txt'), {
    path: 'tracked.txt',
    status: 'M',
    added: 1,
    deleted: 0,
    binary: false,
  })
  assert.equal(body.commit.files.length, 5)

  const shortSha = await call(
    handlers.commit,
    route('/api/vcs.commit', {
      sessionId: 's-main',
      repo: mainPath,
      sha: fixture.headSha.slice(0, 7),
    }),
  )
  assert.equal(shortSha.body.commit.sha, fixture.headSha)
})

test('commit reads a root commit and its binary file', async () => {
  const { body } = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-main', repo: mainPath, sha: fixture.rootSha }),
  )
  assert.deepEqual(body.commit.parents, [])
  const files = new Map(body.commit.files.map(file => [file.path, file]))
  assert.equal(files.get('.gitignore').status, 'A')
  assert.deepEqual(files.get('image.bin'), {
    path: 'image.bin',
    status: 'A',
    added: 0,
    deleted: 0,
    binary: true,
  })
})

test('commit compares a merge commit against its first parent', async () => {
  const { status, body } = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-merge', repo: mergePath, sha: fixture.mergeSha }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.commit.parents, [fixture.mergeFirstParent, fixture.mergeSecondParent])
  assert.equal(body.commit.subject, 'merge side')
  assert.deepEqual(body.commit.refs, [{ name: 'main', kind: 'branch' }])
  // Without an explicit two-tree diff, `git diff-tree <merge>` prints nothing;
  // the first-parent comparison is what makes the changed file appear.
  assert.deepEqual(body.commit.files, [
    { path: 'side.txt', status: 'A', added: 1, deleted: 0, binary: false },
  ])
  assert.equal(body.truncated, false)

  const single = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-merge',
      repo: mergePath,
      scope: 'commit',
      path: 'side.txt',
      rev: fixture.mergeSha,
    }),
  )
  assert.equal(single.status, 200)
  assert.equal(single.body.before, false)
  assert.equal(single.body.after, true)
  assert.deepEqual(single.body.hunks[0].lines, ['+side'])
})

test('diff and commit detail run git comparisons with --no-ext-diff', async () => {
  const argvSeen = []
  const recording = createHandlers(createHost({
    subprocess: {
      resolveExecutable: command => fakeSubprocess.resolveExecutable(command),
      spawn(spec) {
        argvSeen.push(spec.argv)
        return fakeSubprocess.spawn(spec)
      },
    },
  }))

  await call(
    recording.commit,
    route('/api/vcs.commit', { sessionId: 's-main', repo: mainPath, sha: fixture.headSha }),
  )
  const diffTree = argvSeen.filter(argv => argv.includes('diff-tree'))
  assert.equal(diffTree.length, 2)
  for (const argv of diffTree) {
    assert.ok(argv.includes('--no-ext-diff'), `diff-tree without --no-ext-diff: ${argv.join(' ')}`)
  }

  argvSeen.length = 0
  await call(
    recording.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'tracked.txt',
    }),
  )
  const diff = argvSeen.find(argv => argv.includes('diff'))
  assert.notEqual(diff, undefined)
  assert.ok(diff.includes('--no-ext-diff'), `diff without --no-ext-diff: ${diff.join(' ')}`)
})

test('commit rejects malformed and unknown ids', async () => {
  const base = { sessionId: 's-main', repo: mainPath }
  const malformed = await call(
    handlers.commit,
    route('/api/vcs.commit', { ...base, sha: 'not-a-sha' }),
  )
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.error.code, 'bad-request')

  const unknown = await call(
    handlers.commit,
    route('/api/vcs.commit', { ...base, sha: 'f'.repeat(40) }),
  )
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'not-found')
})

test('a host without git still lists the repository and answers vcs-missing', async () => {
  const missing = createHandlers(createHost({
    subprocess: {
      resolveExecutable: async () => {
        throw new Error('git is not installed')
      },
    },
  }))
  const repositories = await call(
    missing.repositories,
    route('/api/vcs.repositories', { sessionId: 's-main' }),
  )
  assert.equal(repositories.status, 200)
  assert.equal(repositories.body.repositories[0].vcs, 'git')

  const status = await call(
    missing.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(status.status, 503)
  assert.equal(status.body.error.code, 'vcs-missing')

  const log = await call(
    missing.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(log.status, 503)
  assert.equal(log.body.error.code, 'vcs-missing')
})

test('a capped git stdout becomes output-too-large', async () => {
  const lossyHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: true }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {},
    waitForExit: async () => true,
  }
  const capped = createHandlers(createHost({
    subprocess: {
      resolveExecutable: command => fakeSubprocess.resolveExecutable(command),
      spawn(spec) {
        if (spec.argv.includes('status')) return lossyHandle
        return fakeSubprocess.spawn(spec)
      },
    },
  }))
  const { status, body } = await call(
    capped.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(status, 413)
  assert.equal(body.error.code, 'output-too-large')
})


test('repositories identifies a Jujutsu workspace and exposes its capabilities', { skip: !HAS_JJ }, async () => {
  const { status, body } = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-jj' }),
  )
  assert.equal(status, 200)
  const repo = body.repositories.find(candidate => candidate.path === jjPath)
  assert.ok(repo)
  assert.equal(repo.vcs, 'jujutsu')
  assert.equal(repo.capabilities.workingCopy, 'commit')
  assert.deepEqual(repo.capabilities.ranges.map(range => range.value), ['@', 'all'])
  assert.equal(repo.capabilities.defaultRange, '@')
})

test('Jujutsu status reports the working-copy commit and its summary', { skip: !HAS_JJ }, async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
  )
  assert.equal(status, 200)
  assert.equal(body.vcs, 'jujutsu')
  assert.equal(body.capabilities.workingCopy, 'commit')
  assert.equal(body.branch, null)
  assert.equal(body.defaultNode, '@')
  assert.deepEqual(body.groups, {})
  assert.equal(body.workingCopy.node, '@')
  assert.equal(body.workingCopy.commitId, fixture.jjHeadSha)
  assert.ok(body.workingCopy.changeId.length > 0)
  assert.equal(body.workingCopy.subject, 'second commit')
  assert.deepEqual(body.workingCopy.parents, [fixture.jjParentSha])
  assert.ok(body.workingCopy.refs.some(reference => reference.kind === 'bookmark' && reference.name === 'feature'))
  assert.equal(body.workingCopy.summary.changed, 5)
  assert.ok(body.workingCopy.summary.added > 0)
  assert.ok(body.workingCopy.summary.deleted > 0)
})

test('Jujutsu log pages the working copy and all visible history', { skip: !HAS_JJ }, async () => {
  const first = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath }),
  )
  assert.equal(first.status, 200)
  assert.equal(first.body.commits.length, 2)
  assert.equal(first.body.commits[0].sha, fixture.jjHeadSha)
  assert.equal(first.body.commits[0].workingCopy, true)
  assert.equal(first.body.commits[0].subject, 'second commit')
  assert.ok(first.body.commits[0].changeId.length > 0)
  assert.ok(first.body.commits[0].refs.some(reference => reference.kind === 'bookmark' && reference.name === 'feature'))
  assert.equal(first.body.commits[1].sha, fixture.jjParentSha)
  assert.equal(first.body.commits[1].workingCopy, false)
  assert.ok(first.body.commits[1].refs.some(reference => reference.kind === 'bookmark' && reference.name === 'main'))
  assert.deepEqual(first.body.commits[1].parents, [])
  assert.equal(first.body.nextSkip, 2)

  const secondPage = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath, skip: 1, limit: 1 }),
  )
  assert.equal(secondPage.body.commits.length, 1)
  assert.equal(secondPage.body.commits[0].sha, fixture.jjParentSha)

  const all = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath, ref: 'all' }),
  )
  assert.equal(all.body.commits.length, 2)

  const wrongRange = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath, ref: 'HEAD' }),
  )
  assert.equal(wrongRange.status, 400)
  assert.equal(wrongRange.body.error.code, 'bad-request')
})

test('Jujutsu commit detail carries change id, refs, and file stats', { skip: !HAS_JJ }, async () => {
  const workingCopy = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-jj', repo: jjPath, sha: '@' }),
  )
  assert.equal(workingCopy.status, 200)
  assert.equal(workingCopy.body.commit.sha, fixture.jjHeadSha)
  assert.equal(workingCopy.body.commit.workingCopy, true)
  assert.ok(workingCopy.body.commit.changeId.length > 0)
  assert.equal(workingCopy.body.commit.subject, 'second commit')
  assert.equal(workingCopy.body.commit.message, 'second commit')
  assert.deepEqual(workingCopy.body.commit.parents, [fixture.jjParentSha])

  const files = new Map(workingCopy.body.commit.files.map(file => [file.path, file]))
  assert.deepEqual(files.get('tracked.txt'), {
    path: 'tracked.txt', status: 'M', added: 1, deleted: 0, binary: false,
  })
  assert.deepEqual(files.get('renamed.txt'), {
    path: 'renamed.txt', status: 'R', origPath: 'to-rename.txt', added: 0, deleted: 0, binary: false,
  })
  assert.deepEqual(files.get('to-delete.txt'), {
    path: 'to-delete.txt', status: 'D', added: 0, deleted: 1, binary: false,
  })
  assert.deepEqual(files.get('added.txt'), {
    path: 'added.txt', status: 'A', added: 1, deleted: 0, binary: false,
  })
  assert.equal(files.get('image.bin').status, 'M')

  const parent = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-jj', repo: jjPath, sha: fixture.jjParentSha }),
  )
  assert.equal(parent.body.commit.workingCopy, false)
  assert.equal(parent.body.commit.subject, 'initial commit')
  assert.ok(parent.body.commit.refs.some(reference => reference.kind === 'bookmark' && reference.name === 'main'))
  assert.ok(parent.body.commit.files.some(file => file.path === 'tracked.txt' && file.status === 'A'))
})

test('Jujutsu diff reads text, renames, binaries, and missing files', { skip: !HAS_JJ }, async () => {
  const base = { sessionId: 's-jj', repo: jjPath, scope: 'commit', rev: '@' }
  const text = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: 'tracked.txt' }),
  )
  assert.equal(text.status, 200)
  assert.equal(text.body.kind, 'text')
  assert.deepEqual(text.body.hunks[0].lines, [' one', ' two', '+three'])

  const renamed = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      ...base, path: 'renamed.txt', oldPath: 'to-rename.txt',
    }),
  )
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.kind, 'text')
  assert.deepEqual(renamed.body.hunks, [])

  const binary = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: 'image.bin' }),
  )
  assert.equal(binary.status, 200)
  assert.deepEqual(binary.body, { kind: 'binary', path: 'image.bin' })

  const missing = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: 'not-here.txt' }),
  )
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not-found')

  const wrongScope = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, scope: 'unstaged', path: 'tracked.txt' }),
  )
  assert.equal(wrongScope.status, 400)

  const wrongRev = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, rev: 'main', path: 'tracked.txt' }),
  )
  assert.equal(wrongRev.status, 400)

  const escaped = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: '../secret/secret.txt' }),
  )
  assert.equal(escaped.status, 400)

  const untracked = await call(
    handlers.untracked,
    route('/api/vcs.untracked', { sessionId: 's-jj', repo: jjPath, path: 'dir/' }),
  )
  assert.equal(untracked.status, 400)
  assert.equal(untracked.body.error.code, 'bad-request')
})

test('a host without jj answers vcs-missing only when reading', { skip: !HAS_JJ }, async () => {
  const missing = createHandlers(createHost({
    subprocess: {
      resolveExecutable: async (command, _options, _signal) => {
        if (command === 'jj') throw new Error('jj is not installed')
        return fakeSubprocess.resolveExecutable(command)
      },
    },
  }))
  const repositories = await call(
    missing.repositories,
    route('/api/vcs.repositories', { sessionId: 's-jj' }),
  )
  assert.equal(repositories.status, 200)
  assert.ok(repositories.body.repositories.some(repository => repository.vcs === 'jujutsu'))

  const status = await call(
    missing.status,
    route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
  )
  assert.equal(status.status, 503)
  assert.equal(status.body.error.code, 'vcs-missing')
})

test('Jujutsu reads keep the working-copy commit unchanged', { skip: !HAS_JJ }, async () => {
  jj(jjPath, ['status'])
  const before = jj(jjPath, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
  const beforeFile = (await readFile(join(jjPath, 'tracked.txt'), 'utf8'))
  const repository = { sessionId: 's-jj', repo: jjPath }
  await call(handlers.status, route('/api/vcs.status', repository))
  await call(handlers.log, route('/api/vcs.log', repository))
  await call(handlers.commit, route('/api/vcs.commit', { ...repository, sha: '@' }))
  await call(handlers.diff, route('/api/vcs.diff', { ...repository, scope: 'commit', rev: '@', path: 'tracked.txt' }))
  const after = jj(jjPath, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
  const afterFile = (await readFile(join(jjPath, 'tracked.txt'), 'utf8'))
  assert.equal(after, before)
  assert.equal(afterFile, beforeFile)
})

test('Jujutsu status snapshots a new working-copy change on refresh', { skip: !HAS_JJ }, async () => {
  writeFileSync(join(jjPath, 'late.txt'), 'late\n')
  try {
    const { status, body } = await call(
      handlers.status,
      route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
    )
    assert.equal(status, 200)
    assert.equal(body.workingCopy.summary.changed, 6)
    const first = body.workingCopy.commitId
    const again = await call(
      handlers.status,
      route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
    )
    assert.equal(again.body.workingCopy.summary.changed, 6)
    assert.equal(again.body.workingCopy.commitId, first)
  } finally {
    rmSync(join(jjPath, 'late.txt'), { force: true })
    jj(jjPath, ['status'])
  }
})

test('Jujutsu shared snapshot survives one caller aborting and cancels when all callers abort', { skip: !HAS_JJ }, async () => {
  let snapshots = 0
  let snapshotAborted = 0
  let releaseSnapshot = null
  const delayedHandlers = createHandlers(createHost({
    subprocess: {
      resolveExecutable: fakeSubprocess.resolveExecutable,
      spawn(spec) {
        const isSnapshot = spec.argv.includes('commit_id') && !spec.argv.includes('--ignore-working-copy')
        const handle = fakeSubprocess.spawn(spec)
        if (!isSnapshot) return handle
        snapshots += 1
        spec.signal?.addEventListener('abort', () => { snapshotAborted += 1 }, { once: true })
        const gate = new Promise(resolve => { releaseSnapshot = resolve })
        return {
          ...handle,
          done: Promise.all([handle.done, gate]).then(([outcome]) => outcome),
        }
      },
    },
  }))

  // Caller 1 (e.g. TurnTail status) starts snapshotting; Caller 2 (VcsView log)
  // joins while the snapshot is still running; Caller 1 aborts on view switch.
  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  const firstPromise = delayedHandlers.status(new Request(
    `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath })}`,
    { signal: firstAbort.signal },
  ))
  while (releaseSnapshot === null) await new Promise(resolve => { setTimeout(resolve, 5) })
  const secondPromise = delayedHandlers.log(new Request(
    `http://127.0.0.1${route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath })}`,
    { signal: secondAbort.signal },
  ))
  await new Promise(resolve => { setTimeout(resolve, 15) })

  firstAbort.abort()
  await assert.rejects(firstPromise, error => error?.name === 'AbortError')
  assert.equal(snapshotAborted, 0, 'the shared snapshot continues for the remaining caller')

  releaseSnapshot()
  const secondResponse = await secondPromise
  assert.equal(secondResponse.status, 200)
  const secondBody = await secondResponse.json()
  assert.equal(Array.isArray(secondBody.commits), true)
  assert.equal(snapshots, 1)

  // When the only waiting caller aborts, the snapshot subprocess is aborted and evicted.
  releaseSnapshot = null
  const loneAbort = new AbortController()
  const lonePromise = delayedHandlers.status(new Request(
    `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath })}`,
    { signal: loneAbort.signal },
  ))
  while (releaseSnapshot === null) await new Promise(resolve => { setTimeout(resolve, 5) })
  loneAbort.abort()
  releaseSnapshot()
  await assert.rejects(lonePromise, error => error?.name === 'AbortError')
  assert.equal(snapshotAborted, 1)
})

test('apply registers seven GET routes and the POST sync route inside the fence and honors enabled: false', async () => {
  const routes = []
  const ctx = {
    sessions: { get: id => sessions.get(id) },
    fs: fakeFs,
    subprocess: fakeSubprocess,
    effect(fn) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function')
      return dispose
    },
    connection: {
      fetch: {
        register(r) {
          routes.push(r)
          return async () => {}
        },
      },
    },
  }

  apply(ctx, undefined)
  assert.deepEqual(routes.map(r => r.path), [
    '/api/vcs.repositories',
    '/api/vcs.status',
    '/api/vcs.untracked',
    '/api/vcs.diff',
    '/api/vcs.log',
    '/api/vcs.commit',
    '/api/vcs.turn',
    '/api/vcs.sync',
  ])
  for (const registered of routes) {
    assert.deepEqual(registered.methods, registered.path === '/api/vcs.sync' ? ['POST'] : ['GET'])
    assert.equal(registered.requestBody, 'buffered')
  }

  const statusRoute = routes.find(r => r.path === '/api/vcs.status')
  const response = await statusRoute.fetch(new Request(
    `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-main', repo: mainPath })}`,
  ))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')

  // A read stops with the browser; the write keeps going once it has started.
  const left = new AbortController()
  left.abort()
  await assert.rejects(
    statusRoute.fetch(new Request(
      `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-main', repo: mainPath })}`,
      { signal: left.signal },
    )),
    error => error.name === 'AbortError',
  )
  const syncRoute = routes.find(r => r.path === '/api/vcs.sync')
  const syncResponse = await syncRoute.fetch(new Request('http://127.0.0.1/api/vcs.sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-main', repo: mainPath }),
    signal: left.signal,
  }))
  assert.equal(syncResponse.status, 409)
  assert.equal((await syncResponse.json()).error.code, 'no-upstream')

  const disabled = []
  apply({
    ...ctx,
    connection: { fetch: { register: r => { disabled.push(r); return async () => {} } } },
  }, { enabled: false })
  assert.deepEqual(disabled, [])
})

test('normalizeConfig turns the feature off only for a literal enabled: false', () => {
  assert.deepEqual(normalizeConfig(undefined), { enabled: true })
  assert.deepEqual(normalizeConfig(null), { enabled: true })
  assert.deepEqual(normalizeConfig({}), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: true }), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: 'false' }), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: 0 }), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: false }), { enabled: false })
})

test('vcs.turn records each turn\'s active branch across switches, validates inputs, and cleans up', async () => {
  const repoDir = join(fixture.scratch, 'turn-branches')
  initRepo(repoDir)
  writeFileSync(join(repoDir, 'file.txt'), 'v1\n')
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-qm', 'base'])

  const listeners = new Map()
  const turnSessions = new Map([
    ['s-turns', { id: 's-turns', header: { cwd: repoDir } }],
    ['s-unborn', { id: 's-unborn', header: { cwd: fixture.unborn } }],
    ['s-plain', { id: 's-plain', header: { cwd: fixture.plain } }],
    ['s-nocwd', { id: 's-nocwd', header: {} }],
  ])
  const summaries = new Map([
    ['s-turns:11', { turn: 1, cwd: repoDir, files: [{ path: 'file.txt', display: 'file.txt', added: 4, deleted: 1 }], total: 1, added: 4, deleted: 1, snapshot: { before: 'a', after: 'b' } }],
    ['s-turns:22', { turn: 2, cwd: repoDir, files: [], total: 3, added: 18, deleted: 5 }],
    ['s-turns:33', { turn: 3, cwd: repoDir, files: [], total: 2, added: 9, deleted: 0 }],
    ['s-plain:44', { turn: 1, cwd: fixture.plain, files: [], total: 1, added: 7, deleted: 0 }],
  ])

  const emit = (name, ...args) => {
    for (const fn of listeners.get(name) ?? []) fn(...args)
  }
  const emitStopping = async (session, turn) => {
    for (const fn of listeners.get('agent/turn-stopping') ?? []) {
      const bail = await fn({ agent: { session }, turn })
      assert.equal(bail, undefined, 'agent/turn-stopping listener must not return a Cordis bail value')
    }
  }

  const host = {
    sessions: { get: id => turnSessions.get(id) },
    fs: fakeFs,
    subprocess: fakeSubprocess,
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    // Cordis exposes optional services via ctx.get() while direct property read throws without inject.
    get(name) {
      if (name === 'workspaceChanges') {
        return {
          summary: (sessionId, seq) => summaries.get(`${sessionId}:${seq}`),
        }
      }
      return undefined
    },
    get workspaceChanges() {
      throw new Error('handlers must resolve workspaceChanges via ctx.get when present')
    },
  }

  const tracker = createTurnTracker(host)
  const detach = tracker.attach()
  const turnHandlers = createHandlers(host, { turnTracker: tracker })
  const session = turnSessions.get('s-turns')

  try {
    // Turn 1 runs on `main`.
    emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit('session/event', session, { type: 'tool/result', seq: 10, data: { turn: 1, message: { isError: false } } })
    await emitStopping(session, 1)
    emit('session/event', session, { type: 'turn/end', seq: 12, data: { turn: 1 } })

    // Turn 2 checks out `feat/round-2` before stopping.
    git(repoDir, ['checkout', '-qb', 'feat/round-2'])
    emit('session/event', session, { type: 'turn/start', seq: 13, data: { turn: 2 } })
    emit('session/event', session, { type: 'tool/result', seq: 21, data: { turn: 2, message: { isError: false } } })
    await emitStopping(session, 2)
    emit('session/event', session, { type: 'turn/end', seq: 23, data: { turn: 2 } })

    // Turn 3 detaches HEAD and ends abruptly without `agent/turn-stopping`.
    git(repoDir, ['checkout', '-q', '--detach', 'HEAD'])
    emit('session/event', session, { type: 'turn/start', seq: 24, data: { turn: 3 } })
    emit('session/event', session, { type: 'tool/result', seq: 32, data: { turn: 3, message: { isError: false } } })
    emit('session/event', session, { type: 'turn/end', seq: 34, data: { turn: 3 } })

    // Turn 4 has a recorded head (`detached`) without a workspaceChanges summary.
    emit('session/event', session, { type: 'turn/start', seq: 35, data: { turn: 4 } })
    emit('session/event', session, { type: 'tool/result', seq: 36, data: { turn: 4, message: { isError: false } } })
    await emitStopping(session, 4)
    emit('session/event', session, { type: 'turn/end', seq: 37, data: { turn: 4 } })

    // Each turn keeps the branch on which that turn ran, and never leaks cwd/snapshot/files.
    const t1 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 1, seq: 11 }))
    assert.equal(t1.status, 200)
    assert.deepEqual(t1.body, {
      turn: 1,
      head: { kind: 'branch', name: 'main' },
      changed: 1,
      added: 4,
      deleted: 1,
    })

    const t2 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 2, seq: 22 }))
    assert.equal(t2.status, 200)
    assert.deepEqual(t2.body, {
      turn: 2,
      head: { kind: 'branch', name: 'feat/round-2' },
      changed: 3,
      added: 18,
      deleted: 5,
    })

    const t3 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 3, seq: 33 }))
    assert.equal(t3.status, 200)
    assert.deepEqual(t3.body, {
      turn: 3,
      head: { kind: 'detached' },
      changed: 2,
      added: 9,
      deleted: 0,
    })

    const t4 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 4 }))
    assert.equal(t4.status, 200)
    assert.deepEqual(t4.body, {
      turn: 4,
      head: { kind: 'detached' },
      changed: null,
      added: null,
      deleted: null,
    })

    // Unborn repository records `unborn`; plain directory records `head: null`.
    const unbornSession = turnSessions.get('s-unborn')
    emit('session/event', unbornSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit('session/event', unbornSession, { type: 'tool/result', seq: 2, data: { turn: 1, message: { isError: false } } })
    await emitStopping(unbornSession, 1)
    const unborn = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-unborn', turn: 1 }))
    assert.equal(unborn.status, 200)
    assert.deepEqual(unborn.body.head, { kind: 'unborn' })

    const plainSession = turnSessions.get('s-plain')
    emit('session/event', plainSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit('session/event', plainSession, { type: 'tool/result', seq: 2, data: { turn: 1, message: { isError: false } } })
    await emitStopping(plainSession, 1)
    const plain = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-plain', turn: 1, seq: 44 }))
    assert.equal(plain.status, 200)
    assert.deepEqual(plain.body, { turn: 1, head: null, changed: 1, added: 7, deleted: 0 })

    // Validation & missing-turn refusals.
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { turn: 1 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 'missing', turn: 1 }))).status, 409)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-nocwd', turn: 1 }))).status, 409)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 0 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 1, seq: -1 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 2, seq: 11 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 99, seq: 999 }))).status, 404)

    // Session disposal clears recorded heads.
    summaries.clear()
    emit('session/disposed', session)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 1 }))).status, 404)
  } finally {
    detach()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('vcs.turn records Jujutsu working-copy change ids without snapshotting', { skip: !HAS_JJ }, async () => {
  const opBefore = jj(fixture.jj, ['op', 'log', '--no-graph', '--ignore-working-copy', '-n', '1', '-T', 'id.short(12)'])
  const expectedChangeId = jj(fixture.jj, ['log', '--no-graph', '--ignore-working-copy', '-r', '@', '-T', 'change_id'])
  const listeners = new Map()
  const jjSession = { id: 's-jj', header: { cwd: fixture.jj } }
  const host = createHost({
    on(name, fn) {
      listeners.set(name, fn)
      return () => { listeners.delete(name) }
    },
    workspaceChanges: {
      summary: (_id, seq) => (seq === 7 ? { turn: 1, cwd: fixture.jj, files: [], total: 2, added: 11, deleted: 3 } : undefined),
    },
  })
  const tracker = createTurnTracker(host)
  const detach = tracker.attach()
  const jjHandlers = createHandlers(host, { turnTracker: tracker })
  try {
    listeners.get('session/event')(jjSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    listeners.get('session/event')(jjSession, { type: 'tool/result', seq: 6, data: { turn: 1, message: { isError: false } } })
    await listeners.get('agent/turn-stopping')({ agent: { session: jjSession }, turn: 1 })
    const answer = await call(jjHandlers.turn, route('/api/vcs.turn', { sessionId: 's-jj', turn: 1, seq: 7 }))
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      turn: 1,
      head: { kind: 'workingCopy', changeId: expectedChangeId },
      changed: 2,
      added: 11,
      deleted: 3,
    })
    const opAfter = jj(fixture.jj, ['op', 'log', '--no-graph', '--ignore-working-copy', '-n', '1', '-T', 'id.short(12)'])
    assert.equal(opAfter, opBefore, 'turn head capture must not write a jj working-copy snapshot')
  } finally {
    detach()
  }
})

test('every route is read-only: repository state is identical after all requests', async () => {
  const before = gitRaw(fixture.main, ['status', '--porcelain=v2', '-z', '--branch'])
  const headBefore = git(fixture.main, ['rev-parse', 'HEAD'])
  const indexBefore = git(fixture.main, ['ls-files', '-s'])

  const repo = { sessionId: 's-main', repo: mainPath }
  for (const [handler, url] of [
    [handlers.repositories, route('/api/vcs.repositories', { sessionId: 's-main' })],
    [handlers.status, route('/api/vcs.status', repo)],
    [handlers.untracked, route('/api/vcs.untracked', { ...repo, path: 'scratch/' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'unstaged', path: 'tracked.txt' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'staged', path: 'staged.txt' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'untracked', path: 'scratch/notes.md' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'commit', path: 'tracked.txt', rev: fixture.headSha })],
    [handlers.log, route('/api/vcs.log', repo)],
    [handlers.commit, route('/api/vcs.commit', { ...repo, sha: fixture.headSha })],
  ]) {
    const { status } = await call(handler, url)
    assert.equal(status, 200)
  }

  const after = gitRaw(fixture.main, ['status', '--porcelain=v2', '-z', '--branch'])
  assert.equal(after, before)
  assert.equal(git(fixture.main, ['rev-parse', 'HEAD']), headBefore)
  assert.equal(git(fixture.main, ['ls-files', '-s']), indexBefore)
  assert.equal(
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: fixture.main,
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim(),
    headBefore,
  )

  // No lock is left behind by a read.
  let lockExists = true
  try {
    await stat(join(fixture.main, '.git', 'index.lock'))
  } catch (error) {
    if (error.code === 'ENOENT') lockExists = false
    else throw error
  }
  assert.equal(lockExists, false)
})

// Sync ----------------------------------------------------------------------

/**
 * Build one bare remote with two clones of `main`: `local` is the repository
 * the panel syncs, `peer` stands for everyone else pushing to the remote.
 * @param {string} name - scratch subdirectory.
 * @returns {{ remote: string, local: string, peer: string, sessionId: string, handlers: object }} the fixture.
 */
function buildSyncFixture(name) {
  const base = join(fixture.scratch, name)
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  mkdirSync(base, { recursive: true })
  git(base, ['init', '-q', '--bare', '-b', 'main', remote])
  initRepo(seed)
  writeFileSync(join(seed, 'file.txt'), 'base\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-qm', 'base'])
  git(seed, ['push', '-q', remote, 'main'])

  const clone = target => {
    git(base, ['clone', '-q', remote, target])
    git(target, ['config', 'user.email', 'test@example.com'])
    git(target, ['config', 'user.name', 'Test User'])
    git(target, ['config', 'commit.gpgsign', 'false'])
    return target
  }
  const local = clone(join(base, 'local'))
  const peer = clone(join(base, 'peer'))
  const sessionId = `s-sync-${name}`
  const syncSessions = new Map([[sessionId, { header: { cwd: local } }]])
  const syncHandlers = createHandlers(createHost({ sessions: { get: id => syncSessions.get(id) } }))
  return { remote, local, peer, sessionId, handlers: syncHandlers }
}

/** Commit one line to `file` in a clone. */
function commitLine(repo, file, text) {
  writeFileSync(join(repo, file), text)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', `edit ${file}`])
}

/**
 * POST one sync request.
 * @param {Function} handler - the sync handler.
 * @param {unknown} body - JSON body, or a raw string.
 * @param {Record<string, string>} [headers] - request headers.
 * @param {string} [method] - HTTP method.
 */
async function postSync(handler, body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  const response = await handler(new Request('http://127.0.0.1/api/vcs.sync', {
    method,
    headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  return { status: response.status, body: await response.json() }
}

test('sync pushes commits the upstream lacks, then fast-forwards commits it gained, then reports level', async () => {
  const sync = buildSyncFixture('sync-flow')
  const repoPath = realpathSync(sync.local)
  const body = { sessionId: sync.sessionId, repo: repoPath }

  commitLine(sync.local, 'file.txt', 'base\nlocal\n')
  const localHead = git(sync.local, ['rev-parse', 'HEAD'])
  const pushed = await postSync(sync.handlers.sync, body)
  assert.equal(pushed.status, 200)
  assert.deepEqual(pushed.body, { upstream: 'origin/main', pulled: 0, pushed: 1 })
  assert.equal(git(sync.remote, ['rev-parse', 'main']), localHead)

  git(sync.peer, ['pull', '-q', '--ff-only'])
  commitLine(sync.peer, 'other.txt', 'peer\n')
  commitLine(sync.peer, 'other.txt', 'peer\nagain\n')
  git(sync.peer, ['push', '-q', 'origin', 'main'])
  const peerHead = git(sync.peer, ['rev-parse', 'HEAD'])
  // An unrelated working-tree edit rides along a fast-forward untouched.
  writeFileSync(join(sync.local, 'file.txt'), 'base\nlocal\nuncommitted\n')
  const pulled = await postSync(sync.handlers.sync, body)
  assert.equal(pulled.status, 200)
  assert.deepEqual(pulled.body, { upstream: 'origin/main', pulled: 2, pushed: 0 })
  assert.equal(git(sync.local, ['rev-parse', 'HEAD']), peerHead)
  assert.equal(await readFile(join(sync.local, 'file.txt'), 'utf8'), 'base\nlocal\nuncommitted\n')

  const level = await postSync(sync.handlers.sync, body)
  assert.equal(level.status, 200)
  assert.deepEqual(level.body, { upstream: 'origin/main', pulled: 0, pushed: 0 })
  assert.equal(git(sync.remote, ['rev-parse', 'main']), peerHead)
})

test('sync leaves a diverged branch and a blocked fast-forward exactly as they were', async () => {
  const sync = buildSyncFixture('sync-refuse')
  const body = { sessionId: sync.sessionId, repo: realpathSync(sync.local) }

  commitLine(sync.peer, 'file.txt', 'base\npeer\n')
  git(sync.peer, ['push', '-q', 'origin', 'main'])
  const remoteHead = git(sync.remote, ['rev-parse', 'main'])

  // Behind only, but the incoming change touches a file edited locally.
  writeFileSync(join(sync.local, 'file.txt'), 'base\nmine\n')
  const localHead = git(sync.local, ['rev-parse', 'HEAD'])
  const blocked = await postSync(sync.handlers.sync, body)
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'pull-blocked')
  assert.equal(git(sync.local, ['rev-parse', 'HEAD']), localHead)
  assert.equal(await readFile(join(sync.local, 'file.txt'), 'utf8'), 'base\nmine\n')

  // Ahead and behind: nothing merges, rebases, or pushes.
  git(sync.local, ['checkout', '-q', '--', 'file.txt'])
  commitLine(sync.local, 'local.txt', 'local\n')
  const divergedHead = git(sync.local, ['rev-parse', 'HEAD'])
  const diverged = await postSync(sync.handlers.sync, body)
  assert.equal(diverged.status, 409)
  assert.equal(diverged.body.error.code, 'diverged')
  assert.equal(git(sync.local, ['rev-parse', 'HEAD']), divergedHead)
  assert.equal(git(sync.remote, ['rev-parse', 'main']), remoteHead)
})

test('sync reports a push or fetch the remote refused without moving either side', async () => {
  // A remote hook declining the update.
  const declined = buildSyncFixture('sync-declined')
  writeFileSync(join(declined.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected" >&2\nexit 1\n', { mode: 0o755 })
  commitLine(declined.local, 'local.txt', 'local\n')
  const before = git(declined.remote, ['rev-parse', 'main'])
  const refused = await postSync(declined.handlers.sync, { sessionId: declined.sessionId, repo: realpathSync(declined.local) })
  assert.equal(refused.status, 502)
  assert.equal(refused.body.error.code, 'remote-failed')
  assert.equal(git(declined.remote, ['rev-parse', 'main']), before)

  // A remote that cannot be reached fails the fetch the same way.
  git(declined.local, ['remote', 'set-url', 'origin', join(fixture.scratch, 'missing-remote.git')])
  const unreachable = await postSync(declined.handlers.sync, { sessionId: declined.sessionId, repo: realpathSync(declined.local) })
  assert.equal(unreachable.status, 502)
  assert.equal(unreachable.body.error.code, 'remote-failed')
  assert.equal(JSON.stringify(unreachable.body).includes(fixture.scratch), false)
})

test('sync needs a checked-out branch with an upstream', async () => {
  const sync = buildSyncFixture('sync-upstream')
  const body = { sessionId: sync.sessionId, repo: realpathSync(sync.local) }

  git(sync.local, ['checkout', '-qb', 'topic'])
  commitLine(sync.local, 'topic.txt', 'topic\n')
  const untracked = await postSync(sync.handlers.sync, body)
  assert.equal(untracked.status, 409)
  assert.equal(untracked.body.error.code, 'no-upstream')
  assert.equal(git(sync.remote, ['branch', '--list', 'topic']), '')

  git(sync.local, ['checkout', '-q', '--detach'])
  const detached = await postSync(sync.handlers.sync, body)
  assert.equal(detached.status, 409)
  assert.equal(detached.body.error.code, 'no-upstream')
})

test('sync accepts only same-origin JSON POSTs for a discovered repository it can sync', async () => {
  const sync = buildSyncFixture('sync-request')
  const body = { sessionId: sync.sessionId, repo: realpathSync(sync.local) }
  commitLine(sync.local, 'local.txt', 'local\n')
  const remoteHead = git(sync.remote, ['rev-parse', 'main'])

  const cases = [
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/json' }, 'GET'), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'text/plain' }), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/x-www-form-urlencoded' }), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }), 403, 'forbidden'],
    [await postSync(sync.handlers.sync, '{not json'), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, [body]), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, { sessionId: sync.sessionId }), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, { ...body, sessionId: 's-missing' }), 409, 'no-session'],
    [await postSync(sync.handlers.sync, { ...body, repo: plainPath }), 400, 'not-a-repo'],
  ]
  for (const [answer, status, code] of cases) {
    assert.equal(answer.status, status, code)
    assert.equal(answer.body.error.code, code)
  }
  assert.equal(git(sync.remote, ['rev-parse', 'main']), remoteHead)

  const accepted = await postSync(sync.handlers.sync, body, {
    'content-type': 'application/json; charset=utf-8',
    'sec-fetch-site': 'same-origin',
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.pushed, 1)
})

test('sync is refused for a backend without the capability', { skip: !HAS_JJ }, async () => {
  const before = jj(fixture.jj, ['op', 'log', '--no-graph', '-T', 'id', '--limit', '1'])
  const answer = await postSync(handlers.sync, { sessionId: 's-jj', repo: jjPath })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error.code, 'bad-request')
  assert.equal(jj(fixture.jj, ['op', 'log', '--no-graph', '-T', 'id', '--limit', '1']), before)
})

test('a second sync of the same repository is refused while the first runs', async () => {
  const { createBackends } = await import('../lib/vcs/index.js')
  const host = createHost()
  const real = createBackends(host)
  let release
  let started = 0
  const gate = new Promise(resolve => { release = resolve })
  const gated = Object.create(real.get('git'))
  gated.sync = async () => {
    started += 1
    await gate
    return { upstream: 'origin/main', pulled: 0, pushed: 0 }
  }
  const gatedHandlers = createHandlers(host, {
    backends: { get: id => (id === 'git' ? gated : real.get(id)), list: () => real.list() },
  })
  const body = { sessionId: 's-main', repo: mainPath }

  const first = postSync(gatedHandlers.sync, body)
  while (started === 0) await new Promise(resolve => { setTimeout(resolve, 5) })
  const second = await postSync(gatedHandlers.sync, body)
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'busy')
  release()
  assert.equal((await first).status, 200)

  // The lock is released with the answer, so the next sync runs.
  const third = await postSync(gatedHandlers.sync, body)
  assert.equal(third.status, 200)
  assert.equal(started, 2)
})

test('sync diagnostics keep the last stderr lines and drop URL credentials', async () => {
  const { redactDetail } = await import('../lib/sync.js')
  assert.equal(
    redactDetail('hint: one\n\nfatal: unable to access \'https://user:token@example.com/repo.git/\'\nfatal: two\nfatal: three\n'),
    "fatal: unable to access 'https://***@example.com/repo.git/' | fatal: two | fatal: three",
  )
  assert.equal(redactDetail(''), '')
})
