import test from 'node:test'
import assert from 'node:assert/strict'

import { BACK, DOWN, FORWARD, hunkStep, isEditableTarget, movement, rowStep, unmodified, UP } from '../src/client/keys.js'

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

test('hunkStep maps j/k to a hunk step inside an expanded file', () => {
  assert.equal(hunkStep({ key: 'j' }), 1)
  assert.equal(hunkStep({ key: 'k' }), -1)
  assert.equal(hunkStep({ key: ']' }), 0)
  assert.equal(hunkStep({ key: 'j', ctrlKey: true }), 0)
  assert.equal(hunkStep({ key: 'J' }), 0)
})

test('rowStep maps the bracket keys to a row step', () => {
  assert.equal(rowStep({ key: ']' }), 1)
  assert.equal(rowStep({ key: '[' }), -1)
  // On a US layout `]` is typed with Shift; Shift is not a command modifier.
  assert.equal(rowStep({ key: ']', shiftKey: true }), 1)
  assert.equal(rowStep({ key: ']', ctrlKey: true }), 0)
  assert.equal(rowStep({ key: 'j' }), 0)
})

test('AltGr is a character modifier, not a command modifier', () => {
  const altGraph = { altKey: true, getModifierState: key => key === 'AltGraph' }
  assert.equal(unmodified(altGraph), true)
  assert.equal(movement({ ...altGraph, key: 'j' }), DOWN)
  assert.equal(hunkStep({ ...altGraph, key: 'j' }), 1)
  assert.equal(rowStep({ ...altGraph, key: ']' }), 1, 'German and French layouts type brackets with AltGr')
  assert.equal(unmodified({ altKey: true, getModifierState: () => false }), false)
  assert.equal(unmodified({ altKey: true }), false, 'an event without modifier state keeps Alt as a command key')
})

test('isEditableTarget recognizes form controls and editable elements without HTMLElement', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true)
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true)
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'BUTTON', isContentEditable: false }), false)
  assert.equal(isEditableTarget({ tagName: 'svg' }), false)
  assert.equal(isEditableTarget(null), false)
  assert.equal(isEditableTarget(undefined), false)
})
