import test from 'node:test'
import assert from 'node:assert/strict'

import { BACK, DOWN, FORWARD, movement, unmodified, UP } from '../src/client/keys.js'

test('movement maps arrows and vim keys to one direction', () => {
  assert.equal(movement({ key: 'ArrowUp' }), UP)
  assert.equal(movement({ key: 'k' }), UP)
  assert.equal(movement({ key: 'ArrowDown' }), DOWN)
  assert.equal(movement({ key: 'j' }), DOWN)
  assert.equal(movement({ key: 'ArrowLeft' }), BACK)
  assert.equal(movement({ key: 'h' }), BACK)
  assert.equal(movement({ key: 'ArrowRight' }), FORWARD)
  assert.equal(movement({ key: 'l' }), FORWARD)
})

test('movement ignores command modifiers and keys outside the vocabulary', () => {
  assert.equal(movement({ key: 'j', ctrlKey: true }), null)
  assert.equal(movement({ key: 'ArrowDown', altKey: true }), null)
  assert.equal(movement({ key: 'h', metaKey: true }), null)
  assert.equal(movement({ key: 'Enter' }), null)
  assert.equal(movement({ key: 'Escape' }), null)
  assert.equal(movement({ key: 'J' }), null)
})

test('unmodified reports the command modifiers', () => {
  assert.equal(unmodified({ key: 'x' }), true)
  assert.equal(unmodified({ key: 'x', ctrlKey: true }), false)
  assert.equal(unmodified({ key: 'x', altKey: true }), false)
  assert.equal(unmodified({ key: 'x', metaKey: true }), false)
})
