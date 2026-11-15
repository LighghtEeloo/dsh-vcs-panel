import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_VIEW, SHORTCUT_DEFAULTS, SHORTCUT_ID, VCS_VIEW,
  createViewRegistry, mainSessionId, resolveBackView,
} from '../src/client/shortcuts.js'

/** A store action set accepted by the registry. */
function actions() {
  return {
    opened: [],
    views: [],
    openView(view, focus) { this.opened.push([view, focus]) },
    setView(view) { this.views.push(view) },
  }
}

test('the shortcut has one identity and platform-primary defaults', () => {
  assert.equal(SHORTCUT_ID, 'vcs.view.toggle')
  assert.equal(VCS_VIEW, 'vcs')
  assert.equal(DEFAULT_VIEW, 'chat')
  assert.deepEqual(Object.keys(SHORTCUT_DEFAULTS).sort(), [
    'desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows',
  ])
  for (const binding of Object.values(SHORTCUT_DEFAULTS)) {
    assert.deepEqual(binding, { code: 'KeyG', modifiers: ['primary', 'shift'] })
  }
  // DSH's Web policy rejects Mod+Shift on Linux; the command starts unbound there.
  assert.equal(SHORTCUT_DEFAULTS['web:linux'], undefined)
})

test('the first press enters VCS and the second returns to the last non-VCS view', () => {
  const registry = createViewRegistry()
  const store = actions()
  assert.equal(registry.intent('s1'), null, 'no view tracked yet')

  registry.track('s1', 'chat', store)
  assert.deepEqual(registry.intent('s1'), { kind: 'enter', view: 'vcs', actions: store })

  registry.track('s1', 'vcs', store)
  assert.deepEqual(registry.intent('s1'), { kind: 'back', view: 'chat', actions: store })
})

test('a manually visited view becomes the page the next press returns to', () => {
  const registry = createViewRegistry()
  const store = actions()
  registry.track('s1', 'chat', store)
  registry.track('s1', 'vcs', store)
  // The user leaves VCS by clicking another tab; the shortcut's memory follows.
  registry.track('s1', 'trajectory', store)
  registry.track('s1', 'vcs', store)
  assert.deepEqual(registry.intent('s1'), { kind: 'back', view: 'trajectory', actions: store })
})

test('a null persisted view resolves to Chat, including on first mount', () => {
  const registry = createViewRegistry()
  const store = actions()
  registry.track('s1', null, store)
  assert.deepEqual(registry.intent('s1'), { kind: 'enter', view: 'vcs', actions: store })

  const restored = createViewRegistry()
  restored.track('s2', 'vcs', store)
  assert.deepEqual(restored.intent('s2'), { kind: 'back', view: 'chat', actions: store })
})

test('view memory is isolated per Session and ignores unusable actions', () => {
  const registry = createViewRegistry()
  const first = actions()
  const second = actions()
  registry.track('a', 'chat', first)
  registry.track('b', 'trajectory', second)
  registry.track('b', 'vcs', second)

  assert.deepEqual(registry.intent('a'), { kind: 'enter', view: 'vcs', actions: first })
  assert.deepEqual(registry.intent('b'), { kind: 'back', view: 'trajectory', actions: second })

  registry.track('c', 'chat', { setView() {} })
  registry.track('c', 'chat', null)
  registry.track('', 'chat', first)
  assert.equal(registry.intent('c'), null)
  assert.equal(registry.intent(''), null)
})

test('release only removes the matching mounted action set', () => {
  const registry = createViewRegistry()
  const first = actions()
  const second = actions()
  registry.track('s1', 'chat', first)

  registry.release('s1', second)
  assert.deepEqual(registry.intent('s1'), { kind: 'enter', view: 'vcs', actions: first })

  registry.release('s1', first)
  assert.equal(registry.intent('s1'), null)

  // A remounted header with a new action set replaces the old instance.
  registry.track('s1', 'vcs', second)
  assert.deepEqual(registry.intent('s1'), { kind: 'back', view: 'chat', actions: second })
})

test('mainSessionId selects the Session retained by the main view', () => {
  assert.equal(mainSessionId({
    byId: {
      a: { id: 'a', retainedBy: { mainView: 0 } },
      b: { id: 'b', retainedBy: { mainView: 1 } },
    },
  }), 'b')
  assert.equal(mainSessionId({ byId: { a: { id: 'a' } } }), null)
  assert.equal(mainSessionId({}), null)
  assert.equal(mainSessionId(undefined), null)
})

test('resolveBackView rejects unregistered or missing views', () => {
  const registered = new Set(['chat', 'trajectory', 'vcs'])
  assert.equal(resolveBackView('trajectory', registered), 'trajectory')
  assert.equal(resolveBackView('chat', registered), 'chat')
  assert.equal(resolveBackView('removed', registered), 'chat')
  assert.equal(resolveBackView(undefined, registered), 'chat')
  assert.equal(resolveBackView('trajectory', ['chat']), 'chat')
  assert.equal(resolveBackView('trajectory', undefined), 'chat')
})
