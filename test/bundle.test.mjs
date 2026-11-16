import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Load the generated bundle with a stub module loader and React. */
function loadBundle({ onEffect } = {}) {
  let registered
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))({
    __ModuleLoader__: {
      load(value) { registered = value },
    },
  })
  const react = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useCallback: fn => fn,
    useEffect: fn => onEffect?.(fn),
    useLayoutEffect: fn => fn(),
    useMemo: fn => fn(),
    memo: component => component,
    useRef: value => ({ current: value }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => undefined],
  }
  const jsxRuntime = {
    Fragment: Symbol('Fragment'),
    jsx: (type, props) => ({ type, props: props ?? {}, children: [] }),
    jsxs: (type, props) => ({ type, props: props ?? {}, children: [] }),
  }
  const plugin = registered.factory(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${name})`)
  })
  return { plugin, registered }
}

test('client.js registers the expected module id and exports apply/inject', () => {
  const { plugin, registered } = loadBundle()
  assert.equal(registered.id, 'dsh-vcs-panel')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'uiConversation'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the dictionaries, stylesheet, view, Turn fold, and Turn-tail entry', async () => {
  const pendingEffects = []
  let capturingEffects = false
  const { plugin } = loadBundle({
    onEffect: fn => {
      if (capturingEffects) pendingEffects.push(fn)
    },
  })
  const effects = []
  const localeCalls = []
  const injections = []
  const registrations = []
  const definitions = []
  const activations = []
  const styles = []
  const setViews = []
  const fetchCalls = []
  const document = {
    visibilityState: 'visible',
    head: {
      appendChild(element) { styles.push(element) },
    },
    createElement() {
      return {
        dataset: {},
        textContent: '',
        remove() { this.removed = true },
      }
    },
  }
  const store = {
    create() { throw new Error('the test never mounts the store') },
    spec: { actions: { setView() {} } },
  }
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  globalThis.document = document
  globalThis.fetch = async url => {
    fetchCalls.push(url)
    const params = new URL(url, 'http://127.0.0.1').searchParams
    const turnNumber = Number(params.get('turn'))
    const payloads = {
      1: { turn: 1, head: { kind: 'branch', name: 'feat/turn-1' }, changed: 2, added: 1234, deleted: 0 },
      2: { turn: 2, head: { kind: 'workingCopy', changeId: 'qpvuntsm9999' }, changed: 1, added: 5, deleted: 2 },
      3: { turn: 3, head: { kind: 'branch', name: 'main' }, changed: null, added: null, deleted: null },
      4: { turn: 4, head: { kind: 'branch', name: 'main' }, changed: 0, added: 0, deleted: 0 },
    }
    return {
      ok: true,
      status: 200,
      async json() { return payloads[turnNumber] },
    }
  }
  try {
    const ctx = {
      inject() { return () => undefined },
      effect(fn, label) {
        const disposer = fn()
        effects.push({ label, disposer })
        return disposer
      },
      locale: {
        register(ns, dicts) {
          localeCalls.push({ ns, dicts })
          return () => undefined
        },
        bind(ns) {
          return key => `${ns}:${key}`
        },
        getLocale() {
          return { active: 'zh', locales: [], revision: 0 }
        },
        subscribe() {
          return () => undefined
        },
      },
      uiConversation: {
        events: {
          register(definition) {
            definitions.push(definition)
            return () => undefined
          },
        },
        binding(sessionId) {
          return { activate: view => activations.push({ sessionId, view }) }
        },
      },
      slots: {
        entries(key) {
          assert.equal(key, 'conversation.session')
          return [{ options: { id: 'session' }, store }]
        },
        inject(key, callback) {
          injections.push(key)
          callback()
          return () => undefined
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    }
    plugin.apply(ctx)

    assert.deepEqual(localeCalls.map(call => call.ns), ['vcs'])
    const dictionary = localeCalls[0].dicts
    assert.deepEqual(Object.keys(dictionary).sort(), ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    for (const entries of Object.values(dictionary)) {
      assert.equal(typeof entries['view.label'], 'string')
      assert.equal(typeof entries['diff.loading'], 'string')
      assert.equal(typeof entries['turn.openHint'], 'string')
      assert.equal(typeof entries['turn.openSummary'], 'string')
      assert.equal(typeof entries['turn.fileChanged'], 'string')
      assert.equal(typeof entries['turn.filesChanged'], 'string')
    }

    assert.equal(styles.length, 1)
    assert.match(styles[0].textContent, /\.vcs-root/)
    assert.match(styles[0].textContent, /\.vcs-diff-body/)
    assert.match(styles[0].textContent, /\.vcs-graph/)
    assert.match(styles[0].textContent, /\.vcs-turn-banner/)
    assert.match(styles[0].textContent, /\.vcs-turn-stat/)
    assert.match(styles[0].textContent, /\.vcs-turn-popout/)

    // The fold that publishes "this Turn changed files" has no view target.
    assert.equal(definitions.length, 1)
    assert.equal(definitions[0].kind, 'vcs-changes')
    assert.equal(definitions[0].target, undefined)

    assert.deepEqual(injections, ['conversation.view', 'conversation.chat.turnTail'])
    assert.equal(registrations.length, 2)

    const view = registrations[0]
    assert.equal(view.options.name, 'conversation.view')
    assert.equal(view.options.id, 'vcs')
    assert.equal(view.options.order, 20)
    assert.equal(view.options.locale, 'vcs')
    assert.equal(view.options.label(), 'vcs:view.label')
    assert.equal(typeof view.component, 'function')

    // The registered wrapper passes the active locale to the view so dates and
    // numbers follow the DSH language rather than the browser's.
    const tree = view.component({ sessionId: 'session-1', t: key => `vcs:${key}` })
    const viewTree = tree.props?.children ?? tree.children?.[0]
    assert.equal(viewTree.props.locale, 'zh')

    // The Turn-tail entry reuses the Conversation shell's store handle, which
    // is what exposes `setView` to a non-header entry.
    const tail = registrations[1]
    assert.equal(tail.options.name, 'conversation.chat.turnTail')
    assert.equal(tail.options.id, 'dsh-vcs-panel')
    assert.equal(tail.options.order, -10)
    assert.equal(tail.options.locale, 'vcs')
    assert.equal(tail.options.store, store)
    assert.equal(typeof tail.component, 'function')

    const makeTurn = (turnNumber, seq) => ({
      turn: turnNumber,
      data: {
        get: key => (key === 'vcs-changes'
          ? (seq === undefined ? { changed: true } : { changed: true, seq })
          : undefined),
      },
    })
    const renderBanner = bannerProps => {
      const active = tail.component(bannerProps)
      assert.equal(typeof active.type, 'function')
      const banner = active.type(active.props)
      assert.equal(typeof banner.type, 'function')
      return banner.type(banner.props)
    }
    const flushEffects = async () => {
      const disposers = []
      while (pendingEffects.length > 0) {
        const dispose = pendingEffects.shift()()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
      return () => { for (const dispose of disposers) dispose() }
    }

    const props = {
      turn: makeTurn(1, 12),
      sessionId: 'session-1',
      t: (key, vars) => {
        if (vars === undefined) return `vcs:${key}`
        if ('count' in vars) return `vcs:${key}:${vars.count}`
        return `vcs:${key}:${vars.added}:${vars.deleted}`
      },
      actions: { setView: view => setViews.push(view) },
    }
    capturingEffects = true
    const rendered = renderBanner(props)
    assert.equal(rendered.props.className, 'vcs-turn-tail')
    const button = rendered.props.children
    assert.equal(button.type, 'button')
    assert.equal(button.props.className, 'vcs-turn-banner')
    assert.equal(button.props['aria-label'], 'vcs:turn.openHint')
    assert.equal(button.props.title, 'vcs:turn.openHint')
    const [initialLeft, initialRight] = button.props.children
    assert.equal(initialLeft.props.className, 'vcs-turn-left')
    assert.equal(initialLeft.props.children[2].props.children, 'vcs:turn.openHint')
    assert.equal(initialRight.props.className, 'vcs-turn-right')
    assert.equal(initialRight.props.children[0], null, 'no line counts before turn summary resolves')
    const initialPopout = initialRight.props.children[1].type()
    assert.equal(initialPopout.props.className, 'vcs-turn-popout')
    button.props.onClick()
    assert.deepEqual(activations, [{ sessionId: 'session-1', view: 'vcs' }])
    assert.deepEqual(setViews, ['vcs'])

    // Flush the turn-1 effect and mount turn 2 in the same Session: each turn
    // keeps its own recorded branch / `@` and line-diff counts.
    const cleanupTurn1 = await flushEffects()
    renderBanner({ ...props, turn: makeTurn(2, 24) })
    const cleanupTurn2 = await flushEffects()
    assert.deepEqual(fetchCalls, [
      '/api/vcs.turn?sessionId=session-1&turn=1&seq=12',
      '/api/vcs.turn?sessionId=session-1&turn=2&seq=24',
    ])

    const withCounts = renderBanner(props).props.children
    assert.equal(withCounts.props.title, 'vcs:turn.openHint')
    assert.equal(withCounts.props['aria-label'], 'feat/turn-1 · vcs:turn.filesChanged:2 · vcs:turn.openSummary:1,234:0')
    const [, right] = withCounts.props.children
    const [stat, popout] = right.props.children
    assert.equal(stat.props.className, 'vcs-turn-stat')
    const [addedSpan, deletedSpan] = stat.props.children
    assert.equal(addedSpan.props.className, 'vcs-add')
    assert.deepEqual(addedSpan.props.children, ['+', '1,234'])
    assert.equal(deletedSpan.props.className, 'vcs-del')
    assert.deepEqual(deletedSpan.props.children, ['−', '0'])
    assert.equal(popout.type().props.className, 'vcs-turn-popout')

    const jjBanner = renderBanner({ ...props, turn: makeTurn(2, 24) }).props.children
    assert.equal(jjBanner.props['aria-label'], '@ qpvuntsm · vcs:turn.fileChanged · vcs:turn.openSummary:5:2')

    // A turn with recorded branch but no line counts shows branch + Open VCS.
    renderBanner({ ...props, turn: makeTurn(3) })
    const cleanupTurn3 = await flushEffects()
    const headOnly = renderBanner({ ...props, turn: makeTurn(3) }).props.children
    assert.equal(headOnly.props['aria-label'], 'main · vcs:turn.openHint')
    assert.equal(headOnly.props.children[1].props.children[0], null)

    // A superseded turn whose net changed-file count is 0 hides the banner.
    renderBanner({ ...props, turn: makeTurn(4, 48) })
    const cleanupTurn4 = await flushEffects()
    assert.equal(renderBanner({ ...props, turn: makeTurn(4, 48) }), null)

    cleanupTurn1()
    cleanupTurn2()
    cleanupTurn3()
    cleanupTurn4()
    capturingEffects = false

    // A store with `openView` leaves a focus request for the view instead.
    const opened = []
    const withOpenView = renderBanner({
      ...props,
      actions: { openView: (view, focus) => opened.push([view, focus]), setView: view => setViews.push(view) },
    })
    withOpenView.props.children.props.onClick()
    assert.deepEqual(opened, [['vcs', 'turn-tail']])
    assert.deepEqual(setViews, ['vcs'], 'setView is not also called when openView exists')

    // A Turn without mutation evidence contributes nothing and mounts no hooks.
    const unchanged = tail.component({ ...props, turn: { data: { get: () => undefined } } })
    assert.equal(unchanged, null)

    // Every registration is owned by an effect, so unload removes it.
    for (const effect of effects) assert.equal(typeof effect.label, 'string')
    const style = styles[0]
    const localeDisposer = effects.find(effect => effect.label.includes('locale'))?.disposer
    const styleDisposer = effects.find(effect => effect.label.includes('styles'))?.disposer
    const turnDisposer = effects.find(effect => effect.label.includes('turn changes'))?.disposer
    const summariesDisposer = effects.find(effect => effect.label.includes('turn summaries'))?.disposer
    assert.equal(typeof localeDisposer, 'function')
    assert.equal(typeof styleDisposer, 'function')
    assert.equal(typeof turnDisposer, 'function')
    assert.equal(typeof summariesDisposer, 'function')
    styleDisposer()
    summariesDisposer()
    assert.equal(style.removed, true)
  } finally {
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
})

test('the Turn-tail entry waits for the Conversation store when the Chat view declares first', () => {
  const { plugin } = loadBundle()
  const registrations = []
  const store = {
    create() { throw new Error('the test never mounts the store') },
    spec: { actions: { setView() {} } },
  }
  let entries = []
  let watcher
  let watchDisposed = false
  let tailDisposer
  const document = {
    head: { appendChild() {} },
    createElement() { return { dataset: {}, textContent: '', remove() {} } },
  }
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    plugin.apply({
      inject() { return () => undefined },
      effect(fn) { return fn() },
      locale: {
        register() { return () => undefined },
        bind(ns) { return key => `${ns}:${key}` },
        getLocale() { return { active: 'en', locales: [], revision: 0 } },
        subscribe() { return () => undefined },
      },
      uiConversation: {
        events: { register() { return () => undefined } },
        binding() { return { activate() {} } },
      },
      slots: {
        entries(key) {
          assert.equal(key, 'conversation.session')
          return entries
        },
        subscribe(key, listener) {
          assert.equal(key, 'conversation.session')
          watcher = listener
          return () => { watchDisposed = true }
        },
        inject(key, callback) {
          const dispose = callback()
          if (key === 'conversation.chat.turnTail') tailDisposer = dispose
          return () => undefined
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    })

    // Only the view exists; the store appears after the Chat view declared its slot.
    assert.deepEqual(registrations.map(entry => entry.options.name), ['conversation.view'])
    assert.equal(typeof watcher, 'function')

    entries = [{ options: { id: 'session' }, store }]
    watcher()
    assert.deepEqual(registrations.map(entry => entry.options.name), ['conversation.view', 'conversation.chat.turnTail'])
    assert.equal(registrations[1].options.store, store)
    assert.equal(watchDisposed, true)

    // Disposing the injection removes the entry; the watcher is already gone.
    assert.equal(typeof tailDisposer, 'function')
    tailDisposer()
  } finally {
    globalThis.document = previousDocument
  }
})

test('the Turn-tail entry stays absent when no Conversation store ever appears', () => {
  const { plugin } = loadBundle()
  const registrations = []
  let watcher
  const document = {
    head: { appendChild() {} },
    createElement() { return { dataset: {}, textContent: '', remove() {} } },
  }
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    plugin.apply({
      inject() { return () => undefined },
      effect(fn) { return fn() },
      locale: {
        register() { return () => undefined },
        bind(ns) { return key => `${ns}:${key}` },
        getLocale() { return { active: 'en', locales: [], revision: 0 } },
        subscribe() { return () => undefined },
      },
      uiConversation: {
        events: { register() { return () => undefined } },
        binding() { return { activate() {} } },
      },
      slots: {
        entries() { return [] },
        subscribe(key, listener) { watcher = listener; return () => undefined },
        inject(key, callback) { callback(); return () => undefined },
        register(options) { registrations.push(options) },
      },
    })
    watcher()
    assert.deepEqual(registrations.map(entry => entry.name), ['conversation.view'])
  } finally {
    globalThis.document = previousDocument
  }
})

test('the view shortcut registers and toggles through the invisible Session bridge', () => {
  const { plugin } = loadBundle()
  const registrations = []
  const commands = []
  const activations = []
  const opened = []
  const views = []
  let bridgeDisposer
  let sessionSnapshot = { byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
  const store = {
    create() { throw new Error('the test never mounts the store') },
    spec: { actions: { setView() {} } },
  }
  const scope = {
    effect(fn) {
      const disposer = fn()
      assert.equal(typeof disposer, 'function')
      return disposer
    },
    shortcuts: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    sessions: { list: { getSnapshot: () => sessionSnapshot } },
  }
  const document = {
    head: { appendChild() {} },
    createElement() { return { dataset: {}, textContent: '', remove() {} } },
  }
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    plugin.apply({
      inject(deps, callback) {
        assert.deepEqual(deps, ['shortcuts', 'sessions'])
        callback(scope)
        return () => undefined
      },
      effect(fn) { return fn() },
      locale: {
        register() { return () => undefined },
        bind(ns) { return key => `${ns}:${key}` },
        getLocale() { return { active: 'en', locales: [], revision: 0 } },
        subscribe() { return () => undefined },
      },
      uiConversation: {
        events: { register() { return () => undefined } },
        binding(sessionId) {
          return { activate(view) { activations.push({ sessionId, view }) } }
        },
      },
      slots: {
        entries(key) {
          if (key === 'conversation.session') return [{ options: { id: 'session' }, store }]
          if (key === 'conversation.view') {
            return [{ options: { id: 'vcs' } }, { options: { id: 'chat' } }, { options: { id: 'trajectory' } }]
          }
          return []
        },
        subscribe() { return () => undefined },
        inject(key, callback) {
          const disposer = callback()
          if (key === 'conversation.session.header.utilities') bridgeDisposer = disposer
          return disposer
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    })

    assert.equal(commands.length, 1)
    const command = commands[0]
    assert.equal(command.id, 'vcs.view.toggle')
    assert.equal(command.label(), 'vcs:shortcut.toggle')
    assert.deepEqual(command.regions, ['page', 'editable', 'terminal'])
    assert.deepEqual(command.modals, [])
    assert.deepEqual(command.defaults['desktop:macos'], { code: 'KeyG', modifiers: ['primary', 'shift'] })
    assert.deepEqual(command.defaults['desktop:windows'], { code: 'KeyG', modifiers: ['primary', 'shift'] })
    assert.deepEqual(command.defaults['web:windows'], { code: 'KeyG', modifiers: ['primary', 'shift'] })
    assert.equal(command.defaults['web:linux'], undefined)

    const bridge = registrations.find(entry => entry.options.name === 'conversation.session.header.utilities')
    assert.notEqual(bridge, undefined)
    assert.equal(bridge.options.store, store)
    const requestsCompleted = []
    const actions = {
      openView(view, focus) { opened.push([view, focus]) },
      setView(view) { views.push(view) },
      completeViewRequest() { requestsCompleted.push(true) },
    }
    const show = view => ({ sessionId: 's1', useStore: selector => selector({ view }), actions })

    // Chat -> VCS: the command activates the target and leaves a focus request.
    assert.equal(bridge.component(show('chat')), null)
    const enter = command.resolve({ modal: null, region: 'page', target: null })
    assert.equal(enter.status, 'handled')
    enter.run()
    assert.deepEqual(activations, [{ sessionId: 's1', view: 'vcs' }])
    assert.deepEqual(opened, [['vcs', 'shortcut']])

    // VCS -> the last non-VCS view: setView avoids a second focus request.
    bridge.component(show('vcs'))
    const back = command.resolve({ modal: null, region: 'page', target: null })
    assert.equal(back.status, 'handled')
    back.run()
    assert.deepEqual(activations.at(-1), { sessionId: 's1', view: 'chat' })
    assert.deepEqual(views, ['chat'])
    assert.deepEqual(requestsCompleted, [true], 'leaving clears a request the view never consumed')

    // No current Session and a modal both decline without consuming the key.
    sessionSnapshot = { byId: {} }
    assert.equal(command.resolve({ modal: null, region: 'page', target: null }).status, 'pass')
    sessionSnapshot = { byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
    assert.equal(command.resolve({ modal: 'settings', region: 'page', target: null }).status, 'pass')

    // The bridge injection owns the registration and can be disposed.
    assert.equal(typeof bridgeDisposer, 'function')
    bridgeDisposer()
  } finally {
    globalThis.document = previousDocument
  }
})

test('the stylesheet hides the shipped changed-files card without touching the recorder', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\[data-turn-tail\] \[data-changed-files\] \{\s*display: none !important;/u)
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /workspace-changes/u)
})

test('no component receives the reserved ref prop (React 18 drops it)', () => {
  // DSH ships React 18: a function component receives no "ref" prop there, so
  // <Badge ref={value}> would render the badge with undefined and crash.
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(js|jsx)$/u.test(entry.name)) files.push(path)
    }
  }
  walk(new URL('../src/client', import.meta.url).pathname)
  const offenders = []
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/<([A-Z][A-Za-z0-9_]*)\b[^>]*?\sref=\{/gsu)) {
      offenders.push(`${path}: <${match[1]} ref={...}>`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('selection styles target the classes and attributes the components set', () => {
  const read = path => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
  const css = read('styles.css')
  const timeline = read('history/Timeline.jsx')
  const tree = read('detail/ChangeTree.jsx')

  // Timeline rows mark the selected node with aria-current, and so does the style.
  assert.match(timeline, /'aria-current': index === selectedRow \? 'true'/u)
  assert.match(css, /\.vcs-timeline-row\[aria-current='true'\]/u)

  // The change tree marks the row being read with aria-current="location";
  // the style matches any aria-current value.
  assert.match(tree, /aria-current=\{readingKey === row\.key \? 'location' : undefined\}/u)
  assert.match(css, /\.vcs-tree-row\[aria-current\]/u)
  assert.doesNotMatch(css, /aria-selected/u)
})

test('the change tree exposes disclosure semantics and one tab stop', () => {
  const read = path => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
  const css = read('styles.css')
  const tree = read('detail/ChangeTree.jsx')

  // Every expandable row announces its state and controls its content.
  assert.match(tree, /aria-expanded=\{row\.expanded\}/u)
  assert.match(tree, /aria-expanded=\{expanded\}/u)
  assert.match(tree, /aria-controls=\{bodyId\}/u)
  // Roving tabindex: the whole tree is one Tab stop.
  assert.match(tree, /tabIndex: row\.key === cursorKey \? 0 : -1/u)
  // Hunk jumps locate the markers the diff renderer already writes.
  assert.match(tree, /data-diff-hunk-header/u)
  // The file head sticks below the group head, so at most two rows hold the top.
  assert.match(css, /\.vcs-tree\[data-grouped\] \.vcs-tree-file-head-wrap \{\s*top: var\(--vcs-row-height\);/u)
})
