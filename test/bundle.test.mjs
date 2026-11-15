import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Load the generated bundle with a stub module loader and React. */
function loadBundle() {
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
    useEffect: () => undefined,
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

test('apply registers the dictionaries, stylesheet, view, Turn fold, and Turn-tail entry', () => {
  const { plugin } = loadBundle()
  const effects = []
  const localeCalls = []
  const injections = []
  const registrations = []
  const definitions = []
  const activations = []
  const styles = []
  const setViews = []
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
  globalThis.document = document
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
    }

    assert.equal(styles.length, 1)
    assert.match(styles[0].textContent, /\.vcs-root/)
    assert.match(styles[0].textContent, /\.vcs-diff-body/)
    assert.match(styles[0].textContent, /\.vcs-graph/)
    assert.match(styles[0].textContent, /\.vcs-turn-icon/)

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

    const turn = { data: { get: key => (key === 'vcs-changes' ? { changed: true } : undefined) } }
    const props = {
      turn,
      sessionId: 'session-1',
      t: key => `vcs:${key}`,
      actions: { setView: view => setViews.push(view) },
    }
    const entry = tail.component(props)
    assert.equal(typeof entry.type, 'function')
    const rendered = entry.type(entry.props)
    assert.equal(rendered.props.className, 'vcs-turn-tail')
    const button = rendered.props.children
    assert.equal(button.type, 'button')
    assert.equal(button.props['aria-label'], 'vcs:turn.openHint')
    assert.equal(button.props.title, 'vcs:turn.openHint')
    button.props.onClick()
    assert.deepEqual(activations, [{ sessionId: 'session-1', view: 'vcs' }])
    assert.deepEqual(setViews, ['vcs'])

    // A store with `openView` leaves a focus request for the view instead.
    const opened = []
    const withOpenView = tail.component({
      ...props,
      actions: { openView: (view, focus) => opened.push([view, focus]), setView: view => setViews.push(view) },
    })
    withOpenView.type(withOpenView.props).props.children.props.onClick()
    assert.deepEqual(opened, [['vcs', 'turn-tail']])
    assert.deepEqual(setViews, ['vcs'], 'setView is not also called when openView exists')

    // A Turn without mutation evidence contributes nothing.
    const unchanged = tail.component({ ...props, turn: { data: { get: () => undefined } } })
    assert.equal(unchanged.type(unchanged.props), null)

    // Every registration is owned by an effect, so unload removes it.
    for (const effect of effects) assert.equal(typeof effect.label, 'string')
    const style = styles[0]
    const localeDisposer = effects.find(effect => effect.label.includes('locale'))?.disposer
    const styleDisposer = effects.find(effect => effect.label.includes('styles'))?.disposer
    const turnDisposer = effects.find(effect => effect.label.includes('turn changes'))?.disposer
    assert.equal(typeof localeDisposer, 'function')
    assert.equal(typeof styleDisposer, 'function')
    assert.equal(typeof turnDisposer, 'function')
    styleDisposer()
    assert.equal(style.removed, true)
  } finally {
    globalThis.document = previousDocument
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
  const nav = read('detail/FileNav.jsx')

  // Timeline rows mark the selected node with aria-current, and so does the style.
  assert.match(timeline, /'aria-current': index === selectedRow \? 'true'/u)
  assert.match(css, /\.vcs-timeline-row\[aria-current='true'\]/u)

  // The navigation marks the file being read with aria-current="location";
  // the style matches any aria-current value.
  assert.match(nav, /aria-current=\{reading \? 'location' : undefined\}/u)
  assert.match(css, /\.vcs-row\[aria-current\]/u)
  assert.doesNotMatch(css, /aria-selected/u)
})
