/**
 * End-to-end component tests for keyboard navigation while files and commits
 * are still loading or are cancelled mid-response.
 *
 * Compiles `VcsView` and `ChangeTree` with esbuild in memory (matching
 * `scripts/build.mjs`) and drives them through a minimal stateful React + DOM
 * harness so hook lifecycles, refs, observers, focus transitions, and keyboard
 * handlers run together without a browser.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../src/client/api.js'
import { buildNodeRows } from '../src/client/detail/tree.js'
import { budgetFolds, streamSections } from '../src/client/detail/detail.js'
import { GIT_CAPABILITIES } from '../lib/vcs/capabilities.js'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Convert a `data-foo-bar` attribute name to its `dataset.fooBar` key. */
function datasetKey(attr) {
  return attr.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
}

/** Minimal DOM element supporting focus, layout offsets, and attribute queries. */
class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.props = {}
    this.dataset = {}
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.offsetParent = null
    this.offsetTop = 0
    this.clientWidth = 1000
    this.clientHeight = 500
    this.scrollTop = 0
    this.listeners = new Map()
    this.classList = {
      contains: token => {
        const raw = this.props.className
        return typeof raw === 'string' && raw.split(/\s+/u).includes(token)
      },
    }
  }

  applyProps(nextProps) {
    this.props = nextProps
    this.dataset = {}
    this.attributes.clear()
    for (const [key, value] of Object.entries(nextProps)) {
      if (value === undefined || value === null) continue
      if (key.startsWith('data-')) {
        this.dataset[datasetKey(key)] = String(value)
        this.attributes.set(key, String(value))
      } else if (key.startsWith('aria-') || key === 'id' || key === 'role' || key === 'title') {
        this.attributes.set(key, String(value))
      }
    }
  }

  setChildren(children) {
    for (const previous of this.children) {
      if (previous instanceof FakeElement && previous.parentElement === this) {
        previous.parentElement = null
      }
    }
    this.children = children
    for (const child of children) {
      if (child instanceof FakeElement) {
        child.parentElement = this
        if (child.offsetParent === null) child.offsetParent = this
      }
    }
  }

  focus() {
    this.ownerDocument.activeElement = this
  }

  contains(target) {
    let cursor = target
    while (cursor !== null && cursor !== undefined) {
      if (cursor === this) return true
      cursor = cursor.parentElement
    }
    return false
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  getBoundingClientRect() {
    let top = 0
    let cursor = this
    while (cursor !== null) {
      top += cursor.offsetTop - (cursor.parentElement?.scrollTop ?? 0)
      cursor = cursor.parentElement
    }
    return { top, left: 0, width: this.clientWidth, height: 28 }
  }

  matchesSelector(selector) {
    const exact = /^\[([a-z0-9-]+)="([^"]*)"\]$/iu.exec(selector)
    if (exact !== null) return this.attributes.get(exact[1]) === exact[2]
    const present = /^\[([a-z0-9-]+)\]$/iu.exec(selector)
    if (present !== null) return this.attributes.has(present[1])
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    return false
  }

  querySelectorAll(selector) {
    const found = []
    const visit = node => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue
        if (child.matchesSelector(selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

/** Compare hook dependency arrays with React's `Object.is` semantics. */
function sameDeps(prev, next) {
  if (prev === undefined || next === undefined || prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return false
  }
  return true
}

/** Shallow prop equality used by `React.memo`. */
function shallowEqual(left, right) {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.is(left[key], right[key]))
}

/**
 * Create an isolated React + DOM test harness that supports stateful re-renders,
 * layout/passive effects, refs, IntersectionObserver, ResizeObserver, and rAF.
 */
function createHarness({ width = 1000 } = {}) {
  const Fragment = Symbol('Fragment')
  const MEMO = Symbol('memo')
  let activeInstance = null

  const document = {
    visibilityState: 'visible',
    body: null,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  }
  document.body = new FakeElement('body', document)
  document.activeElement = document.body

  const frames = []
  const intersections = []
  const resizes = []

  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback
      this.observed = new Set()
      intersections.push(this)
    }
    observe(element) { this.observed.add(element) }
    unobserve(element) { this.observed.delete(element) }
    disconnect() { this.observed.clear() }
    trigger(predicate) {
      const entries = []
      for (const target of this.observed) {
        entries.push({ target, isIntersecting: predicate(target) })
      }
      if (entries.length > 0) this.callback(entries)
    }
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.observed = new Set()
      resizes.push(this)
    }
    observe(element) { this.observed.add(element) }
    unobserve(element) { this.observed.delete(element) }
    disconnect() { this.observed.clear() }
  }

  function createElement(type, rawProps, ...restChildren) {
    const source = rawProps ?? {}
    const props = { ...source }
    const key = props.key ?? null
    const ref = props.ref ?? null
    delete props.key
    delete props.ref
    if (restChildren.length === 1) props.children = restChildren[0]
    else if (restChildren.length > 1) props.children = restChildren
    return { type, key, ref, props }
  }

  const react = {
    Fragment,
    createElement,
    memo(component) {
      return { $$typeof: MEMO, type: component }
    },
    useState(initial) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      if (idx >= inst.hooks.length) {
        inst.hooks.push({ value: typeof initial === 'function' ? initial() : initial })
      }
      const slot = inst.hooks[idx]
      const setState = action => {
        const next = typeof action === 'function' ? action(slot.value) : action
        if (!Object.is(next, slot.value)) {
          slot.value = next
          inst.dirty = true
          scheduleRender()
        }
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      if (idx >= inst.hooks.length) inst.hooks.push({ current: initial })
      return inst.hooks[idx]
    },
    useMemo(factory, deps) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.value
      const value = factory()
      inst.hooks[idx] = { value, deps }
      return value
    },
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps)
    },
    useLayoutEffect(create, deps) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (prev === undefined || !sameDeps(prev.deps, deps)) {
        const entry = { create, deps, cleanup: prev?.cleanup }
        inst.hooks[idx] = entry
        pendingLayout.push(entry)
      }
    },
    useEffect(create, deps) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (prev === undefined || !sameDeps(prev.deps, deps)) {
        const entry = { create, deps, cleanup: prev?.cleanup }
        inst.hooks[idx] = entry
        pendingPassive.push(entry)
      }
    },
  }

  const jsxRuntime = {
    Fragment,
    jsx(type, rawProps, maybeKey) {
      const props = { ...(rawProps ?? {}) }
      if (maybeKey !== undefined) props.key = maybeKey
      return createElement(type, props)
    },
    jsxs(type, rawProps, maybeKey) {
      return jsxRuntime.jsx(type, rawProps, maybeKey)
    },
  }

  let rootElement = null
  let rootInstance = null
  let pendingLayout = []
  let pendingPassive = []
  let rendering = false
  let dirty = false

  function assignRef(ref, value) {
    if (ref === null || ref === undefined) return
    if (typeof ref === 'function') ref(value)
    else if (typeof ref === 'object') ref.current = value
  }

  function unmountNode(mounted) {
    if (mounted === null || mounted === undefined) return
    if (mounted.kind === 'component') {
      unmountNode(mounted.child)
      for (const hook of mounted.hooks) {
        if (typeof hook?.cleanup === 'function') {
          const clean = hook.cleanup
          hook.cleanup = undefined
          clean()
        }
      }
      return
    }
    if (mounted.kind === 'host') {
      for (const child of mounted.children) unmountNode(child)
      assignRef(mounted.ref, null)
      if (document.activeElement === mounted.dom) document.activeElement = document.body
      return
    }
    if (mounted.kind === 'list') {
      for (const child of mounted.items) unmountNode(child)
    }
  }

  function domNodesOf(mounted, out = []) {
    if (mounted === null || mounted === undefined) return out
    if (mounted.kind === 'text' || mounted.kind === 'host') out.push(mounted.dom)
    else if (mounted.kind === 'component') domNodesOf(mounted.child, out)
    else if (mounted.kind === 'list') {
      for (const item of mounted.items) domNodesOf(item, out)
    }
    return out
  }

  function hasDirty(mounted) {
    if (mounted === null || mounted === undefined) return false
    if (mounted.kind === 'component') return mounted.dirty === true || hasDirty(mounted.child)
    if (mounted.kind === 'host') return mounted.children.some(hasDirty)
    if (mounted.kind === 'list') return mounted.items.some(hasDirty)
    return false
  }

  function reconcile(prev, vnode) {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') {
      unmountNode(prev)
      return null
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') {
      unmountNode(prev)
      return { kind: 'text', dom: String(vnode) }
    }
    if (Array.isArray(vnode)) {
      return reconcileList(prev?.kind === 'list' ? prev : (unmountNode(prev), null), vnode)
    }
    if (vnode.type === Fragment) {
      const items = Array.isArray(vnode.props.children)
        ? vnode.props.children
        : vnode.props.children === undefined ? [] : [vnode.props.children]
      return reconcileList(prev?.kind === 'list' ? prev : (unmountNode(prev), null), items)
    }
    const isMemo = typeof vnode.type === 'object' && vnode.type?.$$typeof === MEMO
    const fn = isMemo ? vnode.type.type : vnode.type
    if (typeof fn === 'function') {
      if (prev?.kind === 'component' && prev.fn === fn && prev.key === vnode.key) {
        if (isMemo && shallowEqual(prev.props, vnode.props) && !hasDirty(prev)) {
          return prev
        }
        prev.dirty = false
        prev.props = vnode.props
        prev.hookIndex = 0
        const saved = activeInstance
        activeInstance = prev
        let rendered
        try {
          rendered = fn(vnode.props)
        } finally {
          activeInstance = saved
        }
        prev.child = reconcile(prev.child, rendered)
        return prev
      }
      unmountNode(prev)
      const inst = { kind: 'component', fn, key: vnode.key, props: vnode.props, hooks: [], hookIndex: 0, child: null }
      const saved = activeInstance
      activeInstance = inst
      let rendered
      try {
        rendered = fn(vnode.props)
      } finally {
        activeInstance = saved
      }
      inst.child = reconcile(null, rendered)
      return inst
    }

    // Host element.
    const sameHost = prev?.kind === 'host' && prev.tag === vnode.type && prev.key === vnode.key
    if (!sameHost) unmountNode(prev)
    const dom = sameHost ? prev.dom : new FakeElement(vnode.type, document)
    if (!sameHost) dom.clientWidth = width
    if (sameHost && prev.ref !== vnode.ref) assignRef(prev.ref, null)
    dom.applyProps(vnode.props)
    const rawChildren = vnode.props.children
    const childList = Array.isArray(rawChildren)
      ? rawChildren
      : rawChildren === undefined ? [] : [rawChildren]
    const prevChildren = sameHost ? prev.children : []
    const nextChildren = reconcileChildren(prevChildren, childList)
    dom.setChildren(nextChildren.flatMap(child => domNodesOf(child)))
    if (!sameHost || prev.ref !== vnode.ref) assignRef(vnode.ref, dom)
    return { kind: 'host', tag: vnode.type, key: vnode.key, ref: vnode.ref, dom, children: nextChildren }
  }

  function reconcileChildren(prevList, nextVNodes) {
    const keyedPrev = new Map()
    const unkeyedPrev = []
    for (const item of prevList) {
      if (item !== null && item !== undefined && item.key !== null && item.key !== undefined) {
        keyedPrev.set(item.key, item)
      } else {
        unkeyedPrev.push(item)
      }
    }
    let unkeyedAt = 0
    const next = nextVNodes.map(vnode => {
      const key = vnode !== null && typeof vnode === 'object' && !Array.isArray(vnode) ? vnode.key : null
      if (key !== null && key !== undefined) {
        const match = keyedPrev.get(key) ?? null
        if (match !== null) keyedPrev.delete(key)
        return reconcile(match, vnode)
      }
      const candidate = unkeyedPrev[unkeyedAt++] ?? null
      return reconcile(candidate, vnode)
    })
    for (const leftover of keyedPrev.values()) unmountNode(leftover)
    for (let i = unkeyedAt; i < unkeyedPrev.length; i += 1) unmountNode(unkeyedPrev[i])
    return next
  }

  function reconcileList(prev, items) {
    const prevItems = prev?.items ?? []
    return { kind: 'list', key: null, items: reconcileChildren(prevItems, items) }
  }

  function flushEffects(list) {
    const batch = list.splice(0, list.length)
    for (const effect of batch) {
      if (typeof effect.cleanup === 'function') {
        const clean = effect.cleanup
        effect.cleanup = undefined
        clean()
      }
      const cleanup = effect.create()
      effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  function renderNow() {
    if (rootElement === null || rendering) {
      if (rendering) dirty = true
      return
    }
    rendering = true
    try {
      do {
        dirty = false
        rootInstance = reconcile(rootInstance, rootElement)
        const nodes = domNodesOf(rootInstance)
        document.body.setChildren(nodes)
        flushEffects(pendingLayout)
        flushEffects(pendingPassive)
      } while (dirty || pendingLayout.length > 0 || pendingPassive.length > 0)
    } finally {
      rendering = false
    }
  }

  function scheduleRender() {
    if (rendering) {
      dirty = true
      return
    }
    renderNow()
  }

  let nextFrameId = 1
  const frameMap = new Map()
  const installGlobals = () => {
    const saved = {
      document: globalThis.document,
      IntersectionObserver: globalThis.IntersectionObserver,
      ResizeObserver: globalThis.ResizeObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
    }
    globalThis.document = document
    globalThis.IntersectionObserver = FakeIntersectionObserver
    globalThis.ResizeObserver = FakeResizeObserver
    globalThis.requestAnimationFrame = callback => {
      const id = nextFrameId++
      frameMap.set(id, callback)
      frames.push(id)
      return id
    }
    globalThis.cancelAnimationFrame = id => { frameMap.delete(id) }
    return () => {
      globalThis.document = saved.document
      globalThis.IntersectionObserver = saved.IntersectionObserver
      globalThis.ResizeObserver = saved.ResizeObserver
      globalThis.requestAnimationFrame = saved.requestAnimationFrame
      globalThis.cancelAnimationFrame = saved.cancelAnimationFrame
    }
  }

  return {
    react,
    jsxRuntime,
    document,
    intersections,
    resizes,
    installGlobals,
    mount(vnode) {
      rootElement = vnode
      renderNow()
    },
    unmount() {
      unmountNode(rootInstance)
      rootInstance = null
      rootElement = null
    },
    flushFrames() {
      while (frames.length > 0) {
        const batch = frames.splice(0, frames.length)
        for (const id of batch) {
          const callback = frameMap.get(id)
          frameMap.delete(id)
          callback?.(0)
        }
        renderNow()
      }
    },
    async settle() {
      for (let i = 0; i < 6; i += 1) {
        await new Promise(resolve => { setTimeout(resolve, 0) })
        renderNow()
        this.flushFrames()
      }
    },
    keyDown(target, key, extra = {}) {
      let prevented = false
      let stopped = false
      const event = {
        key,
        target,
        currentTarget: target,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        preventDefault() { prevented = true },
        stopPropagation() { stopped = true },
        ...extra,
      }
      let cursor = target
      while (cursor !== null && cursor !== undefined && !stopped) {
        if (typeof cursor.props?.onKeyDown === 'function') {
          event.currentTarget = cursor
          cursor.props.onKeyDown(event)
        }
        cursor = cursor.parentElement
      }
      renderNow()
      return { prevented, stopped }
    },
  }
}

/** Bundle a client module in memory and evaluate it against a harness's React. */
const compiledCache = new Map()
async function loadClientModule(entryRelPath, harness) {
  let code = compiledCache.get(entryRelPath)
  if (code === undefined) {
    const built = await build({
      entryPoints: [resolve(ROOT, entryRelPath)],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime'],
      loader: { '.css': 'text' },
    })
    code = built.outputFiles[0].text
    compiledCache.set(entryRelPath, code)
  }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    specifier => {
      if (specifier === 'react') return harness.react
      if (specifier === 'react/jsx-runtime') return harness.jsxRuntime
      throw new Error(`unexpected require(${specifier})`)
    },
    mod,
    mod.exports,
  )
  return mod.exports
}

