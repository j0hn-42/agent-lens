// #114 / #113: the context and session panels sit below the (wrapping) top bar, never over the buttons that open
// them, and are opaque so the bar's text does not show through.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { ProjectContextPanel } from '@/components/agent-visualizer/project-context-panel'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

test('context panel is placed by the dock layout (below the top bar) and has an opaque background', () => {
  const { container } = render(
    <ProjectContextPanel visible sessionId={null} unavailableReason="demo" fetchContext={async () => 'unavailable'} onClose={() => {}} />,
  )
  const card = container.querySelector<HTMLElement>('.glass-card')
  assert.ok(card)
  const panel = card.parentElement as HTMLElement
  // The dock layout reserves the measured top bar height (--topbar-h) above the right dock; the panel takes its rect from it
  assert.equal(panel.getAttribute('data-dock-panel'), 'files')
  assert.ok(Number.parseFloat(panel.style.top) > 0, `top is ${panel.style.top}`)
  assert.ok(card.style.background, 'inline opaque background overrides the translucent glass')
})

test('session list is offset by the top bar height and keeps a readable name on rows that carry a long status', () => {
  const noop = () => {}
  const sessions = [{ id: 's1', label: 'billing-service', status: 'active' as const, startTime: 1, lastActivityTime: 2 }]
  const agents = new Map<string, any>([['a1', { // eslint-disable-line @typescript-eslint/no-explicit-any
    id: 'a1', sessionId: 's1', parentId: null, name: 'orchestrator', state: 'tool_calling', tokensUsed: 28000, tokenStatus: 'partial',
    isMain: true, timeAlive: 1, toolCalls: 1, currentTool: 'x', lastEventAt: 1,
  }]])
  const { container } = render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={agents} selectedAgentId={null} onSelectAgent={noop} now={10_000}
    />,
  )
  const panel = container.querySelector<HTMLElement>('.glass-card')!.parentElement as HTMLElement
  assert.match(panel.style.top, /var\(--topbar-h/)
  const sessionRow = container.querySelector<HTMLElement>('[data-session-id]')!
  const agentRow = container.querySelector<HTMLElement>('ul[aria-label^="Agents of"] button')!
  for (const row of [sessionRow, agentRow]) {
    assert.match(row.className, /\bflex-wrap\b/, 'status and totals wrap under the name instead of squeezing it to nothing')
    const name = row.querySelector<HTMLElement>('.truncate')!
    assert.match(name.className, /min-w-\[\d+ch\]/, 'the name keeps a minimum width')
  }
})
