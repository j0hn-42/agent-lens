import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  safeTeamColor, cleanText, isAgentVisible, agentDrawOpacity, agentStatusText, teammateActivity, wrapLabel,
  layoutAgentLabel, computeTeamHalos, hasSeveralSessions, teamCohesionStep, forceTeamCohesion,
  teamDefaultColor, ARCHIVED_OPACITY, TEAMMATE_MIN_OPACITY,
} from '../web/components/agent-visualizer/canvas/team-style'
import {
  resolveAgentRef, resolveLinks, linkState, findLinkAt, linkCurve, curvePoint, distanceToSegment,
  LINK_IN_FLIGHT_S, LINK_RECENT_S,
} from '../web/components/agent-visualizer/canvas/link-geometry'
import { findAgentAt, hitTestAt } from '../web/components/agent-visualizer/canvas/hit-detection'
import { buildNodeOrder } from '../web/components/agent-visualizer/canvas/keyboard-nav'
import {
  buildA11yModel, describeTransition, enqueueAnnouncements, createAnnouncementQueue, buildGraphLabel,
} from '../web/components/agent-visualizer/canvas/a11y-model'
import { detectTeamChanges, createTeamPrev } from '../web/components/agent-visualizer/canvas/team-changes'
import {
  buildLinkPanelModel, cleanMessageText, formatLinkTime, isLongMessage, LINK_MESSAGE_MAX_CHARS,
} from '../web/components/agent-visualizer/canvas/link-panel-model'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id.split(':')[1] ?? id, displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}
function agentsMap(...list: any[]): Map<string, any> {
  return new Map(list.map(a => [a.id, a]))
}
function link(over: Record<string, unknown> = {}): any {
  return { id: 'L1', from: 's1:lead', to: 's1:alice', kind: 'teammate', sessionId: 's1', messages: [], dropped: 0, ...over }
}
function msg(over: Record<string, unknown> = {}): any {
  return { id: 'm1', type: 'message', content: 'hello', timestamp: 1, ...over }
}
// Monospace measure: 6 px per character
const measure = (t: string) => t.length * 6

// ─── colour validation / text cleaning ──────────────────────────────────────

test('safeTeamColor accepts only #rrggbb', () => {
  assert.equal(safeTeamColor('#12abEF'), '#12abEF')
  for (const bad of ['red', '#fff', '#12345', '#1234567', '#12345g', 'rgb(1,2,3)', 'url(x)', '#ff0000; background:red', '', undefined, null, 12, {}]) {
    assert.equal(safeTeamColor(bad), undefined, String(bad))
  }
})

test('cleanText strips control characters and caps the length', () => {
  assert.equal(cleanText('a\u0000b\u001b[31mc\nd'), 'a b [31mc d')
  assert.equal(cleanText('x'.repeat(100), 10).length, 10)
  assert.equal(cleanText(42), '')
})

// ─── visibility of teammates and archived agents ────────────────────────────

test('archived agents and teammates are visible and clickable at any opacity', () => {
  const archived = agent({ id: 's1:old', archived: true, opacity: 0, x: 10, y: 10 })
  const teammate = agent({ id: 's1:alice', kind: 'teammate', opacity: 0.01, x: 200, y: 0 })
  const regular = agent({ id: 's1:faded', opacity: 0.01, x: 400, y: 0 })
  assert.equal(isAgentVisible(archived), true)
  assert.equal(isAgentVisible(teammate), true)
  assert.equal(isAgentVisible(regular), false)
  const agents = agentsMap(archived, teammate, regular)
  assert.equal(findAgentAt(10, 10, agents), 's1:old')
  assert.equal(findAgentAt(200, 0, agents), 's1:alice')
  assert.equal(findAgentAt(400, 0, agents), null)
  assert.deepEqual(hitTestAt(10, 10, { agents, toolCalls: new Map(), discoveries: [] }, 0, 1), { type: 'agent', id: 's1:old' })
  assert.deepEqual(buildNodeOrder(agents, new Map(), []).map(n => n.id), ['s1:old', 's1:alice'])
})

