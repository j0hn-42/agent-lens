// #502: the Sessions panel columns, agent rows and stop-reporting announcement in French. Only the language changes:
// every figure and every qualifier ("at least", "estimated", "not reported", "incomplete") is kept, and the English
// output (the default) is the wording the other tests and the docs rely on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityCell, agentTimeCell, branchCell, columnLabel, costCell, modelCell, rollupTokensCell, runtimeCell, sessionTimeCell, tokensCell } from '../web/lib/session-columns'
import { agentRowView } from '../web/lib/row-sync'
import { buildFreshnessAnnouncement, type Freshness } from '../web/hooks/simulation/freshness'
import type { RollupTotal } from '../web/lib/cost-rollup'

const total = (over: Partial<RollupTotal> = {}): RollupTotal => ({ tokens: 12_400, cost: 0.5, known: 2, unknown: 0, estimated: false, complete: true, ...over }) as RollupTotal

test('French cells keep the figures and the qualifiers of the English ones', () => {
  const partial = { value: 9_000, status: 'partial' as const, estimated: true }
  assert.equal(tokensCell(partial, 'fr').label, 'au moins 9k estimé jetons')
  assert.equal(tokensCell(partial, 'fr').text, tokensCell(partial).text)
  assert.equal(tokensCell({ value: null, status: 'unavailable', estimated: false }, 'fr').label, 'jetons non communiqués')
  assert.equal(rollupTokensCell(total({ estimated: true, complete: false }), 'fr').label, '12k jetons estimés incomplets')
  assert.equal(rollupTokensCell(total({ estimated: true, complete: false })).label, '12k tokens estimated incomplete')
  assert.equal(costCell(total({ estimated: true, complete: false }), 'fr').label, 'estimation du coût du contexte $0.500, à partir de jetons estimés, incomplète')
  assert.equal(costCell(total({ estimated: true, complete: false }), 'fr').text, costCell(total({ estimated: true, complete: false })).text)
  assert.equal(costCell(null, 'fr').label, 'coût inconnu')
  assert.equal(modelCell(undefined, 'fr').label, 'modèle non communiqué')
  assert.equal(branchCell(undefined, 'fr').label, 'branche non enregistrée')
  assert.equal(runtimeCell(undefined, 'fr').label, 'runtime non communiqué')
  assert.equal(columnLabel('time', 'fr'), 'Temps')
  assert.equal(columnLabel('time'), 'Time')
})

test('French durations say lower bound and unknown end as the English ones do', () => {
  const T0 = 1_000_000
  const watched = { startTime: T0, startTimeWatched: true, lastActivityTime: T0 + 192_000, status: 'completed' as const }
  assert.equal(sessionTimeCell(watched, T0 + 1, false, 'fr').label, 'au moins 3m 12s de durée, début de la session non enregistré')
  assert.equal(sessionTimeCell(watched, T0 + 1, false, 'fr').text, '≥3m 12s')
  assert.equal(sessionTimeCell({ ...watched, lastActivityUnknown: true }, T0, false, 'fr').label, 'durée inconnue')
  assert.equal(agentTimeCell({}, 'never-observed', 0, 'fr').label, 'temps d’activité inconnu')
  assert.equal(agentTimeCell({ activeMs: 95_000 }, 'closed', 0, 'fr').label, '1m 35s d’activité')
})

test('the activity cell marks its English relative time instead of translating it (#501 owns it)', () => {
  const fr = activityCell({ lastActivityTime: 0 }, 120_000, 'fr')
  assert.equal(fr.english, '2 min ago')
  assert.equal(fr.label, 'dernière activité 2 min ago')
  assert.equal(activityCell({ lastActivityTime: 0 }, 120_000).english, undefined)
  assert.equal(activityCell({ lastActivityTime: 0, lastActivityUnknown: true }, 0, 'fr').label, 'activité inconnue')
})

test('an agent row in French quotes the word the canvas draws, then glosses it', () => {
  const base = { id: 'a', sessionId: 's', parentKey: null, name: 'x', tokensUsed: 0, spawnTime: 0, lastEventAt: 1000 }
  const live = agentRowView({ ...base, state: 'thinking' }, 1500, 'fr')
  assert.deepEqual([live.detail, live.drawn, live.role], ['Réflexion', 'thinking', 'agent'])
  const stale = agentRowView({ ...base, state: 'waiting_permission', kind: 'subagent' }, 1000 + 10 * 60_000, 'fr')
  assert.deepEqual([stale.detail, stale.drawn, stale.role], ['en attente d’autorisation depuis 10 min', 'waiting', 'sous-agent'])
  // a tool is data: no state word is quoted
  assert.equal(agentRowView({ ...base, state: 'tool_calling', currentTool: 'Read' }, 1500, 'fr').drawn, undefined)
  // English is untouched
  assert.deepEqual(agentRowView({ ...base, state: 'thinking' }, 1500), { detail: 'Thinking', stale: false, role: 'agent' })
})

test('the stop-reporting announcement in French keeps its groups, order and conditions', () => {
  const prev = new Map<string, Freshness>([['a', 'fresh'], ['b', 'fresh'], ['c', 'fresh'], ['d', 'fresh'], ['e', 'fresh']])
  const next = new Map<string, Freshness>([['a', 'stale'], ['b', 'stale'], ['c', 'stale'], ['d', 'stale'], ['e', 'closed']])
  const names = new Map([['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D'], ['e', 'E']])
  assert.equal(
    buildFreshnessAnnouncement(prev, next, names, new Set(['d']), 'fr'),
    'A, B, C n’émettent plus, dernier état connu affiché. D montre un état lu dans l’historique. E fermé.',
  )
  assert.equal(buildFreshnessAnnouncement(prev, prev, names, new Set(), 'fr'), null)
  const many = new Map<string, Freshness>([['a', 'stale'], ['b', 'stale'], ['c', 'stale'], ['d', 'stale'], ['e', 'stale']])
  assert.equal(buildFreshnessAnnouncement(prev, many, names, new Set(), 'fr')?.startsWith('A, B, C et 2 de plus n’émettent plus'), true)
  // English, unchanged
  assert.equal(buildFreshnessAnnouncement(prev, many, names), 'A, B, C and 2 more are no longer reporting, showing the last known state.')
})
