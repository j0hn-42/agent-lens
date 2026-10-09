// Phases of a workflow (#146) in the DOM outline and the sessions list, and the live announcement of
// the finished agents 'Hide inactive agents' keeps off the screen (#147). Synthetic data only.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within } from '@testing-library/react'

import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'
import { phaseLabels } from '@/components/agent-visualizer/canvas/cluster-model'
import { drawPhaseLabels } from '@/components/agent-visualizer/canvas/draw-teams'
import { DEFAULT_DRAW_OPTS } from '@/components/agent-visualizer/canvas/draw-options'
import { SessionListPanel, type SessionListAgent } from '@/components/agent-visualizer/session-list-panel'
import { HiddenFinishedAnnouncer } from '@/components/agent-visualizer/chrome-announcer'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 'S:main'
  return {
    id, agentKey: id, sessionId: 'S', localId: id.split(':')[1] ?? id, displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}
const wf = (id: string, over: Record<string, unknown> = {}) =>
  agent({ id, name: id.slice(2), kind: 'teammate', teamName: 'wave', teamKind: 'workflow', activity: 'working', state: 'thinking', ...over })

function outline(list: any[]) {
  const model = buildA11yModel(new Map(list.map(a => [a.id, a])), new Map(), [], new Map(), {})
  return render(
    <GraphA11yList
      model={model} communications={[]} announcements={[]} focusedNode={null}
      onAgentClick={() => {}} onClusterClick={() => {}} onFocusNode={() => {}}
    />,
  )
}

test('outline: the agents of a workflow are in named phase groups, in order of first appearance, the others stay outside', () => {
  const { getByRole, getAllByRole } = outline([
    agent({ id: 'S:orch', isMain: true, name: 'orch' }),
    wf('S:a', { phase: 'Review', x: 10 }),
    wf('S:b', { phase: 'Implement', x: 20 }),
    wf('S:c', { phase: 'Review', x: 30 }),
    wf('S:d', { x: 40 }),
  ])
  const groups = getAllByRole('group').map(g => g.getAttribute('aria-label'))
  assert.deepEqual(groups, ['Phase Review', 'Phase Implement', 'No phase'])
  const review = getByRole('group', { name: 'Phase Review' })
  assert.deepEqual(within(review).getAllByRole('button').map(b => b.textContent?.split(',')[0]), ['a', 'c'])
  assert.match(review.textContent ?? '', /Phase Review, 2 agents\./)
  assert.deepEqual(within(getByRole('group', { name: 'No phase' })).getAllByRole('button').map(b => b.textContent?.split(',')[0]), ['d'])
  // The orchestrator is not in any phase
  assert.equal(groups.length, 3)
  assert.ok(!review.textContent!.includes('orch'))
  assert.ok(document.body.textContent!.includes('Phase Review. '), 'the agent paragraph names its phase')
})

test('outline: without any announced phase the list is flat, no group and no "No phase" is invented', () => {
  const { queryAllByRole, getByRole } = outline([
    agent({ id: 'S:orch', isMain: true, name: 'orch' }),
    wf('S:a'), wf('S:b'),
  ])
  assert.equal(queryAllByRole('group').length, 0)
  assert.equal(getByRole('list', { name: 'Agents of workflow wave' }).querySelectorAll(':scope > li').length, 3)
  assert.ok(!document.body.textContent!.includes('No phase'))
})

test('phaseLabels: one label per announced phase at the centre of its members, nothing for agents without phase', () => {
  const list = [
    agent({ id: 'S:orch', isMain: true }),
    wf('S:a', { phase: 'P1', x: 0, y: 100 }), wf('S:b', { phase: 'P1', x: 100, y: 50 }),
    wf('S:c', { phase: 'P2', x: 300, y: 0 }), wf('S:d', { x: 5, y: 5 }),
  ]
  const labels = phaseLabels(list)
  assert.deepEqual(labels.map(l => l.text), ['Phase P1 (2)', 'Phase P2 (1)'])
  assert.equal(labels[0].x, 50)
  assert.ok(labels[0].y < 50, 'above the highest member')
  assert.deepEqual(labels[0].memberIds, ['S:a', 'S:b'])
  assert.deepEqual(phaseLabels([agent({ id: 'S:orch', isMain: true }), wf('S:a'), wf('S:b')]), [])
})