test('draw opacity: archived reduced, idle teammates never fade away', () => {
  assert.equal(agentDrawOpacity(agent({ archived: true, opacity: 1 })), ARCHIVED_OPACITY)
  assert.equal(agentDrawOpacity(agent({ kind: 'teammate', opacity: 0 })), TEAMMATE_MIN_OPACITY)
  assert.equal(agentDrawOpacity(agent({ kind: 'teammate', opacity: 1 })), 1)
  assert.equal(agentDrawOpacity(agent({ opacity: 0.3 })), 0.3)
})

test('teammate activity: explicit field first, derived from state otherwise', () => {
  assert.equal(teammateActivity(agent({ kind: 'teammate', activity: 'idle', state: 'thinking' })), 'idle')
  assert.equal(teammateActivity(agent({ kind: 'teammate', state: 'complete' })), 'done')
  assert.equal(teammateActivity(agent({ kind: 'teammate', state: 'idle' })), 'idle')
  assert.equal(teammateActivity(agent({ kind: 'teammate', state: 'tool_calling' })), 'working')
  assert.equal(teammateActivity(agent({ state: 'idle' })), undefined)
  assert.equal(agentStatusText(agent({ kind: 'teammate', activity: 'idle', state: 'idle' })), 'idle')
  // An urgent state wins over the activity text
  assert.equal(agentStatusText(agent({ kind: 'teammate', activity: 'working', state: 'waiting_permission' })), 'waiting')
  assert.equal(agentStatusText(agent({ state: 'thinking' })), 'thinking')
})

// ─── label layout ───────────────────────────────────────────────────────────

test('wrapLabel wraps on words, ellipsizes the last line and never exceeds the width', () => {
  const one = wrapLabel('short', 120, measure, 2)
  assert.deepEqual(one, { lines: ['short'], truncated: false })
  const two = wrapLabel('security reviewer teammate', 90, measure, 2)
  assert.equal(two.lines.length, 2)
  assert.ok(two.lines.every(l => measure(l) <= 90), JSON.stringify(two))
  const cut = wrapLabel('a very long teammate name that cannot possibly fit on two lines', 90, measure, 2)
  assert.equal(cut.truncated, true)
  assert.equal(cut.lines.length, 2)
  assert.ok(cut.lines[1].endsWith('…'))
  assert.ok(cut.lines.every(l => measure(l) <= 90))
  // A single unbreakable word is hard-wrapped
  const word = wrapLabel('x'.repeat(40), 60, measure, 2)
  assert.ok(word.lines.every(l => measure(l) <= 60))
})

test('layoutAgentLabel: teammates get two lines and a wider box, others one truncated line', () => {
  const name = 'frontend implementation teammate'
  const mate = layoutAgentLabel({ kind: 'teammate', name, state: 'idle', activity: 'idle' }, 20, measure)
  assert.equal(mate.nameLines.length, 2)
  assert.equal(mate.statusLine, 'idle')
  assert.equal(mate.extraLines, 1)
  const sub = layoutAgentLabel({ kind: 'subagent', name, state: 'thinking' } as any, 20, measure)
  assert.equal(sub.nameLines.length, 1)
  assert.equal(sub.truncated, true)
  assert.equal(sub.extraLines, 0)
})

test('layoutAgentLabel adds a session line only when asked and sanitises it', () => {
  const a = { kind: 'subagent', name: 'x', state: 'idle', sessionLabel: 'repo\u0007 main' } as any
  assert.equal(layoutAgentLabel(a, 20, measure, false).sessionLine, undefined)
  const withSession = layoutAgentLabel(a, 20, measure, true)
  assert.equal(withSession.sessionLine, 'repo main')
  assert.equal(withSession.extraLines, 1)
  assert.equal(hasSeveralSessions([{ sessionId: 'a' }, { sessionId: 'a' }]), false)
  assert.equal(hasSeveralSessions([{ sessionId: 'a' }, { sessionId: 'b' }]), true)
})

// ─── team halos ─────────────────────────────────────────────────────────────

