import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { DICTIONARIES } from '../src/client/locales.js'
import { errorMessage, statusKey } from '../src/client/format.js'
import { ERROR_STATUS } from '../lib/errors.js'

/** Languages DSH supports and this panel must ship. */
const LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

/** Placeholders a dictionary value interpolates. */
function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
}

/** Approximate display width, counting CJK/fullwidth glyphs as two columns. */
function displayWidth(text) {
  let width = 0
  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1
  }
  return width
}

/** Every source file below a directory. */
function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.(js|jsx)$/u.test(entry.name)) files.push(path)
  }
  return files
}

test('all eight dictionaries carry the same non-empty keys', () => {
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), [...LOCALES].sort())
  const base = Object.keys(DICTIONARIES.en).sort()
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(DICTIONARIES[locale]).sort(), base, locale)
    for (const key of base) {
      const text = DICTIONARIES[locale][key]
      assert.equal(typeof text, 'string', `${locale} ${key}`)
      assert.notEqual(text.trim(), '', `${locale} ${key}`)
    }
  }
})

test('translations keep every placeholder the English text declares', () => {
  for (const [key, english] of Object.entries(DICTIONARIES.en)) {
    const expected = placeholders(english)
    for (const locale of LOCALES) {
      assert.deepEqual(placeholders(DICTIONARIES[locale][key]), expected, `${locale} ${key}`)
    }
  }
})

test('every literal t(key) and every dynamic key resolves in every dictionary', () => {
  const directory = fileURLToPath(new URL('../src/client', import.meta.url))
  const used = new Set()
  const withPlaceholders = new Set(
    Object.entries(DICTIONARIES.en)
      .filter(([, text]) => placeholders(text).length > 0)
      .map(([key]) => key),
  )
  for (const file of sourceFiles(directory)) {
    if (file.endsWith('locales.js')) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\bt\('([^']+)'/gu)) used.add(match[1])
    // A key that interpolates {count} must be called with its variables.
    for (const match of source.matchAll(/\bt\('([^']+)'\)/gu)) {
      assert.equal(withPlaceholders.has(match[1]), false, `${match[1]} is called without placeholders`)
    }
  }

  // Keys assembled at render time and through shared helpers.
  used.add('changes.staged')
  used.add('changes.unstaged')
  for (const key of ['diff.created', 'diff.deleted', 'diff.unchanged']) used.add(key)
  for (const letter of ['M', 'A', 'D', 'R', 'C', 'U', '?']) used.add(statusKey(letter))
  for (const code of Object.keys(ERROR_STATUS)) {
    let key = null
    errorMessage(next => { key = next; return next }, { code })
    assert.notEqual(key, null, code)
    used.add(key)
  }
  used.add('error.network')

  const missing = [...used].filter(key => DICTIONARIES.en[key] === undefined).sort()
  assert.deepEqual(missing, [])
})

test('view labels stay short enough for the Sidebar chip', () => {
  for (const locale of LOCALES) {
    const label = DICTIONARIES[locale]['view.label']
    assert.ok(displayWidth(label) <= 12, `${locale} view.label is ${displayWidth(label)} columns: ${label}`)
  }
})

test('every dictionary language has plugin metadata', () => {
  for (const locale of LOCALES) {
    const file = fileURLToPath(new URL(`../locale/${locale}.json`, import.meta.url))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof parsed.meta?.title, 'string', `${locale} title`)
    assert.notEqual(parsed.meta.title.trim(), '', `${locale} title`)
    assert.equal(typeof parsed.meta?.description, 'string', `${locale} description`)
    assert.notEqual(parsed.meta.description.trim(), '', `${locale} description`)
  }
})