const t = (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`)

test('keyboard navigation past in-flight diffs that abort mid-body never crashes or poisons the cache', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.jsx', harness)
    const entries = [
      { path: 'a.js', status: 'M', added: 4, deleted: 1 },
      { path: 'b.js', status: 'M', added: 3, deleted: 0 },
    ]
    const groups = [{ id: 'unstaged', entries, header: true }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const cache = new Map()
    const control = { current: null }

    // First attempt on `a.js`: 200 OK headers arrived, body stream is still
    // waiting when the user navigates away and IntersectionObserver aborts it.
    let aAttempts = 0
    let pendingBodyAbort = null
    const api = createApi('s-1', {
      fetchImpl: async (url, options) => {
        const parsed = new URL(url, 'http://127.0.0.1')
        const path = parsed.searchParams.get('path')
        if (path === 'a.js' && aAttempts++ === 0) {
          return {
            ok: true,
            status: 200,
            json: () => new Promise((_resolve, reject) => {
              pendingBodyAbort = () => reject(new DOMException('Aborted', 'AbortError'))
              options.signal.addEventListener('abort', () => { pendingBodyAbort() }, { once: true })
            }),
          }
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              kind: 'text',
              path,
              before: true,
              after: true,
              hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${path}`] }],
            }
          },
        }
      },
    })

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false, 'unstaged|b.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache,
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))

    // Both files enter the observer window; a.js starts reading its JSON body,
    // b.js finishes.
    harness.intersections[0].trigger(() => true)
    await harness.settle()
    assert.notEqual(pendingBodyAbort, null, 'a.js is still streaming its body')

    // Focus the tree via keyboard and step down to b.js while a.js scrolls out
    // of the preload margin before its diff finishes loading.
    assert.equal(control.current.focusReading(), true)
    harness.keyDown(harness.document.activeElement, ']')
    harness.keyDown(harness.document.activeElement, ']')
    harness.intersections[0].trigger(el => el.dataset.fileKey !== 'unstaged|a.js')
    await harness.settle()

    assert.equal(
      [...cache.keys()].some(key => key.includes('|a.js|')),
      false,
      'an aborted diff must not be cached as null',
    )

    // Stepping back onto a.js with `[` re-requests it cleanly and renders its hunk.
    harness.keyDown(harness.document.activeElement, '[')
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    assert.equal(aAttempts, 2)
    assert.equal([...cache.keys()].some(key => key.includes('|a.js|')), true)
    const treeEl = harness.document.body.querySelector('.vcs-tree')
    assert.equal(treeEl.querySelectorAll('[data-diff-hunk-header]').length, 2)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree measures static row containers rather than sticky-displaced headers', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.jsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'src/a.js', status: 'M', added: 20, deleted: 0 },
        { path: 'src/b.js', status: 'M', added: 5, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const readings = []

    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+line'] }],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|src/a.js': false, 'unstaged|src/b.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading: value => { readings.push(value) },
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const groupHead = treeEl.querySelector('.vcs-tree-group-head')
    const dirWrap = treeEl.querySelector('.vcs-tree-dir')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const [fileAHead] = treeEl.querySelectorAll('.vcs-tree-file-head')

    // Simulate scrolled layout (`scrollTop = 300`) where sticky headers report
    // stuck `offsetTop` values (300 and 328) while static containers hold true flow positions.
    treeEl.scrollTop = 300
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    groupHead.offsetTop = 300
    groupHead.offsetParent = treeEl

    dirWrap.offsetTop = 28
    dirWrap.offsetParent = treeEl

    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileAHead.parentElement.offsetTop = 328
    fileAHead.parentElement.offsetParent = treeEl

    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl

    // Simulate scrolled layout (`scrollTop = 300`): before the fix, stuck
    // headers reported `offsetTop = 300` / `328` so `report()` misread the
    // directory row (`top = 28`) instead of `src/a.js` (`top = 56`), and `[`
    // refused to scroll back to `src/a.js`.
    treeEl.scrollTop = 300
    treeEl.props.onScroll?.({ currentTarget: treeEl })
    harness.flushFrames()
    assert.deepEqual(readings.at(-1), { key: 'unstaged|src/a.js', offset: 244 })

    control.current.focusReading()
    harness.keyDown(harness.document.activeElement, ']')
    treeEl.scrollTop = 300
    harness.keyDown(harness.document.activeElement, '[')
    assert.equal(treeEl.scrollTop, 28)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree steps hunks with j/k inside an expanded file and moves rows with brackets', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.jsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'a.js', status: 'M', added: 2, deleted: 0 },
        { path: 'b.js', status: 'M', added: 1, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const hunk = line => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [line] })
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: target.path === 'a.js' ? [hunk('+a1'), hunk('+a2')] : [hunk('+b1')],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false, 'unstaged|b.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const headers = treeEl.querySelectorAll('[data-diff-hunk-header]')
    assert.equal(headers.length, 3)

    // Lay out one group row, two file rows, and hunks at 100 / 300 inside a.js
    // and 644 inside b.js.
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl
    headers[0].offsetTop = 44
    headers[1].offsetTop = 244
    headers[2].offsetTop = 44

    // `]` reaches the first file row; `j` then steps to its hunks, while `k`
    // walks back. The brackets keep moving rows past the diff level.
    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(treeEl.scrollTop, 0)

    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(treeEl.scrollTop, 44)
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(treeEl.scrollTop, 244)
    harness.keyDown(harness.document.activeElement, 'k')
    assert.equal(treeEl.scrollTop, 44)

    harness.keyDown(harness.document.activeElement, ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 572)

    harness.keyDown(harness.document.activeElement, '[')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(treeEl.scrollTop, 28)

    // At the end of a.js, j leaves the diff level and focuses b.js's row; the
    // next press enters b.js at its first hunk.
    harness.keyDown(harness.document.activeElement, 'j')
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(treeEl.scrollTop, 244)
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 244)
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 588)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree focuses a closed next file at the end of a diff', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.jsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'a.js', status: 'M', added: 1, deleted: 0 },
        { path: 'b.js', status: 'M', added: 1, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+a'] }],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const headers = treeEl.querySelectorAll('[data-diff-hunk-header]')
    assert.equal(headers.length, 1)
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl
    headers[0].offsetTop = 44

    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(treeEl.scrollTop, 44)
    harness.keyDown(harness.document.activeElement, 'j')

    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 572)
    assert.equal(treeEl.querySelectorAll('.vcs-tree-file-head')[1].attributes.get('aria-expanded'), 'false')
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree enters the closest open diff above from a closed file row', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.jsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'a.js', status: 'M', added: 2, deleted: 0 },
        { path: 'b.js', status: 'M', added: 1, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const hunk = line => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [line] })
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: target.path === 'a.js' ? [hunk('+a1'), hunk('+a2')] : [hunk('+b1')],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const headers = treeEl.querySelectorAll('[data-diff-hunk-header]')
    assert.equal(headers.length, 2)
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl
    headers[0].offsetTop = 44
    headers[1].offsetTop = 244

    // Reach the closed b.js row, then move up through either key.
    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    harness.keyDown(harness.document.activeElement, ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 572)

    harness.keyDown(harness.document.activeElement, 'ArrowUp')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(treeEl.scrollTop, 244)

    harness.keyDown(harness.document.activeElement, ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    harness.keyDown(harness.document.activeElement, 'k')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(treeEl.scrollTop, 244)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree closes an open file on left before leaving the tree', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.jsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const toggles = []
    let leaves = 0
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+a'] }],
        }
      },
    }

    function Tree() {
      const [folds, setFolds] = harness.react.useState({ 'unstaged|a.js': false })
      return harness.react.createElement(ChangeTree, {
        api,
        repo: '/repo',
        rev: null,
        rows,
        budget,
        folds,
        split: false,
        wrap: false,
        revision: 0,
        cache: new Map(),
        initialAnchor: null,
        onReading() {},
        onToggleRow(row, expanded) {
          toggles.push([row.key, expanded])
          setFolds(previous => ({ ...previous, [row.key]: !expanded }))
        },
        onBulkFold() {},
        onLeave() { leaves += 1 },
        control,
        t,
        locale: 'en-US',
      })
    }

    harness.mount(harness.react.createElement(Tree))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const fileHead = () => treeEl.querySelector('.vcs-tree-file-head')
    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(fileHead().attributes.get('aria-expanded'), 'true')

    // The first left closes the diff level instead of leaving the tree.
    harness.keyDown(harness.document.activeElement, 'ArrowLeft')
    assert.deepEqual(toggles, [['unstaged|a.js', false]])
    assert.equal(leaves, 0)
    assert.equal(fileHead().attributes.get('aria-expanded'), 'false')

    // With the file already closed, the same key leaves the tree.
    harness.keyDown(harness.document.activeElement, 'ArrowLeft')
    assert.equal(leaves, 1)
    assert.deepEqual(toggles, [['unstaged|a.js', false]])

    // Escape remains the immediate way out, even while a file is open.
    harness.keyDown(harness.document.activeElement, 'l')
    assert.equal(fileHead().attributes.get('aria-expanded'), 'true')
    harness.keyDown(harness.document.activeElement, 'Escape')
    assert.equal(leaves, 2)
    assert.deepEqual(toggles, [['unstaged|a.js', false], ['unstaged|a.js', true]])
  } finally {
    harness.unmount()
    restore()
  }
})