test('computeTeamHalos groups by team, needs two members, validates the colour', () => {
  const agents = [
    agent({ id: 's1:lead', teamName: 'alpha', x: 0, y: 0, isMain: true, teamColor: '#ff0000' }),
    agent({ id: 's1:a', teamName: 'alpha', x: 200, y: 0, kind: 'teammate' }),
    agent({ id: 's1:b', teamName: 'beta', x: 500, y: 500, kind: 'teammate', teamColor: 'red' }),
    agent({ id: 's1:c', x: -300, y: 0 }),
  ]
  const halos = computeTeamHalos(agents)
  assert.equal(halos.length, 1)
  const h = halos[0]
  assert.equal(h.name, 'alpha')
  assert.equal(h.color, '#ff0000')
  assert.deepEqual(h.memberIds, ['s1:lead', 's1:a'])
  assert.equal(h.cx, 100)
  assert.ok(h.r > 100)
  // Both members inside the circle
  for (const m of agents.slice(0, 2)) assert.ok(Math.hypot(m.x - h.cx, m.y - h.cy) < h.r)
})

test('computeTeamHalos falls back to the team summary colour, then the default', () => {
  const agents = [
    agent({ id: 's1:a', teamName: 'beta', x: 0, y: 0, kind: 'teammate', teamColor: 'javascript:1' }),
    agent({ id: 's1:b', teamName: 'beta', x: 100, y: 0, kind: 'teammate' }),
  ]
  assert.equal(computeTeamHalos(agents)[0].color, teamDefaultColor())
  const teams = new Map([['beta', { name: 'beta', leadSessionId: 's1', members: [{ name: 'a', color: '#00ff00' }] }]])
  assert.equal(computeTeamHalos(agents, teams as any)[0].color, '#00ff00')
})

test('team cohesion pulls members of a team together and ignores loners', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, vx: 0, vy: 0 },
    { id: 'b', x: 100, y: 0, vx: 0, vy: 0 },
    { id: 'c', x: 500, y: 500, vx: 0, vy: 0 },
  ]
  const teamOf = (id: string) => (id === 'c' ? 'solo' : 'alpha')
  teamCohesionStep(nodes, teamOf, 0.1, 1)
  assert.ok(nodes[0].vx > 0 && nodes[1].vx < 0)
  assert.equal(nodes[2].vx, 0)
  const f = forceTeamCohesion(teamOf, 0.1)
  f.initialize(nodes)
  f(1)
  assert.ok(nodes[0].vx > 0)
})

// ─── link resolution ────────────────────────────────────────────────────────

test('resolveAgentRef resolves keys, local names and display names inside the link session', () => {
  const agents = agentsMap(
    agent({ id: 's1:lead', localId: 'lead', name: 'Lead', displayName: 'Lead' }),
    agent({ id: 's1:alice', localId: 'alice', name: 'Alice (reviewer)', displayName: 'Alice (reviewer)' }),
    agent({ id: 's2:alice', sessionId: 's2', localId: 'alice', name: 'Alice other', displayName: 'Alice other' }),
  )
  assert.equal(resolveAgentRef('s1:lead', 's1', agents), 's1:lead')
  assert.equal(resolveAgentRef('alice', 's1', agents), 's1:alice')
  assert.equal(resolveAgentRef('alice', 's2', agents), 's2:alice')
  assert.equal(resolveAgentRef('Alice (reviewer)', 's1', agents), 's1:alice')
  assert.equal(resolveAgentRef('ghost', 's1', agents), null)
  assert.equal(resolveAgentRef('', 's1', agents), null)
})

test('resolveLinks maps local names to agent keys and drops dangling or self links', () => {
  const agents = agentsMap(agent({ id: 's1:lead', localId: 'lead' }), agent({ id: 's1:alice', localId: 'alice' }))
  const links = new Map<string, any>([
    ['L1', link({ id: 'L1', from: 'lead', to: 'alice', messages: [msg({ from: 'alice', to: 'lead' })] })],
    ['L2', link({ id: 'L2', from: 'lead', to: 'ghost' })],
    ['L3', link({ id: 'L3', from: 'lead', to: 'lead' })],
  ])
  const resolved = resolveLinks(links, agents, 0)
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].fromKey, 's1:lead')
  assert.equal(resolved[0].toKey, 's1:alice')
  assert.equal(resolved[0].lastBackward, true)
  assert.equal(resolved[0].count, 1)
  assert.deepEqual(resolveLinks(undefined, agents, 0), [])
})

