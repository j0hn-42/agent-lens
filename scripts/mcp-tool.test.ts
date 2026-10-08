import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseMcpTool, formatToolName } from '../web/lib/mcp-tool'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { updateToolHistory } from '../web/components/agent-visualizer/canvas/a11y-model'
import { COLORS } from '../web/lib/colors'
import type { SimulationEvent } from '../web/lib/agent-types'

test('parseMcpTool splits server and tool', () => {
  assert.deepEqual(parseMcpTool('mcp__stripe__list_payment_intents'), { server: 'stripe', tool: 'list_payment_intents' })
  // server names can contain single underscores: split on the last `__`
  assert.deepEqual(parseMcpTool('mcp__claude_ai_Gmail__send_message'), { server: 'claude_ai_Gmail', tool: 'send_message' })
})

test('parseMcpTool returns null for native or malformed names', () => {
  for (const n of ['Read', 'Bash', 'mcp__', 'mcp__server', 'mcp__server__', 'mcp____tool', 'xmcp__a__b', '', undefined, null]) {
    assert.equal(parseMcpTool(n as string | undefined | null), null, String(n))
  }
})

test('formatToolName prettifies MCP names only', () => {
  assert.equal(formatToolName('mcp__stripe__refund'), 'stripe › refund')
  assert.equal(formatToolName('Read'), 'Read')
  assert.equal(formatToolName(undefined), '')
})

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { time: number }>): SimulationState {
  let state = createEmptyState()
  for (const e of events) {
    state = processEvent({ time: e.time, type: e.type, payload: e.payload }, { ...state, currentTime: e.time }, ctx)
  }
  return state
}

const spawn = { time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true } } as const

test('an MCP tool_call_start tags the node, the particle and uses the MCP color', () => {
  const s = run([spawn, { time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'mcp__stripe__refund', args: 'id: 1' } }])
  const tc = [...s.toolCalls.values()][0]
  assert.deepEqual(tc.mcp, { server: 'stripe', tool: 'refund' })
  const p = s.particles.find(x => x.type === 'tool_call')!
  assert.equal(p.mcp, true)
  assert.equal(p.color, COLORS.mcp)
})

test('a native tool stays amber and untagged', () => {
  const s = run([spawn, { time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'Read', args: 'a.ts' } }])
  const tc = [...s.toolCalls.values()][0]
  assert.equal(tc.mcp, undefined)
  const p = s.particles.find(x => x.type === 'tool_call')!
  assert.equal(p.mcp, undefined)
  assert.equal(p.color, COLORS.tool)
})

test('the a11y tool history names MCP tools explicitly', () => {
  const s = run([spawn, { time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'mcp__stripe__refund' } }])
  const hist = updateToolHistory(new Map(), s.toolCalls)
  assert.equal([...hist.values()][0].name, 'MCP tool stripe › refund')
})
