// Burrow view: the agent list row is the text path of everything the scene draws (the bubbles and tags are aria-hidden).
// A proven loop and a replay loss of the agent's session are said there, with the graph's words, and only when proven.
import './all-locales'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { translate, type Locale } from '../web/lib/messages'
import { burrowRowLabel } from '../web/lib/burrow/burrow-row-label'
import type { BurrowRow } from '../web/lib/burrow/burrow-sync'

const row = (over: Partial<BurrowRow> = {}): BurrowRow =>
  ({ id: 'a', name: 'alpha', presence: 'in', room: 'lounge', state: 'idle', stale: false, parentId: null, sessionId: 's1', depth: 0, ...over })
const tr = (locale: Locale) => (key: Parameters<typeof translate>[1], params?: Readonly<Record<string, string | number>>) => translate(locale, key, params)

test('a row without a loop or a loss says neither (never a "no loop")', () => {
  const label = burrowRowLabel(row(), [row()], tr('en'))
  assert.equal(label, 'alpha: Idle, Lounge')
  assert.doesNotMatch(label, /loop|replayed/i)
})

test('a proven loop is said with the words of the graph and of the agent card', () => {
  assert.match(burrowRowLabel(row({ loop: true }), [], tr('en')), /^alpha: Idle, Lounge, loop observed$/)
  assert.match(burrowRowLabel(row({ loop: true }), [], tr('fr')), /boucle observée$/)
})

test('a replay loss of the session is a lower bound, singular and plural', () => {
  assert.match(burrowRowLabel(row({ replayLost: 1 }), [], tr('en')), /at least 1 earlier event of its session was not replayed$/)
  assert.match(burrowRowLabel(row({ replayLost: 12 }), [], tr('en')), /at least 12 earlier events of its session were not replayed$/)
  assert.match(burrowRowLabel(row({ replayLost: 12 }), [], tr('fr')), /au moins 12 événements antérieurs de sa session n’ont pas été rejoués$/)
})

test('the notes go with the existing ones: tool, open delegations, the orchestrator named last', () => {
  const parent = row({ id: 'p', name: 'boss' })
  const child = row({ id: 'c', name: 'kid', parentId: 'p', depth: 1, state: 'tool_calling', room: 'office', tool: 'Edit', loop: true, replayLost: 2 })
  const label = burrowRowLabel(child, [parent, child], tr('en'))
  assert.equal(label, 'kid: Calling tool, Office, tool Edit, loop observed, at least 2 earlier events of its session were not replayed, sub-agent of boss')
  assert.equal(burrowRowLabel(row({ presence: 'finished', delegating: 1 }), [], tr('en')), 'alpha: finished, 1 sub-agent running')
})

test('the team or workflow the ring stands for is named right after the state, in both languages', () => {
  assert.equal(burrowRowLabel(row({ team: { name: 'alpha-team', kind: 'team' }, loop: true }), [], tr('en')), 'alpha: Idle, Lounge, team alpha-team, loop observed')
  assert.equal(burrowRowLabel(row({ team: { name: 'wave', kind: 'workflow' } }), [], tr('en')), 'alpha: Idle, Lounge, workflow wave')
  assert.match(burrowRowLabel(row({ team: { name: 'alpha-team', kind: 'team' } }), [], tr('fr')), /, équipe alpha-team$/)
  assert.match(burrowRowLabel(row({ team: { name: 'wave', kind: 'workflow' } }), [], tr('fr')), /, workflow wave$/)
  assert.doesNotMatch(burrowRowLabel(row(), [], tr('en')), /team|workflow/)
})

test('a row says from one minute on how long its agent has waited for you, as a lower bound, before the other notes', () => {
  const waiting = row({ state: 'waiting_permission', room: 'door' })
  assert.equal(burrowRowLabel(waiting, [], tr('en')), 'alpha: Waiting for permission, Front door')
  assert.equal(burrowRowLabel({ ...waiting, waited: 1 }, [], tr('en')), 'alpha: Waiting for permission, Front door, has been waiting for you for at least 1 min')
  assert.equal(burrowRowLabel({ ...waiting, waited: 2 }, [], tr('fr')), 'alpha : En attente d’autorisation, Porte d’entrée, vous attend depuis au moins 2 min')
  const parent = row({ id: 'p', name: 'boss' })
  const child = row({ id: 'c', name: 'kid', parentId: 'p', depth: 1, state: 'tool_calling', room: 'door', tool: 'AskUserQuestion', waited: 3, loop: true, team: { name: 't', kind: 'team' } })
  assert.equal(burrowRowLabel(child, [parent, child], tr('en')),
    'kid: Calling tool, Front door, tool AskUserQuestion, has been waiting for you for at least 3 min, team t, loop observed, sub-agent of boss')
})

test('a row says for a moment that a tool call just failed, with its tool and the exit code only when they were received, before the other notes', () => {
  assert.equal(burrowRowLabel(row({ failed: { tool: 'Bash', exit: 2 } }), [], tr('en')), 'alpha: Idle, Lounge, a Bash call just failed with exit code 2')
  assert.equal(burrowRowLabel(row({ failed: { tool: 'Read' } }), [], tr('en')), 'alpha: Idle, Lounge, a Read call just failed')
  assert.equal(burrowRowLabel(row({ failed: {} }), [], tr('en')), 'alpha: Idle, Lounge, a tool call just failed')
  assert.equal(burrowRowLabel(row({ failed: { tool: 'Bash', exit: 2 } }), [], tr('fr')), 'alpha : Inactif, Salon, un appel Bash vient d’échouer avec le code de sortie 2')
  assert.equal(burrowRowLabel(row({ failed: { tool: 'Read' } }), [], tr('fr')), 'alpha : Inactif, Salon, un appel Read vient d’échouer')
  assert.equal(burrowRowLabel(row({ failed: {} }), [], tr('fr')), 'alpha : Inactif, Salon, un appel d’outil vient d’échouer')
  // after the wait, before the team, the loop and the parent
  const parent = row({ id: 'p', name: 'boss' })
  const child = row({ id: 'c', name: 'kid', parentId: 'p', depth: 1, state: 'tool_calling', room: 'door', tool: 'AskUserQuestion', waited: 1, failed: { tool: 'Bash', exit: 1 }, loop: true })
  assert.equal(burrowRowLabel(child, [parent, child], tr('en')),
    'kid: Calling tool, Front door, tool AskUserQuestion, has been waiting for you for at least 1 min, a Bash call just failed with exit code 1, loop observed, sub-agent of boss')
})

test('the room is where the animal stands (its recent calls), the tool the one running: a row never lets the room pass for the tool', () => {
  // the same room as the tool: as before
  assert.equal(burrowRowLabel(row({ state: 'tool_calling', room: 'library', tool: 'Read' }), [], tr('en')), 'alpha: Calling tool, Library, tool Read')
  // another room: said plainly
  assert.equal(burrowRowLabel(row({ state: 'tool_calling', room: 'library', tool: 'Edit' }), [], tr('en')),
    'alpha: Calling tool, tool Edit, stands in the Library, the room of most of its recent calls')
  assert.equal(burrowRowLabel(row({ state: 'tool_calling', room: 'library', tool: 'Edit' }), [], tr('fr')),
    'alpha : Appel d’outil, outil Edit, se tient dans la pièce Bibliothèque, celle de la plupart de ses appels récents')
})