test('linkState: error, open dispatch, in flight, recent, idle', () => {
  assert.equal(linkState(link(), 0), 'idle')
  assert.equal(linkState(link({ messages: [msg({ isError: true })] }), 1), 'error')
  assert.equal(linkState(link({ kind: 'spawn', messages: [msg({ type: 'dispatch', timestamp: 0 })] }), 500), 'in_flight')
  assert.equal(linkState(link({ kind: 'spawn', messages: [msg({ type: 'dispatch', timestamp: 0 }), msg({ id: 'm2', type: 'return', timestamp: 30 })] }), 500), 'idle')
  assert.equal(linkState(link({ messages: [msg({ timestamp: 10 })] }), 10 + LINK_IN_FLIGHT_S - 0.1), 'in_flight')
  assert.equal(linkState(link({ messages: [msg({ timestamp: 10 })] }), 10 + LINK_RECENT_S - 0.1), 'recent')
  assert.equal(linkState(link({ messages: [msg({ timestamp: 10 })] }), 10 + LINK_RECENT_S + 1), 'idle')
})

// ─── edge hit-testing ───────────────────────────────────────────────────────

test('findLinkAt hits within 8 screen pixels of the curve and nowhere else', () => {
  const lead = agent({ id: 's1:lead', localId: 'lead', x: 0, y: 0 })
  const alice = agent({ id: 's1:alice', localId: 'alice', x: 400, y: 0 })
  const agents = agentsMap(lead, alice)
  const resolved = resolveLinks(new Map([['L1', link({ messages: [msg()] })]]), agents, 100)
  const curve = linkCurve(resolved[0], agents)!
  const p = curvePoint(curve, 0.25)

  assert.equal(findLinkAt(p.x, p.y, resolved, agents, 1), 'L1')
  // 6 px away at scale 1: inside the tolerance
  assert.equal(findLinkAt(p.x, p.y + 6, resolved, agents, 1), 'L1')
  // 30 px away: outside
  assert.equal(findLinkAt(p.x, p.y + 30, resolved, agents, 1), null)
  // Tolerance is in screen pixels: zoomed out to 0.25, 6 world units are 1.5 px, 24 world units are 6 px
  assert.equal(findLinkAt(p.x, p.y + 24, resolved, agents, 0.25), 'L1')
  assert.equal(findLinkAt(p.x, p.y + 24, resolved, agents, 4), null)
  // The count badge at the middle is a target as well
  const mid = curvePoint(curve, 0.5)
  assert.equal(findLinkAt(mid.x + 10, mid.y + 10, resolved, agents, 1), 'L1')
  assert.equal(findLinkAt(mid.x + 10, mid.y + 10, [], agents, 1), null)
})

test('findLinkAt picks the nearest of two links and ignores links with hidden ends', () => {
  const agents = agentsMap(
    agent({ id: 's1:lead', localId: 'lead', x: 0, y: 0 }),
    agent({ id: 's1:alice', localId: 'alice', x: 400, y: 0 }),
    agent({ id: 's1:ghost', localId: 'ghost', x: 400, y: 300, opacity: 0 }),
  )
  const links = new Map([
    ['L1', link({ id: 'L1' })],
    ['L2', link({ id: 'L2', to: 's1:ghost' })],
  ])
  const resolved = resolveLinks(links, agents, 0)
  const curve = linkCurve(resolved[0], agents)!
  const p = curvePoint(curve, 0.7)
  assert.equal(findLinkAt(p.x, p.y, resolved, agents, 1), 'L1')
  // L2 ends at an invisible regular agent: not drawn, not clickable
  assert.equal(linkCurve(resolved[1], agents), null)
  assert.equal(distanceToSegment(5, 5, 0, 0, 10, 0), 5)
})

