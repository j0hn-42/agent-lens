// Burrow view: the ring on the floor under an animal tells its session or team apart, in the colour the graph already
// gives that cluster's halo (team colour, else the session colour), and only when there is something to tell apart.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { colourOf, markerContext, teamOf, type MarkerAgent } from '../web/lib/burrow/burrow-marker'
import { sessionColor } from '../web/components/agent-visualizer/canvas/cluster-model'
import { TEAM_DEFAULT_COLOR } from '../web/components/agent-visualizer/canvas/team-style'
import type { TeamSummary } from '../web/lib/agent-types'

const agent = (id: string, over: Partial<MarkerAgent> = {}): MarkerAgent => ({ id, sessionId: 's1', parentId: null, ...over })
const mapOf = (list: MarkerAgent[]) => new Map(list.map((a) => [a.id, a]))

test('one session and no team: no ring, there is nothing to tell apart', () => {
  const list = [agent('a'), agent('b', { parentId: 'a' })]
  const agents = mapOf(list)
  const ctx = markerContext(list, agents)
  assert.equal(ctx.show, false)
  assert.equal(colourOf(list[0], agents, ctx), null)
  assert.equal(colourOf(list[1], agents, ctx), null)
})

test('two sessions: each animal takes the colour the graph gives its session halo', () => {
  const list = [agent('a'), agent('b', { sessionId: 's2' })]
  const agents = mapOf(list)
  const ctx = markerContext(list, agents)
  assert.equal(ctx.show, true)
  assert.equal(colourOf(list[0], agents, ctx), sessionColor('s1'))
  assert.equal(colourOf(list[1], agents, ctx), sessionColor('s2'))
})

test('a second session that is not shown (filtered) tells nothing apart', () => {
  const list = [agent('a'), agent('b', { sessionId: 's2' })]
  assert.equal(markerContext([list[0]], mapOf(list)).show, false)
})

test('a team member takes its validated team colour, even in a single session', () => {
  const list = [agent('lead'), agent('m', { teamName: 'alpha', teamColor: '#12ab34' })]
  const agents = mapOf(list)
  const ctx = markerContext(list, agents)
  assert.equal(ctx.show, true)
  assert.equal(colourOf(list[1], agents, ctx), '#12ab34')
  assert.equal(colourOf(list[0], agents, ctx), sessionColor('s1'))
})

test('a sub-agent without a team of its own takes its parent\'s, up the tree', () => {
  const list = [
    agent('m', { teamName: 'alpha', teamColor: '#12ab34', teamKind: 'workflow' }),
    agent('c', { parentId: 'm' }),
    agent('g', { parentId: 'c' }),
  ]
  const agents = mapOf(list)
  const ctx = markerContext(list, agents)
  assert.equal(colourOf(list[2], agents, ctx), '#12ab34')
  assert.deepEqual(teamOf(list[2], agents), { name: 'alpha', kind: 'workflow' })
  assert.equal(teamOf(agent('x'), agents), undefined)
})

test('a colour that is not #rrggbb is never drawn: the halo\'s fallbacks are used (another member, the team summary, the default)', () => {
  const bad = agent('m', { teamName: 'alpha', teamColor: 'red; background:url(x)' })
  const mate = agent('n', { teamName: 'alpha', teamColor: '#00ff00' })
  assert.equal(colourOf(bad, mapOf([bad, mate]), markerContext([bad, mate], mapOf([bad, mate]))), '#00ff00')
  const teams = new Map<string, TeamSummary>([['alpha', { name: 'alpha', leadSessionId: 's1', members: [{ name: 'n', color: '#abcdef' }] } as unknown as TeamSummary]])
  assert.equal(colourOf(bad, mapOf([bad]), markerContext([bad], mapOf([bad]), teams)), '#abcdef')
  assert.equal(colourOf(bad, mapOf([bad]), markerContext([bad], mapOf([bad]))), TEAM_DEFAULT_COLOR)
})

test('two teams of the same name in two clusters keep their own colours', () => {
  const a = agent('a', { teamName: 'x', clusterKey: 'team:s1:x', teamColor: '#111111' })
  const b = agent('b', { teamName: 'x', clusterKey: 'team:s2:x', sessionId: 's2' })
  const c = agent('c', { teamName: 'x', clusterKey: 'team:s2:x', sessionId: 's2', teamColor: '#222222' })
  const agents = mapOf([a, b, c])
  assert.equal(colourOf(b, agents, markerContext([a, b, c], agents)), '#222222')
})

test('a parent cycle does not hang', () => {
  const list = [agent('a', { parentId: 'b' }), agent('b', { parentId: 'a', sessionId: 's2' })]
  const agents = mapOf(list)
  assert.equal(teamOf(list[0], agents), undefined)
  assert.equal(colourOf(list[0], agents, markerContext(list, agents)), sessionColor('s1'))
})
