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
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useCallback: fn => fn,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: fn => fn(),
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
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the locale dictionaries, one stylesheet, and the Git view', () => {
  const { plugin } = loadBundle()
  const effects = []
  const localeCalls = []
  const views = []
  const styles = []
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
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    const ctx = {
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
      },
      slots: {
        inject(key, callback) {
          assert.equal(key, 'conversation.view')
          callback()
          return () => undefined
        },
        register(options, component) {
          views.push({ options, component })
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
    }

    assert.equal(styles.length, 1)
    assert.match(styles[0].textContent, /\.vcs-root/)
    assert.match(styles[0].textContent, /\.vcs-diff-body/)
    assert.match(styles[0].textContent, /\.vcs-graph/)

    assert.equal(views.length, 1)
    assert.equal(views[0].options.name, 'conversation.view')
    assert.equal(views[0].options.id, 'vcs')
    assert.equal(views[0].options.order, 20)
    assert.equal(views[0].options.locale, 'vcs')
    assert.equal(views[0].options.label(), 'vcs:view.label')
    assert.equal(typeof views[0].component, 'function')

    // Every registration is owned by an effect, so unload removes it.
    for (const effect of effects) assert.equal(typeof effect.label, 'string')
    const style = styles[0]
    const localeDisposer = effects.find(effect => effect.label.includes('locale'))?.disposer
    const styleDisposer = effects.find(effect => effect.label.includes('styles'))?.disposer
    assert.equal(typeof localeDisposer, 'function')
    assert.equal(typeof styleDisposer, 'function')
    styleDisposer()
    assert.equal(style.removed, true)
  } finally {
    globalThis.document = previousDocument
  }
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