test('hitTestAt prefers agents and cards over links and reports links last', () => {
  const agents = agentsMap(agent({ id: 's1:lead', localId: 'lead', x: 0, y: 0 }), agent({ id: 's1:alice', localId: 'alice', x: 400, y: 0 }))
  const resolved = resolveLinks(new Map([['L1', link()]]), agents, 0)
  const scene = { agents, toolCalls: new Map(), discoveries: [], links: resolved }
  const curve = linkCurve(resolved[0], agents)!
  const p = curvePoint(curve, 0.5)
  assert.deepEqual(hitTestAt(p.x, p.y, scene, 0, 1), { type: 'link', id: 'L1' })
  assert.deepEqual(hitTestAt(0, 0, scene, 0, 1), { type: 'agent', id: 's1:lead' })
  assert.equal(hitTestAt(p.x, p.y + 200, scene, 0, 1), null)
})

// ─── DOM model with teams ───────────────────────────────────────────────────

test('buildA11yModel lists teams, teammates activity and a button-ready entry per link', () => {
  const agents = agentsMap(
    agent({ id: 's1:lead', localId: 'lead', name: 'Lead', isMain: true, teamName: 'alpha', sessionLabel: 'repo-a' }),
    agent({ id: 's1:alice', localId: 'alice', name: 'Alice', kind: 'teammate', teamName: 'alpha', activity: 'idle', teamColor: '#00ff00', x: 100 }),
    agent({ id: 's1:old', localId: 'old', name: 'Old', archived: true, state: 'complete', opacity: 0 }),
  )
  const links = new Map([['L1', link({ messages: [msg({ from: 's1:alice', to: 's1:lead' }), msg({ id: 'm2' })] })]])
  const model = buildA11yModel(agents, new Map(), [], new Map(), { links: links as any, simTime: 1.5 })
  assert.equal(model.teams.length, 1)
  assert.equal(model.teams[0].color, '#00ff00')
  assert.match(model.teams[0].text, /^Team alpha: Lead, Alice \(idle\)$/)
  assert.match(model.summary, /1 team$/)
  const alice = model.agents.find(a => a.id === 's1:alice')!
  assert.equal(alice.activityText, 'idle')
  assert.equal(alice.teamName, 'alpha')
  assert.equal(model.agents.find(a => a.id === 's1:old')!.archived, true)
  assert.equal(model.links.length, 1)
  assert.equal(model.links[0].count, 2)
  assert.equal(model.links[0].text, 'Lead to Alice, teammate, 2 messages, in flight')
  // Session label is only exposed when several sessions are on screen
  assert.equal(model.agents[0].sessionLabel, undefined)
  const two = agentsMap(
    agent({ id: 's1:lead', name: 'Lead', sessionLabel: 'repo-a' }),
    agent({ id: 's2:x', sessionId: 's2', name: 'X', sessionLabel: 'repo-b' }),
  )
  const multi = buildA11yModel(two, new Map(), [], new Map())
  assert.deepEqual(multi.agents.map(a => a.sessionLabel), ['repo-a', 'repo-b'])
})

test('buildA11yModel without extras keeps the previous shape (no teams, no links)', () => {
  const model = buildA11yModel(agentsMap(agent()), new Map(), [], new Map())
  assert.deepEqual(model.teams, [])
  assert.deepEqual(model.links, [])
  assert.equal(buildGraphLabel([{ state: 'idle' }]), 'Agent graph: 1 agent, 0 running, 0 waiting for permission')
})

test('announcements for teammate activity and link messages go through the dedupe queue', () => {
  assert.equal(describeTransition({ kind: 'agent_activity', id: 'a', name: 'Alice', activity: 'idle' }), 'Alice is idle')
  assert.equal(describeTransition({ kind: 'message_sent', id: 'x', name: 'Lead', from: 'Lead', to: 'Alice' }), 'Lead sent a message to Alice')
  const t = { kind: 'message_sent', id: 'x', name: 'Lead', from: 'Lead', to: 'Alice' } as const
  const q = enqueueAnnouncements(createAnnouncementQueue(), [t, { ...t, id: 'y' }])
  assert.equal(q.items.length, 1)
})