test('VcsView lands keyboard focus on the timeline and completes deferred detail entry when commit files finish loading', async () => {
  for (const width of [1000, 620]) {
    const harness = createHarness({ width })
    const restore = harness.installGlobals()
    try {
      const { VcsView } = await loadClientModule('src/client/VcsView.jsx', harness)
      const sha1 = 'a'.repeat(40)
      const sha2 = 'b'.repeat(40)
      let resolveCommit2 = null
      let completedRequests = 0

      const fetchImpl = async url => {
        const parsed = new URL(url, 'http://127.0.0.1')
        if (parsed.pathname === '/api/vcs.repositories') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                cwd: '/repo',
                truncated: false,
                repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
              }
            },
          }
        }
        if (parsed.pathname === '/api/vcs.status') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                repo: { path: '/repo', name: 'repo' },
                vcs: 'git',
                capabilities: GIT_CAPABILITIES,
                defaultNode: sha1,
                branch: { name: 'main', oid: sha1, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
                groups: { staged: [], unstaged: [], untracked: [] },
                total: 0,
                truncated: false,
              }
            },
          }
        }
        if (parsed.pathname === '/api/vcs.log') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                truncated: false,
                nextSkip: null,
                commits: [
                  { sha: sha1, parents: [sha2], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'latest' },
                  { sha: sha2, parents: [], refs: [], author: 'Ada', authorTime: 1_699_000_000_000, subject: 'initial' },
                ],
              }
            },
          }
        }
        if (parsed.pathname === '/api/vcs.commit') {
          const sha = parsed.searchParams.get('sha')
          if (sha === sha2) {
            await new Promise(resolve => { resolveCommit2 = resolve })
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                truncated: false,
                commit: {
                  sha,
                  parents: sha === sha1 ? [sha2] : [],
                  refs: [],
                  author: 'Ada',
                  authorTime: 1_700_000_000_000,
                  committer: 'Ada',
                  committerTime: 1_700_000_000_000,
                  subject: sha === sha1 ? 'latest' : 'initial',
                  message: '',
                  files: [{ path: 'src/app.js', status: 'M', added: 2, deleted: 1 }],
                },
              }
            },
          }
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { kind: 'text', path: 'src/app.js', before: true, after: true, hunks: [] }
          },
        }
      }

      const savedFetch = globalThis.fetch
      globalThis.fetch = fetchImpl
      try {
        harness.mount(harness.react.createElement(VcsView, {
          sessionId: `session-kbd-${width}`,
          t,
          locale: 'en-US',
          viewRequest: { view: 'vcs', source: 'shortcut' },
          completeViewRequest: () => { completedRequests += 1 },
        }))
        await harness.settle()

        assert.equal(completedRequests, 1)
        // Clean working tree defaults to HEAD (timeline index 1), and focus followed it.
        assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

        // Step down (`j`) onto sha2 and immediately press `→` (`ArrowRight`)
        // before sha2's files arrive (in wide layout commit starts on `j`; in
        // narrow layout DetailPane mounts on `ArrowRight`).
        harness.keyDown(harness.document.activeElement, 'j')
        await harness.settle()
        harness.keyDown(harness.document.activeElement, 'ArrowRight')
        await harness.settle()
        assert.notEqual(resolveCommit2, null, 'sha2 commit request is still pending')
        if (width < 760) {
          const root = harness.document.body.querySelector('.vcs-root')
          assert.equal(root.contains(harness.document.activeElement), true, 'narrow view keeps focus inside the panel while loading')
        }

        // Once sha2's commit detail finishes, focus lands inside ChangeTree.
        resolveCommit2()
        await harness.settle()
        assert.match(harness.document.activeElement?.dataset?.rowKey ?? '', /^commit\|src/u)
      } finally {
        globalThis.fetch = savedFetch
      }
    } finally {
      harness.unmount()
      restore()
    }
  }
})

