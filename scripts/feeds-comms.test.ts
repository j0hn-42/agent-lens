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

// ─── Review fixes: dedupe, pair filter, unread, arrow cap ────────────────────

import { commDedupeKeys, pairFromShiftClick, pairOfMessage, unreadSources, agentsWithNewText } from '../web/lib/feed-utils'
import { capMessageRows } from '../web/lib/timeline-rows'

test('buildFeedMessages keeps distinct same-timestamp peer messages without toolUseId', () => {
  const conv = new Map<string, ConversationMessage[]>([['a', [
    msg({ id: 'p1', type: 'message', content: 'first note', timestamp: 5, from: 'a', to: 'b' }),
    msg({ id: 'p2', type: 'message', content: 'second note', timestamp: 5, from: 'a', to: 'b' }),
  ]]])
  assert.deepEqual(buildFeedMessages(conv).map(m => m.id), ['p1', 'p2'])
})

test('buildFeedMessages merges the conversation and link copies of one peer message', () => {
  const conv = new Map<string, ConversationMessage[]>([['a', [
    msg({ id: 'c1', type: 'message', content: 'Hello  there', timestamp: 5.1, from: 'a', to: 'b' }),
  ]]])
  const lk = new Map([['l', { from: 'a', messages: [
    msg({ id: 'l1', type: 'message', content: 'hello there', timestamp: 5.4, from: 'a', to: 'b' }),
  ] }]])
  assert.equal(buildFeedMessages(conv, lk).length, 1)
  // copies on either side of a bucket edge still merge
  const k1 = commDedupeKeys({ type: 'message', from: 'a', to: 'b', content: 'x', timestamp: 1.99 })
  const k2 = commDedupeKeys({ type: 'message', from: 'a', to: 'b', content: 'x', timestamp: 2.01 })
  assert.ok(k1.some(k => k2.includes(k)))
})

test('same content from different senders or far apart in time stays distinct', () => {
  const conv = new Map<string, ConversationMessage[]>([['a', [
    msg({ id: 'd1', type: 'message', content: 'ok', timestamp: 1, from: 'a', to: 'b' }),
    msg({ id: 'd2', type: 'message', content: 'ok', timestamp: 1, from: 'b', to: 'a' }),
    msg({ id: 'd3', type: 'message', content: 'ok', timestamp: 30, from: 'a', to: 'b' }),
  ]]])
  assert.equal(buildFeedMessages(conv).length, 3)
})

test('pairFromShiftClick needs two different real agents', () => {
  assert.deepEqual(pairFromShiftClick('a', 'b'), ['a', 'b'])
  assert.equal(pairFromShiftClick('a', 'a'), null)
  assert.equal(pairFromShiftClick('all', 'b'), null)
  assert.equal(pairFromShiftClick('a', 'all'), null)
  assert.equal(pairFromShiftClick(null, 'b'), null)
})

test('pairOfMessage only for directed communications, and filterByPair uses it', () => {
  assert.deepEqual(pairOfMessage({ type: 'dispatch', from: 'a', to: 'b' }), ['a', 'b'])
  assert.equal(pairOfMessage({ type: 'assistant', from: 'a', to: 'b' }), null)
  assert.equal(pairOfMessage({ type: 'message', from: 'a' }), null)
  const all = buildFeedMessages(conversations, links)
  const [x, y] = pairOfMessage(all.find(m => m.type === 'dispatch')!)!
  const filtered = filterByPair(all, y, x)
  assert.ok(filtered.length > 0)
  assert.ok(filtered.every(m => (m.from === x && m.to === y) || (m.from === y && m.to === x)))
})

test('link-only teammate messages mark both agents unread', () => {
  const lk = new Map([['l', { from: 'a', to: 'b', messages: [msg({ id: 'u1', type: 'message', content: 'hi', timestamp: 1, from: 'a', to: 'b' })] }]])
  const src = unreadSources(new Map(), lk)
  const { increased } = agentsWithNewText(new Map(), src, new Set(['message']))
  assert.deepEqual(increased.sort(), ['a', 'b'])
})