test('detectTeamChanges: first pass only records, later passes announce changes', () => {
  const lead = agent({ id: 's1:lead', localId: 'lead', name: 'Lead' })
  const alice = (activity: string) => agent({ id: 's1:alice', localId: 'alice', name: 'Alice', kind: 'teammate', activity })
  const links = (messages: any[]) => new Map([['L1', link({ messages })]]) as any

  const first = detectTeamChanges(agentsMap(lead, alice('working')), links([msg()]), createTeamPrev())
  assert.deepEqual(first.transitions, [])
  assert.equal(first.next.primed, true)

  const second = detectTeamChanges(agentsMap(lead, alice('idle')), links([msg(), msg({ id: 'm2', from: 's1:lead', to: 's1:alice' })]), first.next)
  assert.deepEqual(second.transitions.map(t => t.kind), ['agent_activity', 'message_sent'])
  assert.equal(describeTransition(second.transitions[0]), 'Alice is idle')
  assert.equal(describeTransition(second.transitions[1]), 'Lead sent a message to Alice')

  const third = detectTeamChanges(agentsMap(lead, alice('idle')), links([msg(), msg({ id: 'm2' })]), second.next)
  assert.deepEqual(third.transitions, [])
})

// ─── link panel model ───────────────────────────────────────────────────────

test('buildLinkPanelModel orders messages chronologically with sender, direction and time', () => {
  const agents = agentsMap(
    agent({ id: 's1:lead', localId: 'lead', name: 'Lead' }),
    agent({ id: 's1:child', localId: 'child', name: 'Explorer' }),
  )
  const l = link({
    id: 'L9', kind: 'spawn', from: 's1:lead', to: 's1:child', dropped: 2,
    messages: [
      msg({ id: 'r', type: 'return', from: 's1:child', to: 's1:lead', content: 'report\u0000 done', timestamp: 75, isError: true }),
      msg({ id: 'd', type: 'dispatch', from: 's1:lead', to: 's1:child', content: 'x'.repeat(500), timestamp: 5 }),
    ],
  })
  const model = buildLinkPanelModel(l, agents)
  assert.deepEqual(model.entries.map(e => e.id), ['d', 'r'])
  assert.equal(model.entries[0].typeLabel, 'DISPATCH')
  assert.equal(model.entries[0].arrow, '→')
  assert.equal(model.entries[0].directionText, 'Lead to Explorer')
  assert.equal(model.entries[0].long, true)
  assert.equal(model.entries[0].content.length, 500)
  assert.equal(model.entries[1].typeLabel, 'RETURN')
  assert.equal(model.entries[1].arrow, '←')
  assert.equal(model.entries[1].timeText, '1:15')
  assert.equal(model.entries[1].isError, true)
  assert.equal(model.entries[1].content, 'report  done')
  assert.equal(model.entries[1].long, false)
  assert.equal(model.droppedText, '2 older messages were dropped')
  assert.equal(model.summary, '4 messages')
})

test('link panel infers the sender of a return that lacks a from field', () => {
  const agents = agentsMap(agent({ id: 's1:lead', localId: 'lead', name: 'Lead' }), agent({ id: 's1:child', localId: 'child', name: 'Explorer' }))
  const model = buildLinkPanelModel(link({ kind: 'spawn', from: 'lead', to: 'child', messages: [msg({ type: 'return' })] }), agents)
  assert.equal(model.entries[0].senderName, 'Explorer')
  assert.equal(model.entries[0].arrow, '←')
})

test('message text helpers: cap, keep newlines, format time, detect long messages', () => {
  assert.equal(cleanMessageText('a\r\nb\u0007c\td'), 'a\nb c\td')
  assert.equal(cleanMessageText('y'.repeat(LINK_MESSAGE_MAX_CHARS + 50)).length, LINK_MESSAGE_MAX_CHARS)
  assert.equal(cleanMessageText(undefined), '')
  assert.equal(formatLinkTime(0), '0:00')
  assert.equal(formatLinkTime(65.9), '1:05')
  assert.equal(formatLinkTime(NaN), '0:00')
  assert.equal(isLongMessage('short'), false)
  assert.equal(isLongMessage('1\n2\n3\n4\n5\n6\n7'), true)
})
