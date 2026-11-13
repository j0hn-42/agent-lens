// The Burrow view is a preference of the scene style: the graph by default, anything unknown falls back to it.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DEFAULT_UI_PREFS, sanitizePref, sanitizePrefs, parsePrefs, serializePrefs } from '../web/lib/ui-preferences'

test('sceneStyle: the graph is the default', () => {
  assert.equal(DEFAULT_UI_PREFS.sceneStyle, 'graph')
})

test('sceneStyle: only a known style is kept, anything else falls back to the graph', () => {
  assert.equal(sanitizePref('sceneStyle', 'burrow'), 'burrow')
  assert.equal(sanitizePref('sceneStyle', 'graph'), 'graph')
  for (const bad of ['Burrow', '', 3, null, undefined, {}, ['burrow'], true]) assert.equal(sanitizePref('sceneStyle', bad), 'graph')
})

test('sceneStyle survives the stored envelope and a flat v0 object', () => {
  assert.equal(sanitizePrefs({ v: 1, prefs: { sceneStyle: 'burrow' } }).sceneStyle, 'burrow')
  assert.equal(sanitizePrefs({ sceneStyle: 'burrow' }).sceneStyle, 'burrow')
  assert.equal(parsePrefs(serializePrefs({ ...DEFAULT_UI_PREFS, sceneStyle: 'burrow' })).sceneStyle, 'burrow')
  assert.equal(parsePrefs('{"v":1,"prefs":{"sceneStyle":"zoo"}}').sceneStyle, 'graph')
})
