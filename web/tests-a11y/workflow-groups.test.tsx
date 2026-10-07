// Render tests of the workflow display (#79): the DOM outline headings and the legend entry
// say "Workflow", never by colour alone. Synthetic data only.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'

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
