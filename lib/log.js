/**
 * `git log` and ref-decoration parsing.
 *
 * The format separates fields with NUL bytes, so an author or subject may hold
 * any character git allows without the record becoming ambiguous.
 */

const NUL = String.fromCharCode(0)

/** Largest page the log route returns. */
export const LOG_PAGE_MAX = 300

/** Deepest offset the history view walks before saying it is capped. */
export const LOG_SKIP_MAX = 10_000

/** Fields: commit, parents, author, author epoch seconds, subject, full decoration. */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%at%x00%s%x00%D'

/**
 * Classify one fully-qualified decorated ref name.
 * @param {string} name - a ref name such as `refs/heads/main`.
 * @returns {{ name: string, kind: 'branch' | 'remote' | 'tag' } | undefined} the short ref.
 */
export function classifyRefName(name) {
  if (name.startsWith('refs/heads/')) {
    return { name: name.slice('refs/heads/'.length), kind: 'branch' }
  }
  if (name.startsWith('refs/remotes/')) {
    return { name: name.slice('refs/remotes/'.length), kind: 'remote' }
  }
  if (name.startsWith('refs/tags/')) {
    return { name: name.slice('refs/tags/'.length), kind: 'tag' }
  }
  return undefined
}

/**
 * Parse a `%D` decoration into the refs a commit row shows.
 *
 * `--decorate=full` yields forms such as `HEAD -> refs/heads/main`,
 * `tag: refs/tags/v1` and `refs/remotes/origin/main`. A HEAD that points to a
 * branch becomes that branch marked `current`; a bare `HEAD` (detached) stays
 * its own `head` ref, so a detached HEAD at a branch tip is not mistaken for
 * being on that branch.
 *
 * @param {string} value - the decoration text, possibly empty.
 * @returns {{ name: string, kind: 'head' | 'branch' | 'remote' | 'tag', current?: true }[]} the refs.
 */
export function parseDecoration(value) {
  const refs = []
  if (value === '') return refs
  for (const raw of value.split(', ')) {
    const token = raw.trim()
    if (token === '') continue
    if (token === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' })
      continue
    }
    if (token.startsWith('HEAD -> ')) {
      const target = classifyRefName(token.slice('HEAD -> '.length))
      if (target?.kind === 'branch') refs.push({ ...target, current: true })
      else refs.push({ name: 'HEAD', kind: 'head' })
      continue
    }
    if (token.startsWith('tag: ')) {
      const target = classifyRefName(token.slice('tag: '.length))
      if (target !== undefined) refs.push(target)
      continue
    }
    const target = classifyRefName(token)
    if (target !== undefined) refs.push(target)
  }
  return refs
}

/**
 * Attach the configured remote and branch to remote-tracking refs.
 *
 * A remote-tracking ref's short name is `remote/branch`, but a remote name may
 * itself contain slashes. Matching configured remote names longest-first keeps
 * `origin/feature/topic` split as `origin` + `feature/topic` when only
 * `origin` exists, and as the longer remote when one is configured.
 *
 * @param {object[]} commits - parsed commits with `refs`.
 * @param {string[]} remotes - configured remote names.
 * @returns {object[]} the commits, with split metadata on resolved remote refs.
 */
export function annotateRemoteRefs(commits, remotes) {
  const ordered = [...remotes].sort((first, second) => second.length - first.length)
  return commits.map(commit => {
    if (!commit.refs.some(ref => ref.kind === 'remote')) return commit
    return {
      ...commit,
      refs: commit.refs.map(ref => {
        if (ref.kind !== 'remote') return ref
        for (const remote of ordered) {
          if (!ref.name.startsWith(`${remote}/`)) continue
          const branch = ref.name.slice(remote.length + 1)
          // `refs/remotes/<remote>/HEAD` is a symbolic convenience ref, not
          // a deletable branch, so it stays a plain display ref. An empty
          // branch means the ref is exactly a remote name; try a shorter one.
          if (branch === '' || branch === 'HEAD') continue
          return { ...ref, remote, branch }
        }
        return ref
      }),
    }
  })
}

/**
 * Parse one `git for-each-ref --format=%(refname)` line list.
 * @param {string} text - newline-separated ref names.
 * @returns {{ name: string, kind: 'branch' | 'remote' | 'tag' }[]} the refs.
 */
export function parseRefNames(text) {
  const refs = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const ref = classifyRefName(line)
    if (ref !== undefined) refs.push(ref)
  }
  return refs
}

/**
 * Parse formatted `git log` output into commit rows.
 * @param {string} text - one record per line, fields NUL-separated.
 * @returns {object[]} the commits, newest first as git printed them.
 */
export function parseLog(text) {
  const commits = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const fields = line.split(NUL)
    if (fields.length < 6) continue
    const [sha, parents, author, seconds, subject, decoration] = fields
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) continue
    commits.push({
      sha,
      parents: parents === '' ? [] : parents.split(' '),
      refs: parseDecoration(decoration ?? ''),
      author,
      authorTime: Number(seconds) * 1000,
      subject,
    })
  }
  return commits
}
