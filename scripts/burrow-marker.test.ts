// Burrow view: the ring on the floor under an animal tells its session or team apart, in the colour the graph already
// gives that cluster's halo (one colour per cluster, by the graph's own rule), and only when there is something to tell apart.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { colourOf, markerContext, teamOf, type MarkerAgent } from '../web/lib/burrow/burrow-marker'
import { clusterColor } from '../web/components/agent-visualizer/canvas/cluster-model'
import { TEAM_DEFAULT_COLOR } from '../web/components/agent-visualizer/canvas/team-style'
import type { TeamSummary } from '../web/lib/agent-types'
/** Palette colour of a session, as the graph gives its halo */
const sessionColor = (id: string): string => clusterColor(`session:${id}`, [{ sessionId: id }])

const agent = (id: string, over: Partial<MarkerAgent> = {}): MarkerAgent => ({ id, sessionId: 's1', ...over })

test('one session and no team: no ring, there is nothing to tell apart', () => {
  const list = [agent('a'), agent('b')]
  const ctx = markerContext(list)
  assert.equal(ctx.show, false)
  assert.equal(colourOf(list[0], ctx), null)
  assert.equal(colourOf(list[1], ctx), null)
})

test('two sessions: each animal takes the colour the graph gives its session halo', () => {
  const list = [agent('a'), agent('b', { sessionId: 's2' })]
  const ctx = markerContext(list)
  assert.equal(ctx.show, true)
  assert.equal(colourOf(list[0], ctx), sessionColor('s1'))
  assert.equal(colourOf(list[1], ctx), sessionColor('s2'))
  assert.equal(teamOf(list[0], ctx), undefined)
})

test('a second session that is not shown (filtered) tells nothing apart', () => {
  const list = [agent('a'), agent('b', { sessionId: 's2' })]
  assert.equal(markerContext([list[0]]).show, false)
})

test('two teammates with their own palette colours stand on one ring: the halo colour, its first member\'s', () => {
  const list = [
    agent('m1', { sessionId: 's2', teamName: 'alpha', teamColor: '#12ab34' }),
    agent('m2', { sessionId: 's3', teamName: 'alpha', teamColor: '#ff0000' }),
  ]
  const teams = new Map<string, TeamSummary>([['alpha', { name: 'alpha', leadSessionId: 's1', members: [{ name: 'm1', sessionId: 's2' }, { name: 'm2', sessionId: 's3' }] } as unknown as TeamSummary]])
  const ctx = markerContext(list, teams)
  assert.equal(colourOf(list[0], ctx), '#12ab34')
  assert.equal(colourOf(list[1], ctx), '#12ab34')
})

test('the lead, with no team name, sits in the team its session hosts, as in the graph: team ring and team row', () => {
  const list = [agent('lead'), agent('m', { teamName: 'alpha', teamColor: '#12ab34', teamKind: 'workflow' })]
  const ctx = markerContext(list)
  assert.equal(ctx.show, true)
  assert.equal(colourOf(list[0], ctx), '#12ab34')
  assert.deepEqual(teamOf(list[0], ctx), { name: 'alpha', kind: 'workflow' })
  assert.deepEqual(teamOf(list[1], ctx), { name: 'alpha', kind: 'workflow' })
})

test('an agent of another session than the team\'s keeps its session ring, as its halo does', () => {
  const list = [agent('m', { teamName: 'alpha', teamColor: '#12ab34' }), agent('x', { sessionId: 's2' })]
  const ctx = markerContext(list)
  assert.equal(colourOf(list[1], ctx), sessionColor('s2'))
  assert.equal(teamOf(list[1], ctx), undefined)
  assert.equal(teamOf(agent('unknown'), ctx), undefined)
})

test('a colour that is not #rrggbb is never drawn: the halo\'s fallbacks are used (another member, the team summary, the default)', () => {
  const bad = agent('m', { teamName: 'alpha', teamColor: 'red; background:url(x)' })
  const mate = agent('n', { teamName: 'alpha', teamColor: '#00ff00' })
  assert.equal(colourOf(bad, markerContext([bad, mate])), '#00ff00')
  const teams = new Map<string, TeamSummary>([['alpha', { name: 'alpha', leadSessionId: 's1', members: [{ name: 'n', color: '#abcdef' }] } as unknown as TeamSummary]])
  assert.equal(colourOf(bad, markerContext([bad], teams)), '#abcdef')
  assert.equal(colourOf(bad, markerContext([bad])), TEAM_DEFAULT_COLOR)
})

test('two teams of the same name in two sessions keep their own colours', () => {
  const a = agent('a', { teamName: 'x', teamColor: '#111111' })
  const b = agent('b', { teamName: 'x', sessionId: 's2' })
  const c = agent('c', { teamName: 'x', sessionId: 's2', teamColor: '#222222' })
  const ctx = markerContext([a, b, c])
  assert.equal(colourOf(a, ctx), '#111111')
  assert.equal(colourOf(b, ctx), '#222222')
})
