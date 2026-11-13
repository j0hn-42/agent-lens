// The Burrow view is a preference of the scene style: the graph by default, anything unknown falls back to it.
import './all-locales'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DEFAULT_UI_PREFS, sanitizePref, sanitizePrefs, parsePrefs, serializePrefs } from '../web/lib/ui-preferences'
import { MESSAGES } from '../web/lib/messages'

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

test('burrowTitles: on by default, only a boolean is kept', () => {
  assert.equal(DEFAULT_UI_PREFS.burrowTitles, true)
  assert.equal(sanitizePref('burrowTitles', false), false)
  assert.equal(sanitizePref('burrowTitles', true), true)
  for (const bad of ['false', 0, null, undefined, {}, []]) assert.equal(sanitizePref('burrowTitles', bad), true)
})

test('burrowTitles round-trips through serializePrefs and parsePrefs', () => {
  assert.equal(parsePrefs(serializePrefs({ ...DEFAULT_UI_PREFS, burrowTitles: false })).burrowTitles, false)
  assert.equal(parsePrefs(serializePrefs(DEFAULT_UI_PREFS)).burrowTitles, true)
  assert.equal(parsePrefs('{"v":1,"prefs":{"burrowTitles":"no"}}').burrowTitles, true)
})

// Reset preferences replaces every stored pref by its default: it also leaves the Burrow view for the node graph.
// Its help and the preferences guide must say so, or a reset that changes the whole scene comes as a surprise.
test('the reset help says that Reset preferences goes back from the Burrow view to the node graph, in both languages', () => {
  assert.match(MESSAGES.fr['settings.reset.help'], /Vue Terrier[^;.]*graphe/)
  assert.match(MESSAGES.en['settings.reset.help'], /Burrow view[^;.]*graph/)
})

test('the preferences guide lists the Burrow view and its room titles among the stored preferences', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'reading-the-ui', 'preferences.md'), 'utf8')
  const stored = guide.split('\n').find((l) => l.startsWith('- **Preferences and Reset preferences**')) ?? ''
  assert.match(stored, /\*\*Burrow view\*\*/)
  assert.match(stored, /\*Room titles\*/)
})
