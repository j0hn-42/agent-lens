// Render tests of the workflow display (#79): the DOM outline headings and the legend entry
// say "Workflow", never by colour alone. Synthetic data only.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'
import { computeClusters, haloAlphas } from '@/components/agent-visualizer/canvas/cluster-model'
import { drawClusterHalos } from '@/components/agent-visualizer/canvas/draw-teams'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import type { TeamSummary } from '@/lib/agent-types'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

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
  agent({ id, name: id.slice(2), kind: 'teammate', teamName: 'tempo-wave-a', teamKind: 'workflow', activity: 'working', state: 'thinking', ...over })

function model() {
  const list = [
    agent({ id: 'S:orch', isMain: true, name: 'orch' }),
    wf('S:impl:a', { x: 50 }),
    wf('S:impl:b', { x: 90, activity: 'idle', state: 'idle' }),
  ]
  return buildA11yModel(new Map(list.map(a => [a.id, a])), new Map(), [], new Map(), {})
}

test('outline: the workflow group has a "Workflow" heading, zoom button, list label and agent announcements', () => {
  const { getByRole, getAllByRole } = render(
    <GraphA11yList
      model={model()} communications={[]} announcements={[]} focusedNode={null}
      onAgentClick={() => {}} onClusterClick={() => {}} onFocusNode={() => {}}
    />,
  )
  const headings = getAllByRole('heading', { level: 3 }).map(h => h.textContent)
  assert.ok(headings.includes('Workflow tempo-wave-a'), headings.join('|'))
  assert.ok(!headings.includes('Team tempo-wave-a'))
  getByRole('button', { name: 'Zoom to workflow tempo-wave-a' })
  assert.equal(getByRole('list', { name: 'Agents of workflow tempo-wave-a' }).querySelectorAll(':scope > li').length, 3)
  // Every agent is reachable and carries its state in words
  getByRole('button', { name: /^impl:a, thinking, working/ })
  getByRole('button', { name: /^impl:b, idle, idle/ })
  assert.ok(document.body.textContent!.includes('Agent in workflow tempo-wave-a.'))
})

test('legend: the workflow entry is worded as agents of a workflow', () => {
  const { container, getByRole } = render(<GraphLegend teams={model().teams} />)
  fireEvent.click(getByRole('button', { name: /Legend/ }))
  const text = container.textContent ?? ''
  assert.ok(text.includes('tempo-wave-a'))
  assert.match(text, /workflow, 3 agents/)
  assert.match(text, /team or workflow/i)
})

// ─── Halo drawing applies haloAlphas (recording canvas context) ──────────────

function recordingCtx() {
  const fills: string[] = []
  const strokes: string[] = []
  let fillStyle = '', strokeStyle = ''
  const ctx: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'fill') return () => { fills.push(fillStyle) }
      if (prop === 'stroke') return () => { strokes.push(strokeStyle) }
      return () => {}
    },
    set(_t, prop: string, v: string) {
      if (prop === 'fillStyle') fillStyle = String(v)
      if (prop === 'strokeStyle') strokeStyle = String(v)
      return true
    },
  })
  return { ctx, fills, strokes }
}

test('drawClusterHalos paints a finished workflow with the reduced alphas of haloAlphas', () => {
  const done = (id: string) => wf(id, { name: id.slice(2), sessionId: 'S', state: 'complete', activity: 'done', archived: true, x: id.length * 10 })
  const list = (...as: any[]) => new Map(as.map(a => [a.id, a]))
  const finished = computeClusters(list(done('S:a'), done('S:bb')).values()).find(c => c.kind === 'team')!
  const live = computeClusters(list(wf('S:a'), wf('S:b', { x: 40 })).values()).find(c => c.kind === 'team')!
  const f = recordingCtx(), l = recordingCtx()
  drawClusterHalos(f.ctx, [finished], null)
  drawClusterHalos(l.ctx, [live], null)
  const fa = haloAlphas(finished, false), la = haloAlphas(live, false)
  assert.deepEqual(f.fills, [finished.color + fa.fill])
  assert.deepEqual(f.strokes, [finished.color + fa.stroke])
  assert.deepEqual(l.fills, [live.color + la.fill])
  assert.deepEqual(l.strokes, [live.color + la.stroke])
  assert.notEqual(f.fills[0], l.fills[0].replace(live.color, finished.color), 'finished fill is fainter than a live fill')
  const sel = recordingCtx()
  drawClusterHalos(sel.ctx, [finished], finished.key)
  assert.deepEqual(sel.fills, [finished.color + haloAlphas(finished, true).fill])
})

// ─── Conversation chips and Sessions panel rows ──────────────────────────────

test('Conversation panel: workflow chips read "Workflow <name>" with aria labels, same-named ones stay apart', () => {
  const mk = (sid: string, n: string) => wf(`${sid}:${n}`, { name: n, sessionId: sid, localId: n })
  const agents = new Map(
    [mk('S1', 'impl:a'), mk('S1', 'impl:b'), mk('S2', 'impl:c')].map(a => [a.id, a]),
  )
  const teams = new Map<string, TeamSummary>([
    ['tempo-wave-a', { name: 'tempo-wave-a', leadSessionId: 'S1', kind: 'workflow', members: [] }],
    ['tempo-wave-a@S2', { name: 'tempo-wave-a', leadSessionId: 'S2', kind: 'workflow', members: [] }],
  ])
  const conversations = new Map([['S1:impl:a', [{ id: 'm1', type: 'assistant' as const, timestamp: 1, content: 'hello' }]]])
  const r = render(
    <ConversationHarness
      registry={createPanelRegistry()} conversations={conversations as never} agents={agents} selectedAgentId={null}
      onAgentClick={() => {}} teams={teams} initialOpen
    />,
  )
  const labels = Array.from(r.container.querySelectorAll('[role="group"]')).map(g => g.getAttribute('aria-label'))
  assert.ok(labels.some(l => l === 'Workflow tempo-wave-a (session S1), 2 agents'), JSON.stringify(labels))
  assert.ok(labels.some(l => l === 'Workflow tempo-wave-a (session S2), 1 agent'), JSON.stringify(labels))
  assert.ok(r.getByLabelText('Teams and workflows'))
  assert.ok(!r.container.textContent!.includes('Team tempo-wave-a'))
})

test('Sessions panel: two same-named workflows of two sessions give two rows with their own counts', () => {
  const teams = new Map<string, TeamSummary>([
    ['tempo', { name: 'tempo', leadSessionId: 'S1', kind: 'workflow', members: [] }],
    ['tempo@S2', { name: 'tempo', leadSessionId: 'S2', kind: 'workflow', members: [] }],
  ])
  const r = render(
    <SessionListPanel
      visible onClose={() => {}} sessions={[] as never} selectedSessionId={null}
      sessionsWithActivity={new Set()} onSelectSession={() => {}} onCloseSession={() => {}}
      agents={new Map()} selectedAgentId={null} onSelectAgent={() => {}}
      teams={teams} teamMemberCounts={new Map([['tempo', 2], ['tempo@S2', 3]])} teamWorking={new Map([['tempo', 2], ['tempo@S2', 3]])}
      now={5000}
    />,
  )
  const rows = Array.from(r.container.querySelectorAll<HTMLElement>('[data-row-main]')).map(el => el.textContent ?? '')
  assert.ok(rows.some(t => t.includes('Workflow tempo: 2 agents, 2 working')), JSON.stringify(rows))
  assert.ok(rows.some(t => t.includes('Workflow tempo: 3 agents, 3 working')), JSON.stringify(rows))
  assert.ok(!rows.some(t => t.includes('Team tempo')))
})
