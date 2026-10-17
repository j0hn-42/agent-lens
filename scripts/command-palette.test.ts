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
  assert.deepEqual([...PALETTE_GROUPS], ['Actions', 'Panels', 'Sessions', 'Agents', 'Themes'])
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

// Commands that were missing (#377): offered only while they can run, never with a state the palette cannot prove

test('optional commands are absent when the view cannot run them', () => {
  const items = buildPaletteItems(source())
  const labels = items.map(i => i.label)
  for (const l of ['Toggle presentation mode', 'Clear history', 'Export this session as an HTML replay', 'Go to the next agent that needs you', 'Turn notifications on', 'Turn notifications off', 'Tour this session']) {
    assert.ok(!labels.includes(l), l)
  }
  assert.equal(items.filter(i => i.group === 'Themes').length, 0)
})

test('presentation, clear history and export run their handler, with the V shortcut only while it works', () => {
  calls.length = 0
  const actions = { ...source().actions, togglePresentation: rec('present'), clearHistory: rec('clear'), exportSession: rec('export') }
  const items = buildPaletteItems(source({ actions }))
  byLabel(items, 'Toggle presentation mode').run()
  byLabel(items, 'Clear history').run()
  byLabel(items, 'Export this session as an HTML replay').run()
  assert.deepEqual(calls, ['present', 'clear', 'export'])
  assert.equal(byLabel(items, 'Toggle presentation mode').shortcut, 'V')
  assert.equal(byLabel(buildPaletteItems(source({ actions, singleKeyEnabled: false })), 'Toggle presentation mode').shortcut, undefined)
  assert.equal(searchPalette(items, 'download')[0]?.items[0]?.label, 'Export this session as an HTML replay')
})

test('the tour is offered under the label the legend uses, and moves focus to its card', () => {
  calls.length = 0
  const items = buildPaletteItems(source({ tour: { label: 'Tour this session', run: rec('tour') } }))
  const it = byLabel(items, 'Tour this session')
  assert.equal(it.group, 'Actions')
  assert.equal(it.movesFocus, true)
  it.run()
  assert.deepEqual(calls, ['tour'])
  assert.equal(searchPalette(items, 'onboarding')[0]?.items[0]?.label, 'Tour this session')
})

test('the next blocked agent is offered with the counter text only, first in Actions', () => {
  calls.length = 0
  const items = buildPaletteItems(source({ attention: { detail: '2 waiting / 1 error', movesFocus: true, run: rec('next') } }))
  const it = byLabel(items, 'Go to the next agent that needs you')
  assert.equal(it.detail, '2 waiting / 1 error')
  assert.equal(it.movesFocus, true)
  assert.equal(items.filter(i => i.group === 'Actions')[0], it)
  it.run()
  assert.deepEqual(calls, ['next'])
  assert.equal(searchPalette(items, 'permission')[0]?.items[0]?.label, 'Go to the next agent that needs you')
  // The next one is in another session: the view switches, no card takes the focus, so the palette gives it back
  const other = buildPaletteItems(source({ attention: { detail: '1 waiting', movesFocus: false, run: rec('next') } }))
  assert.equal(byLabel(other, 'Go to the next agent that needs you').movesFocus, false)
})

test('the notification command names the change it makes', () => {
  calls.length = 0
  const off = buildPaletteItems(source({ notifications: { on: false, run: rec('notify') } }))
  byLabel(off, 'Turn notifications on').run()
  const on = buildPaletteItems(source({ notifications: { on: true, run: rec('notify') } }))
  byLabel(on, 'Turn notifications off').run()
  assert.deepEqual(calls, ['notify', 'notify'])
})

test('each theme is a command of its own group, the current one marked, found by "theme"', () => {
  calls.length = 0
  const items = buildPaletteItems(source({
    themes: { current: 'neon', options: [{ id: 'midnight', label: 'Midnight' }, { id: 'neon', label: 'Neon' }], set: id => { calls.push(`theme:${id}`) } },
  }))
  const themes = items.filter(i => i.group === 'Themes')
  assert.deepEqual(themes.map(i => i.label), ['Theme: Midnight', 'Theme: Neon'])
  assert.equal(byLabel(items, 'Theme: Neon').detail, 'current theme')
  assert.equal(byLabel(items, 'Theme: Midnight').detail, undefined)
  byLabel(items, 'Theme: Midnight').run()
  assert.deepEqual(calls, ['theme:midnight'])
  assert.equal(searchPalette(items, 'theme').find(s => s.group === 'Themes')?.items.length, 2)
  assert.ok(themes.every(i => !i.sensitive))
})

test('the Files panel is found by the repeated reads and calls it lists', () => {
  const items = buildPaletteItems(source())
  for (const q of ['waste', 'repeated']) {
    assert.equal(searchPalette(items, q).find(s => s.group === 'Panels')?.items[0]?.label, 'Toggle Files panel', q)
  }
})

// Global entry to launch an agent (#377): the launch itself stays in the agent card, which lists the issues labelled
// agent:<role> with their Launch button; the palette only leads there, one entry per role and session

test('launch entries are absent while the relay does not offer launches, or without an agent bearing a role', () => {
  const agents = [{ id: 'k1', name: 'fe', sessionId: 's1', role: 'frontend-engineer' }]
  assert.equal(buildPaletteItems(source({ agents })).filter(i => i.id.startsWith('launch:')).length, 0)
  assert.equal(buildPaletteItems(source({ agents: [{ id: 'k1', name: 'main', sessionId: 's1' }], launchAvailable: true })).filter(i => i.id.startsWith('launch:')).length, 0)
})

test('one launch entry per role and session opens the card of the first agent bearing it', () => {
  calls.length = 0
  const items = buildPaletteItems(source({
    launchAvailable: true,
    agents: [
      { id: 'k1', name: 'fe-1', sessionId: 's1', sessionLabel: 'web', role: 'frontend-engineer' },
      { id: 'k2', name: 'fe-2', sessionId: 's1', sessionLabel: 'web', role: 'frontend-engineer' },
      { id: 'k3', name: 'qa', sessionId: 's1', sessionLabel: 'web', role: 'qa-engineer' },
      { id: 'k4', name: 'fe-3', sessionId: 's2', sessionLabel: 'api', role: 'frontend-engineer' },
    ],
  }))
  const launches = items.filter(i => i.id.startsWith('launch:'))
  assert.deepEqual(launches.map(i => i.label), [
    'Find issues to launch for agent:frontend-engineer',
    'Find issues to launch for agent:qa-engineer',
    'Find issues to launch for agent:frontend-engineer',
  ])
  assert.ok(launches.every(i => i.group === 'Actions' && i.movesFocus && i.sensitive))
  assert.equal(launches[0].detail, 'opens the card of fe-1, session web')
  assert.equal(launches[2].detail, 'opens the card of fe-3, session api')
  launches[0].run()
  assert.deepEqual(calls, ['agent:k1'])
  assert.equal(new Set(items.map(i => i.id)).size, items.length)
  assert.equal(searchPalette(items, 'launch qa')[0]?.items[0]?.label, 'Find issues to launch for agent:qa-engineer')
})
