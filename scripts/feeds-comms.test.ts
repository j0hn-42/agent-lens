import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  commKindOf, directionText, safeHexColor, teamColorOf, buildFeedMessages, filterByTab, filterByPair,
  droppedMarkerFor, agentIdsWithMessages, groupByTeam, isAgentDone, hasMultipleSessions, agentNameOf,
  COMM_LABELS,
} from '../web/lib/feed-utils'
import {
  buildSwimlaneArrows, orderEntriesBySequence, orderEntriesByStart, firstInteractionTimes,
  buildMessageRows, hitTestArrow, swimlaneArrowLabel, type SwimlaneLink,
} from '../web/lib/timeline-rows'
import type { ConversationMessage } from '../web/hooks/simulation/types'

const msg = (o: Partial<ConversationMessage> & { id: string; type: ConversationMessage['type'] }): ConversationMessage =>
  ({ content: '', timestamp: 0, ...o })

test('commKindOf maps dispatch / return / error / teammate message', () => {
  assert.equal(commKindOf({ type: 'dispatch' }), 'dispatch')
  assert.equal(commKindOf({ type: 'return' }), 'return')
  assert.equal(commKindOf({ type: 'return', isError: true }), 'return_error')
  assert.equal(commKindOf({ type: 'message' }), 'message')
  assert.equal(commKindOf({ type: 'assistant' }), null)
  assert.equal(COMM_LABELS.return_error, 'RETURN (ERROR)')
})

test('directionText is directional', () => {
  assert.equal(directionText('orchestrator', 'explore'), 'orchestrator -> explore')
})

test('safeHexColor only accepts #rrggbb', () => {
  assert.equal(safeHexColor('#aabbcc'), '#aabbcc')
  assert.equal(safeHexColor('#ABCDEF'), '#ABCDEF')
  assert.equal(safeHexColor('red'), undefined)
  assert.equal(safeHexColor('#abc'), undefined)
  assert.equal(safeHexColor('#aabbcc; background:url(x)'), undefined)
  assert.equal(safeHexColor(42), undefined)
})

test('teamColorOf prefers the agent color, falls back to the team member, validates both', () => {
  const teams = new Map([['t', { members: [{ name: 'rev', color: '#112233' }, { name: 'bad', color: 'javascript:1' }] }]])
  assert.equal(teamColorOf({ name: 'rev', teamName: 't', teamColor: '#ff0000' }, teams), '#ff0000')
  assert.equal(teamColorOf({ name: 'rev', teamName: 't' }, teams), '#112233')
  assert.equal(teamColorOf({ name: 'bad', teamName: 't', teamColor: 'nope' }, teams), undefined)
  assert.equal(teamColorOf(undefined, teams), undefined)
})

const conversations = new Map<string, ConversationMessage[]>([
  ['s:orch', [
    msg({ id: 'm1', type: 'assistant', content: 'plan', timestamp: 1 }),
    msg({ id: 'm2', type: 'dispatch', content: 'full prompt', timestamp: 2, from: 's:orch', to: 's:explore', toolUseId: 'tu1' }),
    msg({ id: 'm3', type: 'tool_call', content: 'x', timestamp: 2.5 }),
  ]],
  ['s:explore', [
    msg({ id: 'm4', type: 'assistant', content: 'working', timestamp: 3 }),
    msg({ id: 'm5', type: 'return', content: 'report', timestamp: 4, from: 's:explore', to: 's:orch', toolUseId: 'tu1', isError: true }),
  ]],
  ['s:other', [msg({ id: 'm6', type: 'user', content: 'hi', timestamp: 5 })]],
])
const links = new Map<string, SwimlaneLink & { messages: ConversationMessage[] }>([
  ['l1', {
    id: 'l1', from: 's:orch', to: 's:explore',
    messages: [
      // same dispatch as m2 with another id: deduplicated by type/from/to/toolUseId
      msg({ id: 'x1', type: 'dispatch', content: 'full prompt', timestamp: 2, from: 's:orch', to: 's:explore', toolUseId: 'tu1' }),
      msg({ id: 'x2', type: 'message', content: 'peer note', timestamp: 4.5, from: 's:explore', to: 's:orch' }),
    ],
  }],
])

test('buildFeedMessages keeps finished agents, drops tool calls, merges and dedupes link messages', () => {
  const all = buildFeedMessages(conversations, links as never)
  assert.deepEqual(all.map(m => m.id), ['m1', 'm2', 'm4', 'm5', 'x2', 'm6'])
  assert.equal(all.find(m => m.id === 'x2')!.agentId, 's:explore')
  // an agent absent from the live agents map still gets a tab
  assert.deepEqual(agentIdsWithMessages(all, new Map()).sort(), ['s:explore', 's:orch', 's:other'])
})

test('filterByTab includes communications an agent received', () => {
  const all = buildFeedMessages(conversations, links as never)
  assert.deepEqual(filterByTab(all, 's:explore').map(m => m.id), ['m2', 'm4', 'm5', 'x2'])
  assert.equal(filterByTab(all, 'all').length, all.length)
})

test('Pair filter keeps only the link between two agents, both directions', () => {
  const all = buildFeedMessages(conversations, links as never)
  assert.deepEqual(filterByPair(all, 's:orch', 's:explore').map(m => m.id), ['m2', 'm5', 'x2'])
  assert.deepEqual(filterByPair(all, 's:explore', 's:orch').map(m => m.id), ['m2', 'm5', 'x2'])
  assert.deepEqual(filterByPair(all, 's:orch', 's:other'), [])
  assert.deepEqual(filterByPair(all, 's:orch', 's:orch'), [])
  assert.deepEqual(filterByPair(all, '', 's:orch'), [])
})

