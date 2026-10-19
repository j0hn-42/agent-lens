import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  PALETTE_GROUPS, buildPaletteItems, searchPalette, paletteStatus, sessionDetail, agentDetail,
  type PaletteSource, type PaletteItem,
} from '../web/lib/command-palette'
import { ALL_SESSIONS_ID, type SessionInfo } from '../web/lib/bridge-types'
import { MESSAGES } from '../web/lib/messages'

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
    'Toggle Sessions and agents list', 'Toggle Files & repeats panel', 'Toggle Conversation panel', 'Toggle Timeline panel',
    'Toggle Context panel', 'Toggle System panel', 'Toggle Stats panel', 'Toggle Cost overlay',
  ])
})

test('items run the handler they stand for', () => {
  calls.length = 0
  const items = buildPaletteItems(source({ sessions: [session('s1')], agents: [{ id: 'k1', name: 'main', sessionId: 's1' }] }))
  byLabel(items, 'Toggle Files & repeats panel').run()
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
  assert.equal(byLabel(on, 'Toggle Files & repeats panel').shortcut, 'F')
  assert.equal(byLabel(off, 'Toggle Files & repeats panel').shortcut, undefined)
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
  assert.equal(byLabel(items, 'Toggle Files & repeats panel').movesFocus, true)
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
  assert.deepEqual(flat('PANEL files'), ['Toggle Files & repeats panel'])
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
    assert.equal(searchPalette(items, q).find(s => s.group === 'Panels')?.items[0]?.label, 'Toggle Files & repeats panel', q)
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

// ---- French palette (#503): the language of the text changes, nothing else ----

const FR_PANELS = ['Fichiers et répétitions', 'Conversation', 'Contexte', 'Système', 'Coût', 'Chronologie', 'Statistiques']

test('French: the panels are named in French, the Sessions list keeps its catalog name', () => {
  const items = buildPaletteItems(source({ locale: 'fr' }))
  const panels = items.filter(i => i.group === 'Panels').map(i => i.label)
  assert.deepEqual(panels, [
    'Basculer la liste Sessions et agents', 'Basculer le panneau Fichiers et répétitions', 'Basculer le panneau Conversation', 'Basculer le panneau Chronologie',
    'Basculer le panneau Contexte', 'Basculer le panneau Système', 'Basculer le panneau Statistiques', 'Basculer la superposition Coût',
  ])
  for (const name of FR_PANELS) assert.ok(panels.some(p => p.endsWith(name)), name)
})

test('the English palette is unchanged when no locale is given or en is asked', () => {
  const extras = { notifications: { on: true, run: () => {} }, themes: { current: 'neon', options: [{ id: 'neon', label: 'Neon' }], set: () => {} } }
  const a = buildPaletteItems(source(extras))
  const b = buildPaletteItems(source({ locale: 'en', ...extras }))
  const shape = (xs: PaletteItem[]) => xs.map(i => ({ ...i, run: undefined }))
  assert.deepEqual(shape(b), shape(a))
  assert.ok(a.some(i => i.label === 'Turn notifications off'))
  assert.ok(a.some(i => i.label === 'Theme: Neon' && i.detail === 'current theme'))
})

test('French: a command is found by its French name and by its English name', () => {
  const items = buildPaletteItems(source({ locale: 'fr', actions: { ...source().actions, togglePresentation: () => {}, clearHistory: () => {} } }))
  const found = (q: string) => searchPalette(items, q).flatMap(s => s.items).map(i => i.id)
  const cases: Array<[string, string, string]> = [
    ['action:play', 'lecture', 'play'], ['action:fit', 'ajuster le zoom', 'zoom to fit'], ['action:fullscreen', 'plein écran', 'full screen'],
    ['action:presentation', 'mode présentation', 'presentation mode'], ['action:grid', 'grille hexagonale', 'hex grid'],
    ['action:mute', 'couper', 'mute'], ['action:clear-history', 'effacer l’historique', 'clear history'],
    ['action:shortcuts', 'raccourcis clavier', 'keyboard shortcuts'], ['action:settings', 'ouvrir les réglages', 'open settings'],
    ['panel:files', 'panneau fichiers', 'files panel'], ['panel:timeline', 'chronologie', 'timeline'], ['panel:stats', 'statistiques', 'stats panel'],
    ['panel:cost', 'coût', 'cost overlay'], ['panel:system', 'système', 'system panel'], ['panel:context', 'contexte', 'context panel'],
    [`session:${ALL_SESSIONS_ID}`, 'toutes les sessions', 'all sessions'],
  ]
  for (const [id, fr, en] of cases) {
    assert.ok(found(fr).includes(id), `"${fr}" finds ${id}`)
    assert.ok(found(en).includes(id), `"${en}" finds ${id}`)
  }
  // Accents are optional when typing
  assert.ok(found('systeme').includes('panel:system'))
  assert.ok(found('evenements').includes('panel:timeline'))
})

test('French: the tour label is the catalog one, in the language of the palette, so no command declares a language of its own (#557)', () => {
  const tour = { label: MESSAGES.fr['tour.button.session'], run: () => {} }
  const items = buildPaletteItems(source({ locale: 'fr', tour }))
  assert.equal(items.find(i => i.id === 'action:tour')?.label, 'Visiter cette session')
  assert.ok(items.every(i => !('lang' in i)))
  assert.ok(buildPaletteItems(source({ tour: { label: MESSAGES.en['tour.button.session'], run: () => {} } })).every(i => !('lang' in i)))
})

test('French: details keep every fact, in French', () => {
  assert.equal(sessionDetail(session('s1', { status: 'completed', projectName: 'alpha', branch: 'main' }), 'fr'), 'alpha, main, terminée')
  assert.equal(sessionDetail(session('s1', { imported: true }), 'fr'), 'importée - pas en direct')
  assert.equal(sessionDetail(session('s1', { indexedOnly: true }), 'fr'), 'indexée - non observée')
  assert.equal(agentDetail({ id: 'a', name: 'x', sessionId: 's', sessionLabel: 'payments', kind: 'subagent' }, 'fr'), 'Sous-agent, session payments')
  const items = buildPaletteItems(source({ locale: 'fr', selectedSessionId: ALL_SESSIONS_ID, themes: { current: 'neon', options: [{ id: 'neon', label: 'Neon' }, { id: 'ember', label: 'Ember' }], set: () => {} } }))
  assert.equal(items.find(i => i.id === `session:${ALL_SESSIONS_ID}`)?.detail, 'vue actuelle')
  assert.equal(items.find(i => i.id === 'theme:neon')?.detail, 'thème actuel')
  assert.equal(items.find(i => i.id === 'theme:ember')?.label, 'Thème : Ember')
})

test('French: the result count keeps the real numbers, 0 and 1 are singular', () => {
  const sec = (n: number, hidden = 0) => [{ group: 'Actions' as const, items: Array.from({ length: n }, () => ({}) as PaletteItem), hidden }]
  assert.equal(paletteStatus([], 'fr'), 'Aucune commande correspondante')
  assert.equal(paletteStatus(sec(1), 'fr'), '1 résultat')
  assert.equal(paletteStatus(sec(3), 'fr'), '3 résultats')
  assert.equal(paletteStatus(sec(8, 5), 'fr'), '8 résultats affichés, 5 de plus : continuez à taper pour affiner')
  assert.equal(paletteStatus(sec(8, 5)), '8 results shown, 5 more: keep typing to narrow')
})

// Direct access to each tab of Settings (#533): one command per tab, in the language of the interface, found by its English and
// French names. It opens the dialog on that tab; the dialog gives the focus to the tab, so the palette leaves focus alone.

const ALL_TABS = ['general', 'sessions', 'notifications', 'keyboard'] as const

test('one "Settings: <tab>" command per tab given, right after "Open settings", running the opener with its tab', () => {
  calls.length = 0
  const items = buildPaletteItems(source({
    settingsTabs: { tabs: ALL_TABS, open: tab => { calls.push(`settings:${tab}`) } },
  }))
  const actions = items.filter(i => i.group === 'Actions').map(i => i.label)
  const at = actions.indexOf('Open settings')
  assert.deepEqual(actions.slice(at, at + 5), [
    'Open settings',
    'Settings: General',
    'Settings: Sessions and presentation',
    'Settings: Notifications and announcements',
    'Settings: Keyboard and preferences',
  ])
  byLabel(items, 'Settings: Notifications and announcements').run()
  assert.deepEqual(calls, ['settings:notifications'])
  const tabItems = items.filter(i => i.id.startsWith('action:settings-tab:'))
  assert.ok(tabItems.every(i => !i.movesFocus && !i.sensitive && !('lang' in i)), 'same language as the palette, no lang of its own')
  assert.equal(new Set(items.map(i => i.id)).size, items.length)
})

test('a tab left out of the dialog has no command, and without the opener there is none', () => {
  assert.equal(buildPaletteItems(source()).filter(i => i.id.startsWith('action:settings-tab:')).length, 0)
  const items = buildPaletteItems(source({ settingsTabs: { tabs: ['general', 'keyboard'], open: () => {} } }))
  assert.deepEqual(items.filter(i => i.id.startsWith('action:settings-tab:')).map(i => i.id), ['action:settings-tab:general', 'action:settings-tab:keyboard'])
})

test('in French the commands are named as the dialog is (« Réglages : … »), in the language of the palette', () => {
  const items = buildPaletteItems(source({ locale: 'fr', settingsTabs: { tabs: ALL_TABS, open: () => {} } }))
  const tabItems = items.filter(i => i.id.startsWith('action:settings-tab:'))
  assert.deepEqual(tabItems.map(i => i.label), [
    'Réglages : Général', 'Réglages : Sessions et présentation', 'Réglages : Notifications et annonces', 'Réglages : Clavier et préférences',
  ])
  assert.ok(tabItems.every(i => !('lang' in i)))
})

test('a tab command is found by its English and its French name, whatever the language, accents optional', () => {
  for (const locale of ['en', 'fr'] as const) {
    const items = buildPaletteItems(source({ locale, settingsTabs: { tabs: ALL_TABS, open: () => {} } }))
    const first = (q: string) => searchPalette(items, q).find(s => s.group === 'Actions')?.items.filter(i => i.id.startsWith('action:settings-tab:'))[0]?.id
    assert.equal(first('keyboard and preferences'), 'action:settings-tab:keyboard', `${locale}: English name`)
    assert.equal(first('clavier et préférences'), 'action:settings-tab:keyboard', `${locale}: French name`)
    assert.equal(first('clavier et preferences'), 'action:settings-tab:keyboard', `${locale}: French name without accents`)
    assert.equal(first('annonces'), 'action:settings-tab:notifications', `${locale}: a French section title`)
    assert.equal(first('screen reader announcements'), 'action:settings-tab:notifications', `${locale}: an English section title`)
    assert.equal(first('paramètres général'), 'action:settings-tab:general', `${locale}: « Paramètres » finds the commands too`)
    assert.equal(first('settings sound'), 'action:settings-tab:general', `${locale}: the Sound section is in General`)
  }
})
