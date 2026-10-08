// Render tests of the canvas-fleet package: the link panel (Escape, expand / collapse, no double
// state) and the DOM mirror list (click path of agents, links and clusters, orchestrator announcement,
// grouping by session / team). Synthetic data only.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { LinkPanel } from '@/components/agent-visualizer/link-panel'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'
import { teamDefaultColor } from '@/components/agent-visualizer/canvas/team-style'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

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
const map = (...list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))

function longLink() {
  const agents = map(agent({ id: 's1:lead', name: 'Lead', isMain: true }), agent({ id: 's1:child', name: 'Child', x: 300 }))
  const link: any = {
    id: 'L1', from: 's1:lead', to: 's1:child', kind: 'spawn', sessionId: 's1', dropped: 0,
    messages: [
      { id: 'm1', type: 'dispatch', content: 'word '.repeat(200), timestamp: 1, from: 's1:lead', to: 's1:child' },
      { id: 'm2', type: 'return', content: 'short report', timestamp: 5, from: 's1:child', to: 's1:lead' },
    ],
  }
  return { agents, link }
}

test('LinkPanel: Escape closes it, and "Show all" toggles by its label only (no aria-pressed)', () => {
  const { agents, link } = longLink()
  let closed = 0
  const { getByRole, queryByRole } = render(<LinkPanel link={link} agents={agents} onClose={() => { closed++ }} />)
  const dialog = getByRole('dialog')
  assert.ok(dialog.getAttribute('aria-labelledby'))

  const showAll = getByRole('button', { name: 'Show all' })
  assert.equal(showAll.hasAttribute('aria-pressed'), false, 'a button whose label changes must not also expose a pressed state')
  fireEvent.click(showAll)
  const collapse = getByRole('button', { name: 'Collapse all' })
  assert.equal(collapse.hasAttribute('aria-pressed'), false)
  assert.equal(queryByRole('button', { name: 'Show all' }), null)
  fireEvent.click(collapse)
  getByRole('button', { name: 'Show all' })

  fireEvent.keyDown(dialog, { key: 'Escape' })
  assert.equal(closed, 1)
})

test('LinkPanel: lists the messages oldest first and each long entry expands on its own button', () => {
  const { agents, link } = longLink()
  const { getByRole, getAllByRole } = render(<LinkPanel link={link} agents={agents} onClose={() => {}} />)
  const list = getByRole('list', { name: 'Messages, oldest first' })
  assert.equal(list.querySelectorAll('li').length, 2)
  const more = getAllByRole('button', { name: 'Show more' })
  assert.equal(more.length, 1)
  assert.equal(more[0].getAttribute('aria-expanded'), 'false')
  fireEvent.click(more[0])
  assert.equal(getAllByRole('button', { name: 'Show less' })[0].getAttribute('aria-expanded'), 'true')
})

function listFixture() {
  const teams = new Map([['alpha', { name: 'alpha', leadSessionId: 's1', members: [] }]])
  const agents = map(
    agent({ id: 's1:lead', name: 'Lead', isMain: true }),
    agent({ id: 's1:alice', name: 'Alice', kind: 'teammate', teamName: 'alpha', activity: 'working', x: 60 }),
    agent({ id: 's2:main', sessionId: 's2', name: 'Other', isMain: true, x: 900 }),
  )
  const link: any = {
    id: 'L1', from: 's1:lead', to: 's1:alice', kind: 'teammate', sessionId: 's1', dropped: 0,
    messages: [{ id: 'm1', type: 'message', content: 'hi', timestamp: 1, from: 's1:lead', to: 's1:alice' }],
  }
  const model = buildA11yModel(agents, new Map(), [], new Map(), {
    teams: teams as any, links: new Map([['L1', link]]), simTime: 1, sessions: new Map([['s2', { label: 'repo-two', workspace: 'w2' }]]),
  })
  return model
}

function renderList(over: Record<string, unknown> = {}) {
  const calls = { agents: [] as Array<string | null>, links: [] as string[], clusters: [] as string[] }
  const utils = render(
    <GraphA11yList
      model={listFixture()}
      communications={[]}
      announcements={[]}
      focusedNode={null}
      onAgentClick={id => calls.agents.push(id)}
      onLinkClick={id => calls.links.push(id)}
      onClusterClick={key => calls.clusters.push(key)}
      onFocusNode={() => {}}
      {...over}
    />,
  )
  return { ...utils, calls }
}

test('GraphA11yList: the orchestrator is announced as such, in a list grouped by team and session', () => {
  const { getByRole, getAllByRole } = renderList()
  assert.ok(getByRole('button', { name: /^Lead, orchestrator, / }))
  assert.ok(getByRole('button', { name: /^Other, orchestrator, / }))
  assert.equal(getAllByRole('button', { name: /^Alice, / }).length, 1)
  const headings = getAllByRole('heading', { level: 3 }).map(h => h.textContent)
  assert.ok(headings.includes('Team alpha'))
  assert.ok(headings.includes('Session repo-two'))
  const teamList = getByRole('list', { name: 'Agents of team alpha' })
  assert.equal(teamList.querySelectorAll(':scope > li').length, 2, 'lead and teammate sit under the team heading')
})

test('GraphA11yList click path: agent, link and cluster buttons call their callbacks', () => {
  const { getByRole, calls } = renderList({ selectedClusterKey: 'session:s2' })
  fireEvent.click(getByRole('button', { name: /^Alice, / }))
  assert.deepEqual(calls.agents, ['s1:alice'])
  fireEvent.click(getByRole('button', { name: /^Lead to Alice/ }))
  assert.deepEqual(calls.links, ['L1'])
  const zoom = getByRole('button', { name: 'Zoom to session repo-two' })
  assert.equal(zoom.getAttribute('aria-current'), 'true')
  fireEvent.click(zoom)
  fireEvent.click(getByRole('button', { name: 'Zoom to team alpha' }))
  assert.deepEqual(calls.clusters, ['session:s2', 'team:s1:alpha'])
})

test('GraphLegend: documents the orchestrator, the halos and the edge bubbles, and reuses the default team colour', () => {
  const { getByRole, getByText } = render(<GraphLegend teams={[]} />)
  fireEvent.click(getByRole('button', { name: /Legend/ }))
  assert.ok(getByText(/orchestrator/))
  assert.ok(getByText(/Dotted halo: session/))
  assert.ok(getByText(/Bubble on a link/))
  const strokes = Array.from(document.querySelectorAll('svg [stroke]')).map(e => e.getAttribute('stroke'))
  assert.ok(strokes.includes(teamDefaultColor()))
  assert.equal(document.body.innerHTML.includes('#b794f6'), true, 'the shared constant value is what is drawn')
})
