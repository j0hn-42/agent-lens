// #381: in the Sessions panel the marker of an agent row has one shape per state, so a state is never told apart by its
// colour alone, nor by the pulse (gone under prefers-reduced-motion). Thinking, calling a tool and waiting for permission
// used to be the same filled disc, idle and paused the same ring.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { STATE_MARKER_SHAPE } from '@/lib/canvas-constants'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => cleanup())

const T0 = Date.now()
const noop = () => {}
const STATES = ['idle', 'thinking', 'tool_calling', 'waiting_permission', 'paused', 'complete', 'error'] as const
const sessions: SessionInfo[] = [{ id: 's', label: 'Session', status: 'active', startTime: 0, lastActivityTime: 1 }]

function renderPanel() {
  const agents = new Map(STATES.map((state, i) => [`s:${state}`, {
    id: `s:${state}`, sessionId: 's', parentKey: null, name: `agent-${state}`, state, tokensUsed: 1, spawnTime: i + 1, lastEventAt: T0,
  }] as const))
  return render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={agents} selectedAgentId={null} onSelectAgent={noop}
      now={T0} observedSessionIds={new Set(['s'])}
    />,
  )
}

function markerOf(container: HTMLElement, state: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('ul[aria-label^="Agents of"] button')).find(b => b.textContent?.includes(`agent-${state}`))
  assert.ok(row, `row of the ${state} agent`)
  const marker = row.querySelector<HTMLElement>('[data-state-marker]')
  assert.ok(marker, `${state}: the row has a state marker`)
  return marker
}

test('every agent state has its own marker shape in the session list (WCAG 1.4.1)', () => {
  const { container } = renderPanel()
  const shapes = new Map<string, string>()
  for (const state of STATES) {
    const marker = markerOf(container, state)
    assert.equal(marker.getAttribute('aria-hidden'), 'true', `${state}: decorative, the row says the state in words`)
    assert.equal(marker.dataset.stateMarker, STATE_MARKER_SHAPE[state], `${state}: drawn with the shape the table gives it`)
    shapes.set(state, marker.dataset.stateMarker!)
  }
  assert.equal(new Set(shapes.values()).size, STATES.length, `one shape per state: ${JSON.stringify(Object.fromEntries(shapes))}`)
})

test('without the pulse, waiting for permission still differs from a tool call, thinking from both', () => {
  const { container } = renderPanel()
  const look = (state: string) => {
    const m = markerOf(container, state)
    return `${m.className.replace(/\bmotion-safe:animate-pulse\b/, '').replace(/\s+/g, ' ').trim()}|${m.textContent}`
  }
  assert.notEqual(look('waiting_permission'), look('tool_calling'))
  assert.notEqual(look('thinking'), look('tool_calling'))
  assert.notEqual(look('thinking'), look('waiting_permission'))
  assert.notEqual(look('idle'), look('paused'))
})
