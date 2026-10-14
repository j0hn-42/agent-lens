// Tooltip of a focused or hovered agent: a stale state is the last known one, like the canvas (#367)
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { describeTooltip } from '@/components/agent-visualizer/canvas/tooltip'

/* eslint-disable @typescript-eslint/no-explicit-any */
const sim = (a: Record<string, unknown>): any => ({
  agents: new Map([['a', { id: 'a', name: 'a', state: 'thinking', model: 'm', ...a }]]), toolCalls: new Map(), discoveries: [],
})
const node: any = { type: 'agent', id: 'a' }

test('a fresh agent shows its state, a stale one the last known state', () => {
  const fresh = describeTooltip(node, sim({ lastEventAt: Date.now() - 1_000, freshnessSource: 'live' }))!
  assert.ok(fresh.lines.some(l => /^State: Thinking/i.test(l)), fresh.lines.join('|'))
  const stale = describeTooltip(node, sim({ lastEventAt: Date.now() - 3_600_000, freshnessSource: 'live' }))!
  assert.ok(stale.lines.includes('State: last known state: Thinking'), stale.lines.join('|'))
})

test('a stale teammate is not described as working', () => {
  const t = describeTooltip(node, sim({ kind: 'teammate', teamName: 'core', lastEventAt: Date.now() - 3_600_000, freshnessSource: 'live' }))!
  assert.ok(!t.lines.some(l => /working/.test(l)), t.lines.join('|'))
})
