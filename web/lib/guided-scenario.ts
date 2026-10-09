import type { SimulationEvent } from './agent-types'

// ─── Guided scenario (?scenario=guided) ──────────────────────────────────────
// The scenario behind the step-by-step tour (web/lib/guided-steps.ts). Short (< 50 s) so that
// seekToTime replays it instantly, and written act by act so that every legend entry has a moment where it
// is on screen. Single implicit session, like the classic demo.

type Payload = Record<string, unknown>
const events: SimulationEvent[] = []
const at = (time: number, type: SimulationEvent['type'], payload: Payload) => { events.push({ time, type, payload }) }
const breakdown = (systemPrompt: number, userMessages: number, toolResults: number, reasoning: number, subagentResults: number) =>
  ({ systemPrompt, userMessages, toolResults, reasoning, subagentResults })

/** A tool round: start, then end after `dur` seconds. */
function tool(time: number, dur: number, agent: string, name: string, args: string, end: Payload, inputData?: Payload) {
  at(time, 'tool_call_start', { agent, tool: name, args, ...(inputData ? { inputData } : {}) })
  at(time + dur, 'tool_call_end', { agent, tool: name, ...end })
}

// ── Act A · The main agent: thinking, tools ──
at(0.0, 'agent_spawn', { name: 'orchestrator', isMain: true, task: 'Waiting for instructions...', model: 'claude-opus-5-5', modelSource: 'configured' })
at(0.2, 'message', { agent: 'orchestrator', role: 'user', content: 'Refactor the payment system to support Stripe and PayPal, add webhook handling, and write integration tests' })
at(0.4, 'context_update', { agent: 'orchestrator', tokens: 2200, breakdown: breakdown(1500, 700, 0, 0, 0) })
at(0.8, 'model_detected', { agent: 'orchestrator', model: 'claude-opus-5-5' })
at(1.0, 'message', { agent: 'orchestrator', role: 'thinking', content: 'Understand the existing payment code first, then delegate the research.' })
at(2.0, 'context_update', { agent: 'orchestrator', tokens: 3000, breakdown: breakdown(1500, 700, 0, 800, 0) })
tool(3.0, 0.3, 'orchestrator', 'Glob', 'src/**/*.ts', { result: '47 files matched', tokenCost: 500, tokenSource: 'reported' }, { pattern: 'src/**/*.ts' })
tool(3.5, 0.4, 'orchestrator', 'Read', 'src/services/payment.ts', {
  result: 'payment.ts — 234 lines, legacy processor with direct Stripe v2 calls', tokenCost: 3500, tokenSource: 'reported',
}, { file_path: 'src/services/payment.ts' })
tool(4.1, 0.4, 'orchestrator', 'Grep', '"stripe|paypal|payment" --type ts', {
  result: '28 matches in 9 files', tokenCost: 700, tokenSource: 'reported',
}, { pattern: 'stripe|paypal|payment', type: 'ts' })
at(4.6, 'context_update', { agent: 'orchestrator', tokens: 11500, breakdown: breakdown(1500, 700, 6500, 2800, 0) })

// ── Act B · A sub-agent: dispatch, own tools, result returned ──
at(6.0, 'subagent_dispatch', { parent: 'orchestrator', child: 'explore-agent', toolUseId: 'toolu_guided_explore', task: 'Deep-dive into the payment flow and the database schema' })
at(6.3, 'agent_spawn', { name: 'explore-agent', parent: 'orchestrator', toolUseId: 'toolu_guided_explore', task: 'Analyze payment flow and database schema' })
at(6.6, 'context_update', { agent: 'explore-agent', tokens: 1800, breakdown: breakdown(1400, 400, 0, 0, 0) })
tool(7.5, 0.4, 'explore-agent', 'Read', 'src/models/payment.model.ts', {
  result: 'Prisma schema: Payment { id, amount, currency, status, provider }', tokenCost: 1200, tokenSource: 'reported',
}, { file_path: 'src/models/payment.model.ts' })
tool(8.2, 0.4, 'explore-agent', 'Grep', '"catch|error|throw" src/services/', {
  result: '15 matches — minimal error handling, no retry logic', tokenCost: 500, tokenSource: 'reported',
}, { pattern: 'catch|error|throw', path: 'src/services/' })
at(9.2, 'subagent_return', { child: 'explore-agent', parent: 'orchestrator', toolUseId: 'toolu_guided_explore', summary: 'Legacy Stripe v2 calls, Prisma Payment model, weak error handling, no webhooks' })
at(9.2, 'agent_complete', { name: 'explore-agent' })
at(9.6, 'context_update', { agent: 'orchestrator', tokens: 24000, breakdown: breakdown(1500, 700, 8500, 4800, 8500) })

