// #557: the guided tour (demo steps, live steps, card, offer, button) and the titles of the panels exist in every
// locale, say the same thing (same ids, same numbers) and agree with the names of the palette and the top bar.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { GUIDED_STEPS, guidedSteps } from '../web/lib/guided-steps'
import { buildLiveTourSteps } from '../web/lib/live-tour'
import { LEGEND_ENTRY_IDS } from '../web/lib/legend-entries'
import { LOCALES, MESSAGES, translate, type Locale, type MessageKey } from '../web/lib/messages'
import { panelName } from '../web/lib/command-palette'
import { PANEL_NAMES } from '../web/lib/ui-glossary'
import { REPEAT_THRESHOLD, CYCLE_THRESHOLD } from '../web/lib/loop-detection'
import type { LegendPresence } from '../web/lib/legend-presence'

const digits = (s: string) => (s.match(/\d+/g) ?? []).join(',')
const all: LegendPresence = { entries: [...LEGEND_ENTRY_IDS], agentFor: { 'state-error': 'k' }, labels: { k: 'run the tests' } }

test('the demo tour has the same steps in every locale, with the same times, targets and numbers', () => {
  const en = guidedSteps('en')
  assert.deepEqual(en, GUIDED_STEPS)
  for (const locale of LOCALES) {
    const steps = guidedSteps(locale)
    assert.deepEqual(steps.map(s => [s.id, s.time, s.target, s.opensLegend, s.covers]), en.map(s => [s.id, s.time, s.target, s.opensLegend, s.covers]))
    steps.forEach((s, i) => {
      assert.ok(s.title.trim() && s.body.trim(), `${locale} ${s.id} has text`)
      assert.equal(digits(s.title + s.body), digits(en[i].title + en[i].body), `${locale} ${s.id}: no number changed`)
    })
  }
  guidedSteps('fr').forEach((s, i) => assert.notEqual(s.body, en[i].body, `${s.id} body is translated`))
})

test('the live tour has the same steps in every locale and names the thresholds it counts', () => {
  const en = buildLiveTourSteps(all, 'en')
  assert.deepEqual(en, buildLiveTourSteps(all))
  const fr = buildLiveTourSteps(all, 'fr')
  assert.deepEqual(fr.map(s => [s.id, s.covers, s.target]), en.map(s => [s.id, s.covers, s.target]))
  fr.forEach((s, i) => {
    if (s.id !== 'sessions') assert.notEqual(s.title, en[i].title, `${s.id} title is translated`)
    assert.notEqual(s.body, en[i].body, `${s.id} body is translated`)
    assert.equal(digits(s.body), digits(en[i].body), `${s.id}: no number changed`)
  })
  const loop = fr.find(s => s.covers.includes('mark-loop'))!
  assert.ok(loop.body.includes(`${REPEAT_THRESHOLD} fois`) && loop.body.includes(`${CYCLE_THRESHOLD} cycles`))
  assert.match(fr.find(s => s.covers.includes('state-error'))!.body, /« run the tests »/)
})

test('the card, the offer and the tour buttons are in the catalog of every locale', () => {
  const keys = Object.keys(MESSAGES.fr).filter(k => k.startsWith('tour.card.') || k.startsWith('tour.offer.') || k.startsWith('tour.button.')) as MessageKey[]
  assert.ok(keys.length >= 10, 'the keys exist')
  for (const l of LOCALES) assert.equal(translate(l, 'tour.card.step', { n: 2, total: 13 }).replace(/\D/g, ''), '213')
  assert.equal(MESSAGES.en['tour.button.session'], 'Tour this session')
  assert.equal(MESSAGES.en['tour.button.demo'], 'Guided tour')
})

const NAME_KEY = {
  files: 'topbar.panel.files.name', context: 'topbar.panel.context.name', system: 'topbar.panel.system.name', cost: 'topbar.panel.cost.name',
  timeline: 'topbar.panel.timeline.name', stats: 'topbar.panel.stats.name', conversation: 'topbar.panel.conversation.name',
} as const

test('a panel has one name in a language: the palette, the top bar button and the panel say the same word (WCAG 3.2.4)', () => {
  for (const l of LOCALES as readonly Locale[]) {
    for (const id of Object.keys(PANEL_NAMES) as (keyof typeof PANEL_NAMES)[]) {
      const buttonName = MESSAGES[l][NAME_KEY[id]].replace(/ \([A-Z]\)$/, '').replace(/^\$/, '')
      assert.equal(panelName(l, id), buttonName, `${l} ${id}`)
    }
  }
  assert.deepEqual((['files', 'conversation', 'context', 'system', 'cost', 'timeline', 'stats'] as const).map(id => panelName('fr', id)),
    ['Fichiers', 'Conversation', 'Contexte', 'Système', 'Coût', 'Chronologie', 'Statistiques'])
})

test('the headings of the panels are in the catalog, English unchanged', () => {
  assert.equal(MESSAGES.en['panel.heading.files'], 'FILE ATTENTION')
  assert.equal(MESSAGES.en['panel.heading.timeline'], 'EXECUTION TIMELINE')
  assert.equal(MESSAGES.en['panel.heading.context'], 'PROJECT CONTEXT')
  assert.equal(MESSAGES.fr['panel.heading.files'], 'ATTENTION AUX FICHIERS')
})
