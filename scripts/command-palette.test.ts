import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  PALETTE_GROUPS, buildPaletteItems, searchPalette, paletteStatus, sessionDetail, agentDetail,
  type PaletteSource, type PaletteItem,
} from '../web/lib/command-palette'
import { ALL_SESSIONS_ID, type SessionInfo } from '../web/lib/bridge-types'

const calls: string[] = []
const rec = (name: string) => () => { calls.push(name) }

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id, label: `session ${id}`, status: 'active', startTime: 0, lastActivityTime: 1, ...over,
})

function source(over: Partial<PaletteSource> = {}): PaletteSource {
  return {
    singleKeyEnabled: true,
    selectedSessionId: null,
    sessions: [],
    agents: [],
    actions: {
      togglePlayPause: rec('play'), zoomToFit: rec('fit'), toggleFullscreen: rec('fullscreen'), toggleHexGrid: rec('grid'),
      toggleMute: rec('mute'), openShortcuts: rec('shortcuts'), openSettings: rec('settings'),
    },
    togglePanel: p => { calls.push(`panel:${p}`) },
    selectSession: id => { calls.push(`session:${id}`) },
    selectAgent: id => { calls.push(`agent:${id}`) },
    ...over,
  }
}

const byLabel = (items: PaletteItem[], label: string) => {
  const it = items.find(i => i.label === label)
  assert.ok(it, `item "${label}" exists`)
  return it
}

test('palette groups are fixed and ordered', () => {
  assert.deepEqual([...PALETTE_GROUPS], ['Actions', 'Panels', 'Sessions', 'Agents'])
})

test('every panel the app has is reachable, under its glossary name', () => {
  const items = buildPaletteItems(source())
  const panels = items.filter(i => i.group === 'Panels').map(i => i.label)
  assert.deepEqual(panels, [
    'Toggle Sessions and agents list', 'Toggle Files panel', 'Toggle Conversation panel', 'Toggle Timeline panel',
    'Toggle Context panel', 'Toggle System panel', 'Toggle Stats panel', 'Toggle Cost overlay',
  ])
})

test('items run the handler they stand for', () => {
  calls.length = 0
  const items = buildPaletteItems(source({ sessions: [session('s1')], agents: [{ id: 'k1', name: 'main', sessionId: 's1' }] }))
  byLabel(items, 'Toggle Files panel').run()
  byLabel(items, 'Play / pause').run()
  byLabel(items, 'Open settings').run()
  byLabel(items, 'session s1').run()
  byLabel(items, 'main').run()
  assert.deepEqual(calls, ['panel:files', 'play', 'settings', 'session:s1', 'agent:k1'])
})

test('the System entry toggles the System panel under its Y shortcut', () => {
  calls.length = 0
  const items = buildPaletteItems(source())
  const system = byLabel(items, 'Toggle System panel')
  assert.equal(system.shortcut, 'Y')
  system.run()
  assert.deepEqual(calls, ['panel:system'])
})

test('shortcuts are shown only while they work', () => {
  const on = buildPaletteItems(source({ singleKeyEnabled: true }))
  const off = buildPaletteItems(source({ singleKeyEnabled: false }))
  assert.equal(byLabel(on, 'Toggle Files panel').shortcut, 'F')
  assert.equal(byLabel(off, 'Toggle Files panel').shortcut, undefined)
  // ? is a single-key shortcut too (WCAG 2.1.4, #376): hidden while the preference is off
  assert.equal(byLabel(on, 'Show keyboard shortcuts').shortcut, '?')
  assert.equal(byLabel(off, 'Show keyboard shortcuts').shortcut, undefined)
})

test('the All sessions entry exists and jumps to the union view', () => {
  calls.length = 0
  const items = buildPaletteItems(source())
  byLabel(items, 'All sessions').run()
  assert.deepEqual(calls, [`session:${ALL_SESSIONS_ID}`])
})

test('session detail only states what the session list recorded', () => {
  assert.equal(sessionDetail(session('a')), '')
  assert.equal(sessionDetail(session('a', { runtime: 'codex', projectName: 'api', branch: 'main' })), 'Codex, api, main')
  assert.match(sessionDetail(session('a', { status: 'completed' })), /finished/)
  assert.match(sessionDetail(session('a', { imported: true, status: 'completed' })), /imported - not live/)
  assert.doesNotMatch(sessionDetail(session('a', { imported: true, status: 'completed' })), /finished/)
  assert.match(sessionDetail(session('a', { indexedOnly: true })), /indexed - not observed/)
  // "active" is never claimed: nothing here proves it is still running
  assert.doesNotMatch(sessionDetail(session('a', { status: 'active' })), /active|running|live/i)
})

test('the session of the current view is marked', () => {
  const items = buildPaletteItems(source({ sessions: [session('a'), session('b')], selectedSessionId: 'b' }))
  assert.match(byLabel(items, 'session b').detail ?? '', /current view/)
  assert.doesNotMatch(byLabel(items, 'session a').detail ?? '', /current view/)
})

