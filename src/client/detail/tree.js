/**
 * File rows for the detail pane's navigation and diff stream.
 *
 * Every file group (staged, unstaged, untracked, or one commit's files) is a
 * set of paths under collapsible directories; the untracked group also
 * contains directory entries Git collapsed, whose direct children arrive later
 * from `vcs.untracked`. This module turns a group into one flat row list that
 * the navigation renders, the keyboard walks, and the stream follows.
 */

/** The key one directory's expansion state is stored under. */
export function dirKey(group, path) {
  return `${group}|${path.replace(/\/+$/, '')}`
}

/** Stable, locale-independent name order: directories before files. */
function compareNodes(a, b) {
  const left = a.type === b.type ? a.name : a.type === 'dir' ? -1 : 1
  if (a.type !== b.type) return left
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Create a directory node. */
function makeDir(name, path, loadable) {
  return { type: 'dir', name, path, loadable, children: new Map() }
}

/** Find or create a directory child. */
function childDir(node, name, path, loadable = false) {
  const existing = node.children.get(name)
  if (existing !== undefined && existing.type === 'dir') {
    if (loadable) existing.loadable = true
    return existing
  }
  const created = makeDir(name, path, loadable)
  node.children.set(name, created)
  return created
}

/**
 * Insert one entry below a directory node, relative to that node's path.
 * @param {object} node - parent directory node.
 * @param {object[]} segments - remaining path segments.
 * @param {object} entry - file or directory entry.
 * @param {string} path - full path accumulated so far.
 */
function insertAt(node, segments, entry, path) {
  let parent = path
  for (let index = 0; index < segments.length - 1; index += 1) {
    const name = segments[index]
    const next = parent === '' ? name : `${parent}/${name}`
    node = childDir(node, name, next)
    parent = next
  }
  const name = segments[segments.length - 1]
  const full = parent === '' ? name : `${parent}/${name}`
  if (entry.directory) {
    childDir(node, name, full, true)
    return
  }
  node.children.set(name, {
    type: 'file',
    name,
    path: entry.path,
    entry,
  })
}

/** Split one entry path into segments, ignoring a trailing slash. */
function segmentsOf(path) {
  return path.replace(/\/+$/, '').split('/').filter(segment => segment !== '')
}

/**
 * Build the tree for one status group.
 * @param {string} group - 'staged', 'unstaged', 'untracked', or 'commit'.
 * @param {object[]} entries - status entries for this group.
 * @param {object} state - expansion state.
 * @param {Record<string, object[]>} state.dirChildren - loaded untracked children by dirKey.
 * @returns {object} the root directory node.
 */
function buildTree(group, entries, state) {
  const root = makeDir('', '', false)
  for (const entry of entries) {
    const segments = segmentsOf(entry.path)
    if (segments.length === 0) continue
    insertAt(root, segments, entry, '')
  }
  // Loaded untracked children attach to their directory; re-inserting an
  // already known child is a no-op because the map is keyed by name.
  for (const [key, children] of Object.entries(state.dirChildren ?? {})) {
    if (!key.startsWith(`${group}|`)) continue
    const path = key.slice(group.length + 1)
    const segments = segmentsOf(path)
    let node = root
    for (const segment of segments) {
      const next = node.children.get(segment)
      if (next === undefined || next.type !== 'dir') {
        node = undefined
        break
      }
      node = next
    }
    if (node === undefined) continue
    for (const child of children) {
      const rel = child.path.startsWith(`${path}/`) ? child.path.slice(path.length + 1) : child.name
      insertAt(node, segmentsOf(rel), {
        path: child.path,
        directory: child.type === 'directory' || child.path.endsWith('/'),
        status: '?',
        added: 0,
        deleted: 0,
      }, path)
    }
  }
  return root
}

/**
 * Flatten a directory node into visible rows.
 * @param {object} node - directory node to walk.
 * @param {number} depth - indentation depth of the node's children.
 * @param {string} group - the status group.
 * @param {object} state - expansion state.
 * @param {object[]} rows - destination list.
 */
function flatten(node, depth, group, state, rows) {
  const children = [...node.children.values()].sort(compareNodes)
  for (const child of children) {
    if (child.type === 'file') {
      rows.push({
        kind: 'file',
        group,
        depth,
        name: child.name,
        path: child.path,
        entry: child.entry,
      })
      continue
    }
    const key = dirKey(group, child.path)
    const expanded = child.loadable
      ? state.dirs?.[key] === true
      : state.collapsed?.[key] !== true
    rows.push({
      kind: 'dir',
      group,
      depth,
      name: child.name,
      path: `${child.path}/`,
      loadable: child.loadable,
      expanded,
    })
    if (!expanded) continue
    const childrenLoaded = child.loadable && state.dirChildren?.[key] === undefined
    if (childrenLoaded) {
      if (state.loadingDirs?.[key] === true) {
        rows.push({ kind: 'loading', group, depth: depth + 1, key })
      }
      continue
    }
    flatten(child, depth + 1, group, state, rows)
  }
}

/**
 * Flat, visible rows for one group.
 * @param {string} group - status group.
 * @param {object[]} entries - entries for that group.
 * @param {object} [state] - expansion data.
 * @returns {object[]} rows in display order.
 */
export function buildRows(group, entries, state = {}) {
  const rows = []
  flatten(buildTree(group, entries, state), 0, group, state, rows)
  return rows
}