test('canvas: drawPhaseLabels writes each phase label, and nothing at a zoom too low to read', () => {
  const texts: string[] = []
  const ctx: any = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'fillText') return (text: string) => { texts.push(text) }
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 7 })
      return () => {}
    },
    set: () => true,
  })
  const labels = phaseLabels([wf('S:a', { phase: 'P1' }), wf('S:b', { phase: 'P2', x: 300 })])
  drawPhaseLabels(ctx, labels, { ...DEFAULT_DRAW_OPTS, zoom: 1 })
  assert.deepEqual(texts, ['Phase P1 (1)', 'Phase P2 (1)'])
  texts.length = 0
  drawPhaseLabels(ctx, labels, { ...DEFAULT_DRAW_OPTS, zoom: 0.1 })
  assert.deepEqual(texts, [])
})

// ─── Sessions list ───────────────────────────────────────────────────────────

const session: SessionInfo = { id: 'S', label: 'run', status: 'active', startTime: 0, lastActivityTime: 30, runtime: 'claude' }
const row = (id: string, name: string, over: Record<string, unknown> = {}): SessionListAgent =>
  ({ id, sessionId: 'S', parentKey: 'S:orch', name, state: 'thinking', tokensUsed: 1, spawnTime: 2, lastEventAt: Date.now(), ...over }) as SessionListAgent

function panel(agents: SessionListAgent[]) {
  return (
    <SessionListPanel
      visible onClose={() => {}} sessions={[session]} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={() => {}} onCloseSession={() => {}} agents={new Map(agents.map(a => [a.id, a]))}
      selectedAgentId={null} onSelectAgent={() => {}} now={5000} observedSessionIds={new Set(['S'])}
    />
  )
}

test('sessions list: the workflow agents of an orchestrator sit under one named group per phase', () => {
  const orch = { id: 'S:orch', sessionId: 'S', parentKey: null, name: 'orch', state: 'thinking', tokensUsed: 1, spawnTime: 1, lastEventAt: Date.now() } as SessionListAgent
  const { getByRole } = render(panel([
    orch,
    row('S:a', 'impl-a', { teamKind: 'workflow', phase: 'Implement' }),
    row('S:b', 'rev-b', { teamKind: 'workflow', phase: 'Review' }),
    row('S:c', 'impl-c', { teamKind: 'workflow', phase: 'Implement' }),
    row('S:d', 'loose', { teamKind: 'workflow' }),
  ]))
  const impl = getByRole('group', { name: 'Phase Implement' })
  const implButtons = within(impl).getAllByRole('button')
  assert.equal(implButtons.length, 2)
  assert.ok(implButtons[0].textContent!.includes('impl-a') && implButtons[1].textContent!.includes('impl-c'))
  assert.equal(within(getByRole('group', { name: 'Phase Review' })).getAllByRole('button').length, 1)
  assert.equal(within(getByRole('group', { name: 'No phase' })).getAllByRole('button').length, 1)
})

test('sessions list: without phase the sub-agents are listed as before (no group)', () => {
  const orch = { id: 'S:orch', sessionId: 'S', parentKey: null, name: 'orch', state: 'thinking', tokensUsed: 1, spawnTime: 1, lastEventAt: Date.now() } as SessionListAgent
  const { queryAllByRole } = render(panel([orch, row('S:a', 'a', { teamKind: 'workflow' }), row('S:b', 'b')]))
  assert.equal(queryAllByRole('group').length, 0)
})

// ─── Live announcement of the hidden finished agents ─────────────────────────

test('announcer: a polite status says how many finished agents are hidden, and says nothing when the button is off', () => {
  const agents = new Map<string, any>([
    ['S:orch', agent({ id: 'S:orch', isMain: true, state: 'thinking' })],
    ['S:a', wf('S:a', { activity: 'done', state: 'idle' })],
    ['S:b', wf('S:b', { activity: 'done', state: 'complete' })],
    ['S:c', wf('S:c')],
  ])
  const { getByRole, rerender } = render(<HiddenFinishedAnnouncer agents={agents} hideInactive />)
  const status = getByRole('status')
  assert.equal(status.getAttribute('aria-live'), 'polite')
  assert.equal(status.textContent, '2 finished agents hidden')
  rerender(<HiddenFinishedAnnouncer agents={agents} hideInactive keepIds={['S:a']} />)
  assert.equal(getByRole('status').textContent, '1 finished agent hidden')
  rerender(<HiddenFinishedAnnouncer agents={agents} hideInactive={false} />)
  assert.equal(getByRole('status').textContent, '')
})
