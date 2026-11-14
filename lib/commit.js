/**
 * Commit metadata and the changed-file list of one commit.
 *
 * Metadata comes from one `git show -s` with NUL-separated fields so the full
 * message survives verbatim; the file list is a name-status run paired with a
 * numstat run keyed by the same paths.
 */

const NUL = String.fromCharCode(0)

/** Most files one commit detail lists. */
export const COMMIT_FILE_MAX = 500

/** Fields: commit, parents, author, author seconds, committer, committer seconds, subject, message. */
export const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%at%x00%cn%x00%ct%x00%s%x00%B'

/**
 * Parse `git show -s` output produced with {@link COMMIT_FORMAT}.
 * @param {string} text - the formatted metadata.
 * @returns {object | undefined} the commit fields, or undefined when malformed.
 */
export function parseCommitMetadata(text) {
  const fields = text.split(NUL)
  if (fields.length < 8) return undefined
  const [sha, parents, author, authorSeconds, committer, committerSeconds, subject] = fields
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) return undefined
  // The message is the remainder; it may contain newlines but never NUL.
  const message = fields.slice(7).join(NUL).replace(/\n+$/u, '')
  return {
    sha,
    parents: parents === '' ? [] : parents.split(' '),
    author,
    authorTime: Number(authorSeconds) * 1000,
    committer,
    committerTime: Number(committerSeconds) * 1000,
    subject,
    message,
  }
}

/**
 * The status letter and path of one changed file from `--name-status -z`.
 * @param {string} code - the status code git printed.
 * @returns {string} one letter the view understands.
 */
function statusLetter(code) {
  const letter = code.slice(0, 1)
  // A type change (file to symlink and back) is a modification to the viewer.
  if (letter === 'T') return 'M'
  return 'ABCDMRU'.includes(letter) ? letter : 'M'
}

/**
 * Parse `git diff-tree --name-status -z` output.
 * @param {string} text - NUL-separated records.
 * @returns {{ path: string, status: string, origPath?: string }[]} the changed files.
 */
export function parseNameStatusZ(text) {
  const fields = text.split(NUL)
  const changes = []
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]
    if (code === '') continue
    const letter = statusLetter(code)
    if (letter === 'R' || letter === 'C') {
      // A rename or copy carries its source before the destination.
      const origPath = fields[index + 1]
      const path = fields[index + 2]
      index += 2
      if (origPath === undefined || path === undefined || path === '') continue
      changes.push({ path, status: letter, origPath })
      continue
    }
    const path = fields[index + 1]
    index += 1
    if (path === undefined || path === '') continue
    changes.push({ path, status: letter })
  }
  return changes
}

/**
 * Pair name-status rows with numstat counts.
 * @param {{ path: string, status: string, origPath?: string }[]} changes - name-status rows.
 * @param {Map<string, { added: number, deleted: number, binary: boolean }>} counts - numstat by new path.
 * @returns {{ path: string, status: string, origPath?: string, added: number, deleted: number, binary: boolean }[]}
 */
export function mergeCommitFiles(changes, counts) {
  return changes.map(change => {
    const measured = counts.get(change.path)
    return {
      path: change.path,
      status: change.status,
      ...(change.origPath === undefined ? {} : { origPath: change.origPath }),
      added: measured?.added ?? 0,
      deleted: measured?.deleted ?? 0,
      binary: measured?.binary === true,
    }
  })
}
