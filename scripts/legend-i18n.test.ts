// #503: the legend and the palette say in French what they say in English, nothing more. The English catalog values stay
// the very words of the constants they replaced; the French ones keep every figure and every qualifier.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MESSAGES, type MessageKey } from '../web/lib/messages'
import { STATE_LABEL_SHORT, STATE_LABEL_LONG } from '../web/lib/canvas-constants'
import { REPEAT_RULE_TEXT } from '../web/lib/repeat-marks'
import { PANEL_NAMES, SESSIONS_LIST_NAME, HIERARCHY_TERMS } from '../web/lib/ui-glossary'
import { SESSION_IMPORTED_TEXT, SESSION_INDEXED_TEXT } from '../web/lib/session-model'
import { LEGEND_ENTRY_IDS } from '../web/lib/legend-entries'

const en = (k: string) => MESSAGES.en[k as MessageKey]
const fr = (k: string) => MESSAGES.fr[k as MessageKey]

test('English legend: the state words are the ones the canvas constants hold', () => {
  for (const state of Object.keys(STATE_LABEL_SHORT)) {
    assert.equal(en(`legend.state.${state}.short`), STATE_LABEL_SHORT[state], state)
    assert.equal(en(`legend.state.${state}.long`), STATE_LABEL_LONG[state], state)
  }
})

test('English legend and palette keep the wording of the glossary constants', () => {
  assert.equal(en('legend.repeatRule'), REPEAT_RULE_TEXT)
  for (const [id, name] of Object.entries(PANEL_NAMES)) if (id !== 'conversation') assert.equal(en(`palette.panelName.${id}`), name, id)
  assert.equal(PANEL_NAMES.conversation, 'Conversation')
  assert.equal(en('sessions.title'), SESSIONS_LIST_NAME)
  assert.equal(en('palette.kind.main'), HIERARCHY_TERMS.main)
  assert.equal(en('palette.kind.subagent'), HIERARCHY_TERMS.subagent)
  assert.equal(en('palette.kind.teammate'), HIERARCHY_TERMS.teammate)
  assert.equal(en('sessions.status.imported'), SESSION_IMPORTED_TEXT)
  assert.equal(en('sessions.status.indexed'), SESSION_INDEXED_TEXT)
})

test('French panel names are the ones the owner validated', () => {
  assert.deepEqual(
    ['files', 'context', 'system', 'cost', 'timeline', 'stats'].map(id => fr(`palette.panelName.${id}`)),
    ['Fichiers', 'Contexte', 'Système', 'Coût', 'Chronologie', 'Statistiques'],
  )
})

test('every legend entry has a text in both languages', () => {
  for (const id of LEGEND_ENTRY_IDS) {
    if (id.startsWith('state-') || id === 'team-row') continue
    assert.ok(`legend.${id}` in MESSAGES.fr && `legend.${id}` in MESSAGES.en, id)
  }
})

test('French keeps the qualifiers and the figures', () => {
  assert.equal(fr('legend.footer'), 'Non observé, au moins, estimé :')
  assert.match(fr('legend.complete'), /\{n\}/)
  assert.match(fr('legend.mark-loop'), /\{repeat\}.*\{cycle\}/)
  assert.match(fr('legend.edge-file-conflict'), /observée comme réussie/)
  assert.match(fr('legend.edge-parent'), /confirmé par les événements/)
  assert.match(fr('legend.edge-unverified'), /non vérifié/)
  assert.match(fr('palette.shown.other'), /\{n\}.*\{hidden\}/)
})