test('rapid keyboard commit switching while commit and diff bodies abort never triggers ViewErrorBoundary', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.jsx', harness)
    const sha1 = '1'.repeat(40)
    const sha2 = '2'.repeat(40)
    const sha3 = '3'.repeat(40)

    const fetchImpl = async (url, options) => {
      const parsed = new URL(url, 'http://127.0.0.1')
      if (parsed.pathname === '/api/vcs.repositories') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              cwd: '/repo',
              truncated: false,
              repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
            }
          },
        }
      }
      if (parsed.pathname === '/api/vcs.status') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              repo: { path: '/repo', name: 'repo' },
              vcs: 'git',
              capabilities: GIT_CAPABILITIES,
              defaultNode: sha1,
              branch: { name: 'main', oid: sha1, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
              groups: { staged: [], unstaged: [], untracked: [] },
              total: 0,
              truncated: false,
            }
          },
        }
      }
      if (parsed.pathname === '/api/vcs.log') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              truncated: false,
              nextSkip: null,
              commits: [
                { sha: sha1, parents: [sha2], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 3000, subject: 'c1' },
                { sha: sha2, parents: [sha3], refs: [], author: 'Ada', authorTime: 2000, subject: 'c2' },
                { sha: sha3, parents: [], refs: [], author: 'Ada', authorTime: 1000, subject: 'c3' },
              ],
            }
          },
        }
      }
      if (parsed.pathname === '/api/vcs.commit') {
        const sha = parsed.searchParams.get('sha')
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              truncated: false,
              commit: {
                sha,
                parents: [],
                refs: [],
                author: 'Ada',
                authorTime: 2000,
                committer: 'Ada',
                committerTime: 2000,
                subject: sha.slice(0, 4),
                message: '',
                files: [
                  { path: 'slow.js', status: 'M', added: 5, deleted: 1 },
                  { path: 'fast.js', status: 'M', added: 1, deleted: 0 },
                ],
              },
            }
          },
        }
      }
      // `/api/vcs.diff`: `slow.js` stays in body decoding until aborted on the
      // first visit, then resolves normally when revisited.
      const path = parsed.searchParams.get('path')
      const rev = parsed.searchParams.get('rev')
      if (path === 'slow.js' && rev === sha2 && options?.signal !== undefined) {
        return {
          ok: true,
          status: 200,
          json: () => new Promise((resolveBody, rejectBody) => {
            const timer = setTimeout(() => {
              resolveBody({ kind: 'text', path, before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+ok'] }] })
            }, 25)
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              rejectBody(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { kind: 'text', path, before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+ok'] }] }
        },
      }
    }

    const savedFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      harness.mount(harness.react.createElement(VcsView, {
        sessionId: 'session-rapid',
        t,
        locale: 'en-US',
        viewRequest: { view: 'vcs', source: 'shortcut' },
        completeViewRequest() {},
      }))
      await harness.settle()

      // Step sha1 -> sha2, trigger observer so `slow.js` starts body read, then
      // immediately step sha2 -> sha3 (aborting `slow.js` mid-body), then step
      // back sha3 -> sha2 and read its diffs.
      harness.keyDown(harness.document.activeElement, 'j')
      await harness.settle()
      for (const observer of harness.intersections) observer.trigger(() => true)
      await new Promise(resolve => { setTimeout(resolve, 5) })

      harness.keyDown(harness.document.activeElement, 'j')
      await harness.settle()

      harness.keyDown(harness.document.activeElement, 'k')
      await harness.settle()

      // Files start collapsed; open both of sha2's files before loading them.
      const treeEl = harness.document.body.querySelector('.vcs-tree')
      assert.equal(treeEl.querySelectorAll('[data-diff-hunk-header]').length, 0)
      const fileHeads = treeEl.querySelectorAll('.vcs-tree-file-head')
      assert.equal(fileHeads.length, 2)
      for (const head of fileHeads) {
        head.props.onClick()
        await harness.settle()
      }
      for (const observer of harness.intersections) observer.trigger(() => true)
      await new Promise(resolve => { setTimeout(resolve, 40) })
      await harness.settle()

      assert.equal(treeEl.querySelectorAll('[data-diff-hunk-header]').length, 2)
    } finally {
      globalThis.fetch = savedFetch
    }
  } finally {
    harness.unmount()
    restore()
  }
})
