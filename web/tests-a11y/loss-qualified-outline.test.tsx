// #366: the screen-reader outline of the graph reads the same qualified numbers as the canvas (tool count, agent cost).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'

import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'
import type { Agent } from '@/lib/agent-types'

afterEach(cleanup)

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(id: string, sessionId: string, over: Record<string, unknown> = {}): Agent {
  return {
    id, agentKey: id, sessionId, name: id, state: 'idle', parentId: null, tokensUsed: 5_000_000, tokensMax: 200_000,
    tokenStatus: 'available', tokensEstimated: false, model: 'claude-sonnet-4',
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 13, timeAlive: 5, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: true, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  } as unknown as Agent
}

function outline(agents: Agent[], replayLost?: ReadonlyMap<string, number>): string {
  const model = buildA11yModel(new Map(agents.map(a => [a.id, a])), new Map(), [], new Map(), { replayLost })
  const { container } = render(createElement(GraphA11yList, {
    model, communications: [], announcements: [], focusedNode: null, onAgentClick: () => {}, onFocusNode: () => {},
  } as never))
  return container.textContent ?? ''
}

test('nothing lost: the outline reads as before (no noise)', () => {
  const text = outline([agent('s1:a', 's1')])
  assert.match(text, /13 tool calls\./)
  assert.doesNotMatch(text, /at least|incomplete/)
})

test('events lost for the agent\'s session: "at least N tool calls" and an incomplete cost (#591)', () => {
  const text = outline([agent('s1:a', 's1')], new Map([['s1', 6]]))
  assert.match(text, /at least 13 tool calls\./)
  assert.match(text, /context cost estimate \S+ \(incomplete\)/)
  assert.doesNotMatch(text, /context cost estimate at least/)
})

test('a zero count is "no tool call observed (incomplete)", never a clean zero', () => {
  const text = outline([agent('s1:a', 's1', { toolCalls: 0 })], new Map([['s1', 6]]))
  assert.match(text, /no tool call observed \(incomplete\)\./)
  assert.doesNotMatch(text, /\b0 tool calls/)
})

test('only the agent of the session that lost events is qualified', () => {
  const text = outline([agent('s1:a', 's1'), agent('s2:b', 's2')], new Map([['s1', 6]]))
  assert.equal((text.match(/at least 13 tool calls\./g) ?? []).length, 1)
  assert.equal((text.match(/(?<!at least )13 tool calls\./g) ?? []).length, 1)
})

test('the token line of an agent is the last reading, incomplete, when its session lost events (never "at least")', () => {
  const lossy = outline([agent('s1:a', 's1', { tokensUsed: 150_000 })], new Map([['s1', 6]]))
  assert.match(lossy, /150k \/ 200k tokens \(last reading, incomplete\)/)
  assert.doesNotMatch(lossy, /at least 150k/)
  const plain = outline([agent('s1:a', 's1', { tokensUsed: 150_000 })])
  assert.match(plain, /150k \/ 200k tokens/)
  assert.doesNotMatch(plain, /at least 150k/)
})

test('the heading of a session halo reads its cost as incomplete (no lower bound) when that session lost events (#591)', () => {
  // Two sessions: each gets a halo heading, and the agent rows follow it
  const text = outline([agent('s1:a', 's1'), agent('s2:b', 's2')], new Map([['s1', 6]]))
  // The agent of s1 and the halo of s1: two incomplete costs; the agent and the halo of s2 stay plain
  assert.equal((text.match(/context cost estimate \S+ \(incomplete\)/g) ?? []).length, 2, text)
  // Exactly the two plain costs of s2: the figure is matched whole, so it cannot give back a character to dodge the lookahead
  assert.equal((text.match(/context cost estimate \$[\d.]+(?! \(incomplete\)|[\d.])/g) ?? []).length, 2, text)
  assert.doesNotMatch(text, /context cost estimate at least/)
})
