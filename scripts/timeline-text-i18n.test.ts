// #373: the words of the Timeline panel in each language. The English output must stay the one of timeline-rows.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as T from '../web/lib/timeline-text'
import { TIMELINE_STATE_LABELS, timelineAriaLabel, swimlaneArrowLabel, arrowKindLabel, type TimelineStateKey } from '../web/lib/timeline-rows'
import { EXPIRED_LABEL_SUFFIX } from '../web/lib/ui-glossary'
import { MESSAGES, LOCALES, translate, type Locale } from '../web/lib/messages'
import type { TimelineEntry } from '../web/lib/agent-types'

const STATES = Object.keys(TIMELINE_STATE_LABELS) as TimelineStateKey[]
const entry = (id: string): TimelineEntry => ({ agentId: id, agentName: id, startTime: 0, blocks: [] })

test('English: states, arrow words and the accessible name are the original ones', () => {
  for (const s of STATES) assert.equal(T.stateLabelText('en', s), TIMELINE_STATE_LABELS[s])
  for (const [kind, err] of [['dispatch', false], ['return', false], ['return', true], ['message', false]] as const) {
    assert.equal(T.arrowKindText('en', kind, err), arrowKindLabel(kind, err))
    assert.equal(T.arrowLabelText('en', kind, err, 'a', 'b'), swimlaneArrowLabel(kind, err, 'a', 'b'))
  }
  assert.equal(T.timelineLabelText('en', [], 5), timelineAriaLabel([], 5))
  assert.equal(T.timelineLabelText('en', [entry('a')], 65), timelineAriaLabel([entry('a')], 65))
  assert.equal(T.timelineLabelText('en', [entry('a'), entry('b')], 65), timelineAriaLabel([entry('a'), entry('b')], 65))
})

test('French: states, arrows and the accessible name, with 0 and 1 singular', () => {
  assert.equal(T.stateLabelText('fr', 'tool_call'), 'Appel d’outil')
  assert.equal(T.arrowKindText('fr', 'return', true), 'Retour (erreur)')
  assert.equal(T.arrowLabelText('fr', 'dispatch', false, 'a', 'b'), 'a -> b - ENVOI')
  assert.equal(T.arrowLabelText('fr', 'return', true, 'a', 'b'), 'a -> b - RETOUR (ERREUR)')
  assert.equal(T.timelineLabelText('fr', [], 0), 'Chronologie : aucune donnée')
  assert.equal(T.timelineLabelText('fr', [entry('a')], 65), 'Chronologie de 1 agent, de 0:00 à 1:05')
  assert.equal(T.timelineLabelText('fr', [entry('a'), entry('b')], 65), 'Chronologie de 2 agents, de 0:00 à 1:05')
})

test('earlier messages: plural by locale rule, number written for the locale', () => {
  assert.equal(T.earlierMessagesText('en', 1), '+1 earlier message, see Table view')
  assert.equal(T.earlierMessagesText('en', 12), '+12 earlier messages, see Table view')
  assert.equal(T.earlierMessagesText('fr', 1), '+1 message antérieur, voir la vue en tableau')
  assert.equal(T.earlierMessagesText('fr', 1200), `+${new Intl.NumberFormat('fr').format(1200)} messages antérieurs, voir la vue en tableau`)
})

test('block labels: the fixed words are translated, a tool call is data', () => {
  const join = (l: Locale, label: string) => T.blockLabelParts(l, label).map(p => p.text).join('')
  assert.equal(join('fr', 'Thinking...'), 'Réflexion…')
  assert.equal(join('en', 'Thinking...'), 'Thinking...')
  assert.equal(join('fr', 'Starting'), 'Démarrage')
  assert.equal(join('fr', 'Done'), 'Terminé')
  assert.equal(join('fr', 'Permission'), 'Autorisation')
  assert.equal(join('fr', 'Resumed'), 'Repris')
  // a tool label is data: it keeps its text and is flagged as such
  assert.deepEqual(T.blockLabelParts('fr', 'Read: foo.ts'), [{ text: 'Read: foo.ts', data: true }])
  assert.equal(join('fr', 'Bash: FAILED'), 'Bash: ÉCHEC')
  assert.deepEqual(T.blockLabelParts('fr', 'Bash: FAILED').map(p => p.data), [true, false])
  assert.equal(join('fr', 'Grep: CANCELLED'), 'Grep: ANNULÉ')
  assert.equal(join('fr', `Read: a.ts ${EXPIRED_LABEL_SUFFIX}`), 'Read: a.ts (expiré, fin non observée)')
  assert.equal(join('en', `Read: a.ts ${EXPIRED_LABEL_SUFFIX}`), `Read: a.ts ${EXPIRED_LABEL_SUFFIX}`)
  assert.equal(join('en', 'Bash: FAILED'), 'Bash: FAILED')
  assert.equal(join('fr', `Starting ${EXPIRED_LABEL_SUFFIX}`), 'Démarrage (expiré, fin non observée)')
})

test('state glyphs are one letter per state and distinct in each language', () => {
  for (const l of LOCALES) {
    const glyphs = STATES.map(s => T.stateGlyphText(l, s))
    assert.ok(glyphs.every(g => [...g].length === 1), `${l}: one character`)
    assert.equal(new Set(glyphs).size, STATES.length, `${l}: distinct`)
  }
})

test('every tl.* key exists in both languages with the same placeholders', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
  const keys = Object.keys(MESSAGES.en).filter(k => k.startsWith('tl.'))
  assert.ok(keys.length > 20)
  for (const k of keys) assert.equal(ph((MESSAGES.fr as Record<string, string>)[k]), ph((MESSAGES.en as Record<string, string>)[k]), k)
  assert.equal(translate('fr', 'tl.empty'), 'Aucune donnée de chronologie pour l’instant')
})