// ── Act C · A permission request ──
at(12.0, 'permission_requested', { agent: 'orchestrator' })
tool(14.0, 2.0, 'orchestrator', 'Bash', 'npm install stripe @paypal/checkout-server-sdk', { result: 'added 23 packages in 4.2s', tokenCost: 300, tokenSource: 'reported' }, { command: 'npm install stripe @paypal/checkout-server-sdk' })

// ── Act D · A failed tool call ──
at(18.0, 'subagent_dispatch', { parent: 'orchestrator', child: 'test-runner', toolUseId: 'toolu_guided_test', task: 'Run the test suite' })
at(18.3, 'agent_spawn', { name: 'test-runner', parent: 'orchestrator', toolUseId: 'toolu_guided_test', task: 'Run the integration tests' })
tool(20.0, 3.0, 'test-runner', 'Bash', 'npm test -- --coverage', {
  result: 'FAIL: StripeAdapter > should handle API errors\nError: STRIPE_SECRET_KEY is not defined\n\n6 passed, 3 failed',
  tokenCost: 400, tokenSource: 'reported', isError: true, errorMessage: 'STRIPE_SECRET_KEY is not defined',
}, { command: 'npm test -- --coverage' })
at(25.0, 'subagent_return', { child: 'test-runner', parent: 'orchestrator', toolUseId: 'toolu_guided_test', summary: '3 tests failing: STRIPE_SECRET_KEY is not defined' })
at(25.0, 'agent_complete', { name: 'test-runner' })

// ── Act E · An Agent Team: teammates and the messages between them ──
at(26.9, 'team_info', { teamName: 'payments-squad', leadSessionId: 'default', leadName: 'orchestrator', members: [
  { name: 'api-dev', agentType: 'backend', color: '#4cc9f0' },
  { name: 'qa-dev', agentType: 'qa', color: '#f9c74f' },
] })
at(27.0, 'agent_spawn', { name: 'api-dev', parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', color: '#4cc9f0', agentType: 'backend', task: 'Implement the webhook endpoints', model: 'claude-sonnet-5-5', modelSource: 'configured' })
at(27.2, 'agent_spawn', { name: 'qa-dev', parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', color: '#f9c74f', agentType: 'qa', task: 'Verify the webhooks end to end', model: 'claude-sonnet-5-5', modelSource: 'configured' })
at(27.4, 'agent_link', { from: 'orchestrator', to: 'api-dev', kind: 'spawn', content: 'Take the Stripe webhooks: signature check + payment_intent.* events.' })
at(27.6, 'agent_activity', { name: 'api-dev', activity: 'working' })
at(27.7, 'agent_activity', { name: 'qa-dev', activity: 'idle' })
at(30.0, 'message_sent', { from: 'api-dev', to: 'qa-dev', kind: 'teammate', content: 'Webhook handler is in. It rejects bad signatures with SIGNATURE_MISMATCH.' })
at(30.1, 'agent_activity', { name: 'api-dev', activity: 'idle' })
at(30.2, 'agent_activity', { name: 'qa-dev', activity: 'working' })
at(33.0, 'message_sent', { from: 'qa-dev', to: 'api-dev', kind: 'teammate', content: 'Tampered payload is rejected as expected.' })
at(34.0, 'agent_activity', { name: 'api-dev', activity: 'done' })
at(34.2, 'agent_activity', { name: 'qa-dev', activity: 'done' })

// ── Act F · A Codex agent (second runtime) ──
at(37.0, 'agent_spawn', { name: 'codex', isMain: true, runtime: 'codex', task: 'Update the API reference', model: 'gpt-5-codex', modelSource: 'configured', effort: 'medium' })
at(37.3, 'message', { agent: 'codex', role: 'user', content: 'Update the API reference for the new payment gateway' })
at(37.6, 'context_update', { agent: 'codex', tokens: 5200, tokensMax: 272000, breakdown: breakdown(3000, 400, 0, 1800, 0) })
tool(38.5, 2.0, 'codex', 'Read', 'docs/api.md', { result: 'api.md — 120 lines', tokenCost: 900, tokenSource: 'reported' }, { file_path: 'docs/api.md' })
at(41.5, 'agent_complete', { name: 'codex' })

// ── Act G · End ──
at(44.0, 'message', { agent: 'orchestrator', content: 'Payment system refactored. Webhooks verified by the team.' })
at(46.0, 'agent_complete', { name: 'orchestrator' })

export const GUIDED_SCENARIO: SimulationEvent[] = events.sort((a, b) => a.time - b.time)
