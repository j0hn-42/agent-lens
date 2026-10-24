// #518 (option B): the Files panel is named "Files & repeats" / "Fichiers et répétitions" everywhere it is named (one name per
// language, WCAG 3.2.4), and the folded "Repeated reads and calls" section keeps a count in its summary that comes from the same
// data as the list, with the same qualifiers under loss ("at least", "incomplete", calls not compared), never a bare 0.
import './all-locales' // #662: both languages are loaded before the tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MESSAGES, LOCALES, type Locale } from '../web/lib/messages'
import { PANEL_NAMES, hiddenPanelsText } from '../web/lib/ui-glossary'
import { panelName } from '../web/lib/command-palette'
import { shortcutDescription } from '../web/lib/shortcuts-text'
import { SHORTCUTS } from '../web/lib/shortcuts'
import { repeatsDisclosure, wasteSummary, emptyWasteLedger, recordToolStart, type WasteLedger } from '../web/lib/waste'
import { wasteDisclosureText } from '../web/lib/panel-text'
import { repeatMarkText } from '../web/lib/repeat-marks'

const NAME: Record<Locale, string> = { fr: 'Fichiers et répétitions', en: 'Files & repeats' }

test('one name per language for the panel: button, tooltip, palette, shortcut, heading, region, legend, tour, reset help', () => {
  assert.equal(PANEL_NAMES.files, NAME.en)
  for (const l of LOCALES) {
    const m = MESSAGES[l]
    const name = NAME[l]
    assert.equal(panelName(l, 'files'), name, `${l} palette`)
    assert.equal(m['topbar.panel.files.name'], name, `${l} top bar button`)
    assert.equal(m['topbar.panel.files.tooltip'], `${name} (F)`, `${l} tooltip`)
    assert.equal(m['panel.heading.files'], name.toLocaleUpperCase(l), `${l} heading`)
    assert.ok(m['files.region'].startsWith(name), `${l} region "${m['files.region']}" starts with the name`)
    assert.ok(shortcutDescription(SHORTCUTS.find(s => s.key === 'f')!, l).includes(name), `${l} shortcut F`)
    for (const key of ['legend.mark-repeated', 'legend.edge-file-conflict', 'tour.live.mark-repeated', 'tour.live.edge-file-conflict', 'settings.reset.help'] as const) {
      assert.ok(m[key].includes(name), `${l} ${key} names the panel "${name}"`)
    }
    // The old names are gone from what is shown
    for (const key of Object.keys(m) as (keyof typeof m)[]) {
      assert.doesNotMatch(m[key], /FILE ATTENTION|ATTENTION AUX FICHIERS|Files accessed by agents|Fichiers consultés par les agents|panneau Fichiers\b(?! et)|the Files panel/, `${l} ${key}`)
    }
  }
  assert.match(hiddenPanelsText(['files', 'timeline']), /Files & repeats, Timeline/)
})

test('the canvas mark sends the reader to the panel by its new name', () => {
  let l: WasteLedger = emptyWasteLedger()
  let n = 0
  for (const file of ['/a.ts', '/b.ts']) for (let i = 0; i < 2; i++) {
    const id = `t${++n}`
    l = recordToolStart(l, { sessionId: 's', agentId: 's:a', toolName: 'Read', inputData: { file_path: file }, toolUseId: id, toolCallId: id, time: n })
  }
  const items = wasteSummary(l).items
  assert.match(repeatMarkText({ kind: 'repeated', items }).detail, /and 1 more in the Files & repeats panel\./)
})

function ledger(repeated: number, extra: Partial<WasteLedger> = {}): WasteLedger {
  let l: WasteLedger = emptyWasteLedger()
  let n = 0
  for (let r = 0; r < repeated; r++) for (let i = 0; i < 2; i++) {
    const id = `t${++n}`
    l = recordToolStart(l, { sessionId: 's', agentId: 's:a', toolName: 'Read', inputData: { file_path: `/f${r}.ts` }, toolUseId: id, toolCallId: id, time: n })
  }
  return { ...l, ...extra }
}

test('the summary counts the listed findings, from the same data as the list', () => {
  for (const r of [0, 1, 5, 25]) {
    const s = wasteSummary(ledger(r))
    assert.equal(repeatsDisclosure(s, 0).count, s.items.length, `${r}`)
    assert.equal(s.items.length, r)
  }
})

test('qualifiers: "at least" under a tracking limit or a replay loss, "incomplete" for an empty list, uncompared calls named', () => {
  assert.deepEqual(repeatsDisclosure(wasteSummary(ledger(3)), 0), { count: 3, lowerBound: false, uncompared: 0 })
  assert.deepEqual(repeatsDisclosure(wasteSummary(ledger(3, { limitReached: true })), 0), { count: 3, lowerBound: true, uncompared: 0 })
  assert.deepEqual(repeatsDisclosure(wasteSummary(ledger(3)), 4), { count: 3, lowerBound: true, uncompared: 0 })
  assert.deepEqual(repeatsDisclosure(wasteSummary(ledger(0)), 2), { count: 0, lowerBound: true, uncompared: 0 })
  assert.deepEqual(repeatsDisclosure(wasteSummary(ledger(0, { uncompared: 3 })), 0), { count: 0, lowerBound: false, uncompared: 3 })
})

test('the summary text, in both languages: "observed", never "wasted", never a bare 0', () => {
  const text = (l: Locale, r: number, lost: number, extra: Partial<WasteLedger> = {}) => wasteDisclosureText(l, repeatsDisclosure(wasteSummary(ledger(r, extra)), lost))
  assert.equal(text('en', 5, 0), 'Repeated reads and calls: 5 repeats observed')
  assert.equal(text('fr', 5, 0), 'Lectures et appels répétés : 5 répétitions observées')
  assert.equal(text('en', 1, 0), 'Repeated reads and calls: 1 repeat observed')
  assert.equal(text('fr', 1, 0), 'Lectures et appels répétés : 1 répétition observée')
  assert.equal(text('en', 5, 2), 'Repeated reads and calls: at least 5 repeats observed')
  assert.equal(text('fr', 5, 0, { limitReached: true }), 'Lectures et appels répétés : au moins 5 répétitions observées')
  assert.equal(text('en', 0, 0), 'Repeated reads and calls: no repeat observed')
  assert.equal(text('fr', 0, 0), 'Lectures et appels répétés : aucune répétition observée')
  assert.equal(text('en', 0, 3), 'Repeated reads and calls: no repeat observed (incomplete)')
  assert.equal(text('fr', 0, 3), 'Lectures et appels répétés : aucune répétition observée (incomplet)')
  assert.equal(text('en', 0, 0, { uncompared: 3 }), 'Repeated reads and calls: no repeat observed, 3 calls not compared')
  assert.equal(text('fr', 0, 0, { uncompared: 1 }), 'Lectures et appels répétés : aucune répétition observée, 1 appel non comparé')
  assert.equal(text('en', 2, 1, { uncompared: 1 }), 'Repeated reads and calls: at least 2 repeats observed, 1 call not compared')
  for (const l of LOCALES) for (const r of [0, 1, 5]) for (const lost of [0, 2]) {
    const s = text(l, r, lost, { uncompared: 2 })
    assert.doesNotMatch(s, /wasted|gaspill|: 0\b| 0 /, `${l} ${s}`)
  }
})
