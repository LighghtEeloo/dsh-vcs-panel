/** The checked working copies are an ordered subset of a repository's catalog. */

import { preferredNode, WORKTREE, worktreeNode, worktreePath } from './state.js'
import { shortSha } from './format.js'

export function repositoryWorktrees(repository) {
  if (repository?.capabilities?.workingCopy !== 'row') return []
  return repository.worktrees?.length > 0
    ? repository.worktrees
    : [{ path: repository.path, name: repository.name, head: null, branch: null }]
}

/** Normalize missing and removed choices to the repository's first (session) tree. */
export function checkedWorktrees(worktrees, paths) {
  const checked = worktrees.filter(tree => paths.includes(tree.path))
  return checked.length > 0 || worktrees.length === 0 ? checked : [worktrees[0]]
}

export function toggleWorktree(worktrees, paths, path) {
  const checked = checkedWorktrees(worktrees, paths).map(tree => tree.path)
  if (!worktrees.some(tree => tree.path === path)) return checked
  if (checked.includes(path)) return checked.length === 1 ? checked : checked.filter(value => value !== path)
  return checkedWorktrees(worktrees, [...checked, path]).map(tree => tree.path)
}

export function worktreeRefLabel(tree, t) {
  if (tree.branch !== null && tree.branch !== undefined) return tree.branch
  return tree.head ? `${t('top.detached')} · ${shortSha(tree.head)}` : null
}

/** In a multi-tree view (or a sibling preview), default to the working changes. */
export function preferredViewNode(state, worktrees, status) {
  if (worktrees.length === 0) return preferredNode(state, status)
  const current = worktreePath(state.node)
  if (state.nodeChosen && state.node !== null) {
    if (state.node === WORKTREE) return worktreeNode(worktrees[0].path)
    if (current === null || worktrees.some(tree => tree.path === current)) return state.node
  }
  if (worktrees.length !== 1 || worktrees[0].path !== state.repo) {
    const tree = worktrees.find(entry => entry.status?.total > 0) ?? worktrees[0]
    return worktreeNode(tree.path)
  }
  const node = preferredNode({ ...state, nodeChosen: false }, status)
  return node === WORKTREE || (current !== null && current !== worktrees[0].path)
    ? worktreeNode(worktrees[0].path)
    : node
}

/** HEAD decorations refer to the command's checkout, not the shared graph. */
export function sharedRefs(refs) {
  return refs.filter(ref => ref.kind !== 'head').map(ref => {
    if (ref.current !== true) return ref
    const { current, ...shared } = ref
    return shared
  })
}