test('dropped marker uses the shared wording and sums for the all tab', () => {
  const dropped = new Map([['a', 12], ['b', 1]])
  assert.equal(droppedMarkerFor(dropped, 'a'), '... 12 older messages dropped')
  assert.equal(droppedMarkerFor(dropped, 'b'), '... 1 older message dropped')
  assert.equal(droppedMarkerFor(dropped, 'all'), '... 13 older messages dropped')
  assert.equal(droppedMarkerFor(dropped, 'c'), null)
  assert.equal(droppedMarkerFor(undefined, 'all'), null)
})

test('agent helpers: done state, names, sessions, teams', () => {
  assert.equal(isAgentDone(undefined), true)
  assert.equal(isAgentDone({ name: 'a', state: 'complete' }), true)
  assert.equal(isAgentDone({ name: 'a', archived: true }), true)
  assert.equal(isAgentDone({ name: 'a', activity: 'done' }), true)
  assert.equal(isAgentDone({ name: 'a', state: 'thinking' }), false)
  assert.equal(agentNameOf(new Map(), 'sess:explore'), 'explore')
  assert.equal(hasMultipleSessions(new Map([['a', { sessionId: '1' }], ['b', { sessionId: '1' }]])), false)
  assert.equal(hasMultipleSessions(new Map([['a', { sessionId: '1' }], ['b', { sessionId: '2' }]])), true)
  const groups = groupByTeam([{ teamName: 'z', n: 1 }, { n: 2 }, { teamName: 'a', n: 3 }, { teamName: 'z', n: 4 }])
  assert.deepEqual(groups.map(g => [g.team, g.items.length]), [['a', 1], ['z', 2], [null, 1]])
})

// ─── Swimlane ───────────────────────────────────────────────────────────────

test('swimlane arrows go parent -> child at dispatch and back at return, skipping unknown rows', () => {
  const l = new Map<string, SwimlaneLink>([
    ['l1', {
      id: 'l1', from: 'p', to: 'c',
      messages: [
        { id: 'd', type: 'dispatch', content: 'go', timestamp: 1, from: 'p', to: 'c' },
        { id: 'r', type: 'return', content: 'done', timestamp: 5, from: 'c', to: 'p', isError: true },
        { id: 't', type: 'tool_call', content: 'x', timestamp: 2 },
        { id: 'g', type: 'message', content: 'ghost', timestamp: 3, from: 'p', to: 'nobody' },
      ],
    }],
    ['l2', { id: 'l2', from: 'a', to: 'b', messages: [{ id: 'm', type: 'message', content: 'hey', timestamp: 3, from: 'a', to: 'b' }] }],
  ])
  const arrows = buildSwimlaneArrows(['p', 'c', 'a', 'b'], l, id => id.toUpperCase())
  assert.deepEqual(arrows.map(a => [a.id, a.fromRow, a.toRow, a.kind, a.isError]), [
    ['d', 0, 1, 'dispatch', false],
    ['m', 2, 3, 'message', false],
    ['r', 1, 0, 'return', true],
  ])
  assert.equal(arrows[0].label, 'P -> C - DISPATCH')
  assert.equal(arrows[2].label, 'C -> P - RETURN (ERROR)')
  assert.equal(swimlaneArrowLabel('message', false, 'a', 'b'), 'a -> b - MESSAGE')
  assert.deepEqual(buildSwimlaneArrows(['p'], undefined), [])
  const rows = buildMessageRows(arrows)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].content, 'go')
})

test('Sequence order sorts rows by first interaction, others keep start order', () => {
  const entries = [
    { agentId: 'lead', startTime: 0 },
    { agentId: 'solo', startTime: 1 },
    { agentId: 'late', startTime: 2 },
    { agentId: 'early', startTime: 3 },
  ]
  const l = new Map<string, SwimlaneLink>([
    ['a', { id: 'a', from: 'early', to: 'lead', messages: [{ id: '1', type: 'message', content: '', timestamp: 4, from: 'early', to: 'lead' }] }],
    ['b', { id: 'b', from: 'lead', to: 'late', messages: [{ id: '2', type: 'dispatch', content: '', timestamp: 9, from: 'lead', to: 'late' }] }],
  ])
  assert.deepEqual([...firstInteractionTimes(l)], [['early', 4], ['lead', 4], ['late', 9]])
  assert.deepEqual(orderEntriesBySequence(entries, l).map(e => e.agentId), ['lead', 'early', 'late', 'solo'])
  assert.deepEqual(orderEntriesBySequence(entries, undefined).map(e => e.agentId), ['lead', 'solo', 'late', 'early'])
  assert.deepEqual(orderEntriesByStart([{ startTime: 2 }, { startTime: 1 }]).map(e => e.startTime), [1, 2])
})

test('hitTestArrow finds an arrow near its vertical line', () => {
  const geo = [{ id: 'a', x: 100, y1: 10, y2: 50 }]
  assert.equal(hitTestArrow(geo, 102, 30), 'a')
  assert.equal(hitTestArrow(geo, 120, 30), undefined)
  assert.equal(hitTestArrow(geo, 100, 80), undefined)
})