test('capMessageRows keeps the latest rows and reports the hidden count', () => {
  assert.deepEqual(capMessageRows([1, 2, 3], 5), { rows: [1, 2, 3], hidden: 0 })
  assert.deepEqual(capMessageRows([1, 2, 3, 4, 5], 2), { rows: [4, 5], hidden: 3 })
})

// ─── feeds-fix2: unread per source, burst dedupe ─────────────────────────────

import { trackUnread, emptyUnreadState } from '../web/lib/feed-utils'

const FEED_TYPES = new Set(['assistant', 'user', 'thinking', 'dispatch', 'return', 'message'])

test('a new tool_call does not flag an agent that has an old link copy', () => {
  const dispatch = msg({ id: 'd1', type: 'dispatch', content: 'do it', timestamp: 1, from: 'p', to: 'c' })
  const copy = msg({ id: 'd1-link', type: 'dispatch', content: 'do it', timestamp: 1, from: 'p', to: 'c' })
  const lk = new Map([['l', { from: 'p', to: 'c', messages: [copy] }]])
  const conv1 = new Map<string, ConversationMessage[]>([['p', [dispatch]]])
  const first = trackUnread(emptyUnreadState(), conv1, lk, FEED_TYPES)
  const conv2 = new Map<string, ConversationMessage[]>([['p', [dispatch, msg({ id: 't1', type: 'tool_call', content: 'x', timestamp: 2 })]]])
  assert.deepEqual(trackUnread(first.next, conv2, lk, FEED_TYPES).increased, [])
})

test('a new text message is detected even when link copies exist', () => {
  const copy = msg({ id: 'd1-link', type: 'dispatch', content: 'do it', timestamp: 1, from: 'p', to: 'c' })
  const lk = new Map([['l', { from: 'p', to: 'c', messages: [copy] }]])
  const conv1 = new Map<string, ConversationMessage[]>([['p', [msg({ id: 't0', type: 'tool_call', content: 'x', timestamp: 0 })]]])
  const first = trackUnread(emptyUnreadState(), conv1, lk, FEED_TYPES)
  const conv2 = new Map<string, ConversationMessage[]>([['p', [...conv1.get('p')!, msg({ id: 'a1', type: 'assistant', content: 'hi', timestamp: 3 })]]])
  assert.deepEqual(trackUnread(first.next, conv2, lk, FEED_TYPES).increased, ['p'])
})

test('a link-only message flags both ends once; a link copy of a conversation message does not', () => {
  const m1 = msg({ id: 'u1', type: 'message', content: 'hi', timestamp: 1, from: 'a', to: 'b' })
  const lk1 = new Map([['l', { from: 'a', to: 'b', messages: [m1] }]])
  const s1 = trackUnread(emptyUnreadState(), new Map(), lk1, FEED_TYPES)
  assert.deepEqual(s1.increased.sort(), ['a', 'b'])
  assert.deepEqual(trackUnread(s1.next, new Map(), lk1, FEED_TYPES).increased, [])
  const conv = new Map<string, ConversationMessage[]>([['a', [msg({ id: 'c9', type: 'message', content: 'later', timestamp: 4, from: 'a', to: 'b' })]]])
  const lk2 = new Map([['l', { from: 'a', to: 'b', messages: [m1, msg({ id: 'l9', type: 'message', content: 'Later', timestamp: 4.2, from: 'a', to: 'b' })] }]])
  const s2 = trackUnread({ convLens: new Map([['a', 0]]), linkSeen: s1.next.linkSeen }, conv, lk2, FEED_TYPES)
  assert.deepEqual(s2.increased, ['a'])
})

test('identical peer acks in one burst are all kept, while conversation+link copies still merge', () => {
  const acks = [1, 2, 3].map(i => msg({ id: `k${i}`, type: 'message', content: 'ok', timestamp: 5, from: 'a', to: 'b' }))
  assert.equal(buildFeedMessages(new Map(), new Map([['l', { from: 'a', messages: acks }]])).length, 3)
  const conv = new Map<string, ConversationMessage[]>([['a', [acks[0]]]])
  const copy = new Map([['l', { from: 'a', messages: [msg({ id: 'kk', type: 'message', content: 'ok', timestamp: 5, from: 'a', to: 'b' })] }]])
  assert.equal(buildFeedMessages(conv, copy).length, 1)
})