test('agent detail names its session and role, never its state', () => {
  assert.equal(agentDetail({ id: 'k', name: 'n', sessionId: 's', sessionLabel: 'api', kind: 'subagent' }), 'Subagent, session api')
  assert.equal(agentDetail({ id: 'k', name: 'n', sessionId: 's', isMain: true }), 'Main')
  assert.equal(agentDetail({ id: 'k', name: 'n', sessionId: 's' }), '')
})

test('an agent without a usable name is left out instead of shown blank', () => {
  const items = buildPaletteItems(source({ agents: [{ id: 'k1', name: '   ', sessionId: 's' }, { id: 'k2', name: 'ok', sessionId: 's' }] }))
  assert.deepEqual(items.filter(i => i.group === 'Agents').map(i => i.label), ['ok'])
})

test('control characters and overlong labels of untrusted names are cleaned', () => {
  const items = buildPaletteItems(source({ sessions: [session('a', { label: 'bad\u001b[31m name' })], agents: [{ id: 'k', name: 'x'.repeat(500), sessionId: 's' }] }))
  const s = items.find(i => i.group === 'Sessions' && i.id === 'session:a')!
  assert.ok(!/[\u0000-\u001f]/.test(s.label))
  assert.ok(items.find(i => i.group === 'Agents')!.label.length <= 80)
})

test('item ids are unique', () => {
  const items = buildPaletteItems(source({ sessions: [session('a'), session('b')], agents: [{ id: 'a', name: 'a', sessionId: 's' }] }))
  assert.equal(new Set(items.map(i => i.id)).size, items.length)
})

test('panels and agents move focus themselves; plain actions and session jumps do not', () => {
  const items = buildPaletteItems(source({ sessions: [session('a')], agents: [{ id: 'k', name: 'n', sessionId: 's' }] }))
  assert.equal(byLabel(items, 'Toggle Files panel').movesFocus, true)
  assert.equal(byLabel(items, 'n').movesFocus, true)
  assert.equal(byLabel(items, 'Play / pause').movesFocus, false)
  assert.equal(byLabel(items, 'session a').movesFocus, false)
})

// Search

test('an empty query lists every group in order, capped per group, with the hidden count', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => session(`s${i}`))
  const sections = searchPalette(buildPaletteItems(source({ sessions })), '', 5)
  assert.deepEqual(sections.map(s => s.group), ['Actions', 'Panels', 'Sessions'])
  const sess = sections.find(s => s.group === 'Sessions')!
  assert.equal(sess.items.length, 5)
  assert.equal(sess.hidden, 8, '12 sessions + All sessions, 5 shown')
})

test('terms must all match, in any order, case-insensitively', () => {
  const items = buildPaletteItems(source())
  const flat = (q: string) => searchPalette(items, q).flatMap(s => s.items.map(i => i.label))
  assert.deepEqual(flat('PANEL files'), ['Toggle Files panel'])
  assert.deepEqual(flat('zzz'), [])
})

test('label matches rank before detail matches, prefix before substring', () => {
  const items = buildPaletteItems(source({
    sessions: [
      session('a', { label: 'docs', projectName: 'payments' }),
      session('b', { label: 'my payments tool' }),
      session('c', { label: 'payments' }),
    ],
  }))
  const labels = searchPalette(items, 'payments').find(s => s.group === 'Sessions')!.items.map(i => i.label)
  assert.deepEqual(labels, ['payments', 'my payments tool', 'docs'])
})

test('sessions are found by the fields the session list carries (branch, workspace, runtime)', () => {
  const items = buildPaletteItems(source({ sessions: [session('a', { branch: 'feat/x', workspace: '/w/web', runtime: 'copilot' })] }))
  for (const q of ['feat/x', 'web', 'copilot']) {
    assert.equal(searchPalette(items, q).find(s => s.group === 'Sessions')?.items.length, 1, q)
  }
})

test('the status line reports the real count, and says when nothing matches', () => {
  const items = buildPaletteItems(source())
  assert.equal(paletteStatus(searchPalette(items, 'zzz')), 'No matching commands')
  assert.equal(paletteStatus(searchPalette(items, 'files panel')), '1 result')
  const all = searchPalette(items, '', 3)
  assert.match(paletteStatus(all), /^\d+ results? shown, \d+ more: keep typing to narrow$/)
})

test('names of sessions and agents are sensitive (presentation mode blurs them), fixed commands are not (#243, #245)', () => {
  const items = buildPaletteItems(source({ sessions: [session('a')], agents: [{ id: 'k', name: 'n', sessionId: 's' }] }))
  for (const i of items) {
    const expected = i.group === 'Agents' || (i.group === 'Sessions' && i.id !== `session:${ALL_SESSIONS_ID}`)
    assert.equal(i.sensitive, expected, i.id)
  }
})
