import type { SimulationEvent } from './agent-types'
import type { SessionInfo } from './bridge-types'

// ─── Tour scenario (?scenario=tour) ──────────────────────────────────────────
// One demo that shows every feature of Agent Lens, in numbered acts (script: docs/demo.md).
// Three sessions, so that the Fleet / All view has something to group:
//   tour-payments  Claude Code, project payments-api  (acts 1, 2, 4, 5)
//   tour-release   Claude Code, same project (a worktree) running a Workflow  (act 3)
//   tour-docs      Codex, project docs-site  (act 6)
// Events are written act by act and sorted by time at the end: the player reads the array in order.

const PAYMENTS = 'tour-payments'
const RELEASE = 'tour-release'
const DOCS = 'tour-docs'

/** Files of the payments session carry absolute paths: a file conflict only compares absolute ones (a relative path may name two files). */
const ROOT = '/work/payments-api'

/** The three sessions, dated from `now` and not from a fixed instant: a fixed one reads "1062 d ago" and "1062d 22h" of
 *  runtime. Called when the demo seeds its sessions in the browser (after mount), never at module load: a module
 *  evaluated on the server, or long before the page is used, would date them from the wrong instant. */
export function tourSessions(now: number = Date.now()): SessionInfo[] {
  const START = now - 90_000
  return [
    { id: PAYMENTS, label: 'payments-api · refactor', status: 'active', startTime: START, lastActivityTime: START + 90_000, runtime: 'claude', workspace: 'payments-api', cwd: '/work/payments-api', projectId: 'proj-payments', projectName: 'payments-api' },
    { id: RELEASE, label: 'payments-api · release', status: 'active', startTime: START + 14_000, lastActivityTime: START + 90_000, runtime: 'claude', workspace: 'payments-api-release', cwd: '/work/payments-api-release', projectId: 'proj-payments', projectName: 'payments-api' },
    { id: DOCS, label: 'docs-site · Codex', status: 'active', startTime: START + 30_000, lastActivityTime: START + 90_000, runtime: 'codex', workspace: 'docs-site', cwd: '/work/docs-site', projectId: 'proj-docs', projectName: 'docs-site' },
  ]
}

type Payload = Record<string, unknown>
const events: SimulationEvent[] = []
const at = (sessionId: string) => (time: number, type: SimulationEvent['type'], payload: Payload) => {
  events.push({ time, type, payload, sessionId })
}
const p = at(PAYMENTS)
const r = at(RELEASE)
const d = at(DOCS)

const breakdown = (systemPrompt: number, userMessages: number, toolResults: number, reasoning: number, subagentResults: number) =>
  ({ systemPrompt, userMessages, toolResults, reasoning, subagentResults })

/** A tool round: start, then end after `dur` seconds. */
function tool(emit: ReturnType<typeof at>, time: number, dur: number, agent: string, name: string, args: string, end: Payload, inputData?: Payload) {
  emit(time, 'tool_call_start', { agent, tool: name, args, ...(inputData ? { inputData } : {}) })
  emit(time + dur, 'tool_call_end', { agent, tool: name, ...end })
}

// ── Act 1 · A session: agent, tools, sub-agents, models, permission, error and recovery ──
p(0.0, 'agent_spawn', { name: 'orchestrator', isMain: true, task: 'Waiting for instructions...', model: 'claude-opus-5-5', modelSource: 'configured' })
p(0.2, 'message', { agent: 'orchestrator', role: 'user', content: 'Refactor the payment system to support Stripe and PayPal, add webhook handling, and write integration tests' })
p(0.4, 'context_update', { agent: 'orchestrator', tokens: 2200, breakdown: breakdown(1500, 700, 0, 0, 0) })
p(0.8, 'model_detected', { agent: 'orchestrator', model: 'claude-opus-5-5' })
p(1.0, 'message', { agent: 'orchestrator', role: 'thinking', content: 'Multi-part task: refactor payments, add Stripe + PayPal, webhooks, tests. Understand the existing code first, then delegate the research.' })
p(2.0, 'message', { agent: 'orchestrator', content: 'I will analyze the codebase and plan the refactoring.' })
tool(p, 3.0, 0.3, 'orchestrator', 'Glob', 'src/**/*.ts', { result: '47 files matched', tokenCost: 500, tokenSource: 'reported' }, { pattern: 'src/**/*.ts' })
tool(p, 3.5, 0.3, 'orchestrator', 'Read', 'src/services/payment.ts', {
  result: 'payment.ts — 234 lines, legacy processor with direct Stripe v2 calls', tokenCost: 3500, tokenSource: 'reported',
}, { file_path: `${ROOT}/src/services/payment.ts` })
tool(p, 4.0, 0.3, 'orchestrator', 'Grep', '"stripe|paypal|payment" --type ts', {
  result: '28 matches in 9 files — concentrated in services/ and routes/', tokenCost: 700, tokenSource: 'reported',
}, { pattern: 'stripe|paypal|payment', type: 'ts' })
p(4.5, 'context_update', { agent: 'orchestrator', tokens: 9000, breakdown: breakdown(1500, 700, 4700, 2100, 0) })
tool(p, 5.0, 0.4, 'orchestrator', 'TodoWrite', 'planning implementation', { result: 'Todos updated — 8 items', tokenCost: 80, tokenSource: 'reported' }, {
  todos: [
    { content: 'Analyze existing payment code', status: 'completed', activeForm: 'Analyzing existing payment code' },
    { content: 'Research Stripe & PayPal APIs', status: 'in_progress', activeForm: 'Researching Stripe & PayPal APIs' },
    { content: 'Create payment gateway abstraction', status: 'pending', activeForm: 'Creating payment gateway abstraction' },
    { content: 'Add webhook handling', status: 'pending', activeForm: 'Adding webhook handling' },
    { content: 'Write integration tests', status: 'pending', activeForm: 'Writing integration tests' },
  ],
})

// Two sub-agents in parallel. 'explore' asked for opus and got sonnet: the pill reads "requested != actual"
p(6.0, 'message', { agent: 'orchestrator', content: 'Dispatching agents for parallel research and schema analysis...' })
p(6.2, 'subagent_dispatch', { parent: 'orchestrator', child: 'explore-agent', toolUseId: 'toolu_tour_explore', task: 'Deep-dive into payment flow and DB schema' })
p(6.2, 'subagent_dispatch', { parent: 'orchestrator', child: 'research-agent', toolUseId: 'toolu_tour_research', task: 'Research Stripe & PayPal API patterns' })
p(6.5, 'agent_spawn', { name: 'explore-agent', parent: 'orchestrator', toolUseId: 'toolu_tour_explore', task: 'Analyze payment flow and database schema', subagentType: 'explore', requestedModel: 'opus' })
p(6.5, 'agent_spawn', { name: 'research-agent', parent: 'orchestrator', toolUseId: 'toolu_tour_research', task: 'Research Stripe & PayPal integration patterns', subagentType: 'research', model: 'claude-sonnet-5-5', modelSource: 'configured' })
p(6.8, 'model_detected', { agent: 'explore-agent', model: 'claude-sonnet-5-5' })
p(6.8, 'context_update', { agent: 'explore-agent', tokens: 1800, breakdown: breakdown(1400, 400, 0, 0, 0) })
p(6.8, 'context_update', { agent: 'research-agent', tokens: 1800, breakdown: breakdown(1400, 400, 0, 0, 0) })
tool(p, 7.5, 0.3, 'explore-agent', 'Read', 'src/models/payment.model.ts', {
  result: 'Prisma schema: Payment { id, amount, currency, status, provider, customerId }', tokenCost: 1200, tokenSource: 'reported',
}, { file_path: `${ROOT}/src/models/payment.model.ts` })
tool(p, 8.0, 0.3, 'explore-agent', 'Grep', '"catch|error|throw" src/services/', {
  result: '15 matches — minimal error handling, no retry logic', tokenCost: 500, tokenSource: 'reported',
}, { pattern: 'catch|error|throw', path: 'src/services/' })
tool(p, 8.4, 0.3, 'explore-agent', 'Read', 'prisma/schema.prisma', {
  result: 'schema.prisma — 3 models: Payment, Customer, WebhookEvent', tokenCost: 900, tokenSource: 'reported',
}, { file_path: `${ROOT}/prisma/schema.prisma` })
p(8.5, 'context_update', { agent: 'explore-agent', tokens: 6500, breakdown: breakdown(1400, 400, 2500, 2200, 0) })
p(9.0, 'subagent_return', { child: 'explore-agent', parent: 'orchestrator', toolUseId: 'toolu_tour_explore', summary: 'Legacy Stripe v2 calls, Prisma Payment model, weak error handling, no webhooks', durationS: 2.8 })
p(9.0, 'agent_complete', { name: 'explore-agent' })
tool(p, 7.5, 2.5, 'research-agent', 'WebSearch', 'Stripe PaymentIntents Node.js TypeScript 2026', { result: '12 results — PaymentIntents is the recommended API', tokenCost: 2500, tokenSource: 'estimated' }, { query: 'Stripe PaymentIntents Node.js TypeScript 2026' })
tool(p, 10.2, 3.0, 'research-agent', 'WebFetch', 'stripe.com/docs/payments/accept-a-payment', { result: 'PaymentIntents flow: create intent, confirm client-side, handle webhooks', tokenCost: 4000, tokenSource: 'estimated' }, { url: 'https://stripe.com/docs/payments/accept-a-payment' })
p(13.5, 'context_update', { agent: 'research-agent', tokens: 12000, breakdown: breakdown(1400, 400, 8500, 1700, 0) })
p(14.0, 'subagent_return', { child: 'research-agent', parent: 'orchestrator', toolUseId: 'toolu_tour_research', summary: 'Stripe PaymentIntents + webhooks, PayPal Orders API v2, both have Node.js SDKs', durationS: 7.8 })
p(14.0, 'agent_complete', { name: 'research-agent' })
// While the sub-agents work, the orchestrator reads the same file again and runs the same Glob again, with no edit in
// between: Files & repeats lists both, with the tokens of the repeat only (the first call is not waste)
p(10.6, 'message', { agent: 'orchestrator', role: 'thinking', content: 'While they work, check the payment service and the file list once more.' })
tool(p, 11.0, 0.3, 'orchestrator', 'Read', 'src/services/payment.ts', {
  result: 'payment.ts — 234 lines, legacy processor with direct Stripe v2 calls', tokenCost: 3500, tokenSource: 'reported',
}, { file_path: `${ROOT}/src/services/payment.ts` })
tool(p, 11.5, 0.3, 'orchestrator', 'Glob', 'src/**/*.ts', { result: '47 files matched', tokenCost: 500, tokenSource: 'reported' }, { pattern: 'src/**/*.ts' })
p(14.3, 'context_update', { agent: 'orchestrator', tokens: 25000, breakdown: breakdown(1500, 700, 6500, 6300, 10000) })

// An MCP tool (cyan style, server badge) and a permission prompt before an install
tool(p, 15.0, 1.2, 'orchestrator', 'mcp__stripe__list_payment_intents', 'limit: 10', { result: '10 payment intents (7 succeeded, 2 pending, 1 failed)', tokenCost: 900, tokenSource: 'reported' })
p(15.5, 'tool_call_start', { agent: 'orchestrator', tool: 'WebFetch', args: 'stripe.com/docs/webhooks', inputData: { url: 'https://stripe.com/docs/webhooks' } })
p(17.0, 'permission_requested', { agent: 'orchestrator' })
tool(p, 19.0, 3.0, 'orchestrator', 'Bash', 'npm install stripe @paypal/checkout-server-sdk', { result: 'added 23 packages in 4.2s', tokenCost: 300, tokenSource: 'reported' }, { command: 'npm install stripe @paypal/checkout-server-sdk', description: 'Install Stripe and PayPal SDKs' })
tool(p, 22.3, 0.3, 'orchestrator', 'Write', 'src/services/payment-gateway.ts', {
  result: 'Created payment-gateway.ts — 112 lines, strategy pattern with retry logic', tokenCost: 300, tokenSource: 'reported',
}, { file_path: `${ROOT}/src/services/payment-gateway.ts` })
tool(p, 22.8, 0.3, 'orchestrator', 'Edit', 'src/services/payment.ts', { result: 'Refactored payment.ts — now goes through PaymentGateway', tokenCost: 350, tokenSource: 'reported' }, { file_path: `${ROOT}/src/services/payment.ts`, old_string: 'const stripe = require("stripe")(KEY)', new_string: 'import { PaymentGateway } from "./payment-gateway"' })

// A test-runner sub-agent: a failing run, a fix, a green run
p(24.0, 'subagent_dispatch', { parent: 'orchestrator', child: 'test-runner', toolUseId: 'toolu_tour_test', task: 'Write and run integration tests for the adapters and webhooks' })
p(24.3, 'agent_spawn', { name: 'test-runner', parent: 'orchestrator', toolUseId: 'toolu_tour_test', task: 'Write and run payment integration tests', subagentType: 'test', requestedModel: 'haiku' })
p(24.5, 'model_detected', { agent: 'test-runner', model: 'claude-haiku-5-5' })
tool(p, 24.8, 0.4, 'test-runner', 'Read', 'src/services/payment-gateway.ts', { result: 'payment-gateway.ts — 112 lines, GatewayAdapter interface', tokenCost: 700, tokenSource: 'reported' }, { file_path: `${ROOT}/src/services/payment-gateway.ts` })
tool(p, 25.5, 0.3, 'test-runner', 'Write', 'src/__tests__/stripe-adapter.test.ts', { result: 'Created stripe-adapter.test.ts — 8 test cases', tokenCost: 350, tokenSource: 'reported' }, { file_path: `${ROOT}/src/__tests__/stripe-adapter.test.ts` })
tool(p, 26.5, 4.0, 'test-runner', 'Bash', 'npm test -- --coverage', { result: 'FAIL: StripeAdapter > should handle API errors\nError: STRIPE_SECRET_KEY is not defined\n\n6 passed, 3 failed', tokenCost: 400, tokenSource: 'reported', isError: true, errorMessage: 'STRIPE_SECRET_KEY is not defined' }, { command: 'npm test -- --coverage' })
p(31.0, 'message', { agent: 'test-runner', role: 'thinking', content: 'The failing tests initialize the real Stripe SDK. A setup file must stub STRIPE_SECRET_KEY before any import.' })
tool(p, 32.0, 0.3, 'test-runner', 'Write', 'src/__tests__/setup.ts', { result: 'Created test setup with mock env vars', tokenCost: 180, tokenSource: 'reported' }, { file_path: `${ROOT}/src/__tests__/setup.ts` })
tool(p, 33.0, 4.0, 'test-runner', 'Bash', 'npm test -- --coverage', { result: 'Test Suites: 3 passed\nTests: 18 passed\nCoverage: 91.3% stmts', tokenCost: 400, tokenSource: 'reported' }, { command: 'npm test -- --coverage' })
p(37.3, 'context_update', { agent: 'test-runner', tokens: 8500, breakdown: breakdown(1400, 600, 3500, 3000, 0) })
p(37.5, 'subagent_return', { child: 'test-runner', parent: 'orchestrator', toolUseId: 'toolu_tour_test', summary: '18 tests passing with 91% coverage', durationS: 13.5 })
p(37.5, 'agent_complete', { name: 'test-runner' })
p(38.0, 'context_update', { agent: 'orchestrator', tokens: 48000, breakdown: breakdown(1500, 700, 12500, 16800, 16500) })
p(38.5, 'message', { agent: 'orchestrator', content: 'Tests pass. The payment gateway is in place; next, a small team takes the webhooks.' })
p(39.0, 'agent_idle', { name: 'orchestrator', turnEnd: true })

// ── Act 2 · An Agent Team and its Comms: teammates exchanging messages ──
p(40.0, 'team_info', { teamName: 'payments-squad', leadSessionId: PAYMENTS, leadName: 'orchestrator', members: [
  { name: 'api-dev', agentType: 'backend', color: '#4cc9f0' },
  { name: 'qa-dev', agentType: 'qa', color: '#f9c74f' },
] })
p(40.2, 'agent_spawn', { name: 'api-dev', parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', color: '#4cc9f0', agentType: 'backend', task: 'Implement the webhook endpoints', model: 'claude-sonnet-5-5', modelSource: 'configured' })
p(40.4, 'agent_spawn', { name: 'qa-dev', parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', color: '#f9c74f', agentType: 'qa', task: 'Verify the webhooks end to end', model: 'claude-sonnet-5-5', modelSource: 'configured' })
p(40.6, 'agent_link', { from: 'orchestrator', to: 'api-dev', kind: 'spawn', content: 'Take the Stripe webhooks: signature check + payment_intent.* events.' })
p(40.8, 'agent_link', { from: 'orchestrator', to: 'qa-dev', kind: 'spawn', content: 'Once api-dev is done, replay a tampered payload and a valid one.' })
tool(p, 41.5, 0.4, 'api-dev', 'Write', 'src/webhooks/stripe-webhook.ts', { result: 'Created stripe-webhook.ts — 67 lines', tokenCost: 200, tokenSource: 'reported' }, { file_path: `${ROOT}/src/webhooks/stripe-webhook.ts` })
// api-dev wires its handler into the file the orchestrator refactored: two agents, one file, both edits succeeded
tool(p, 42.2, 0.4, 'api-dev', 'Edit', 'src/services/payment.ts', { result: 'Exported handleStripeWebhook from payment.ts', tokenCost: 240, tokenSource: 'reported' }, {
  file_path: `${ROOT}/src/services/payment.ts`, old_string: 'import { PaymentGateway } from "./payment-gateway"', new_string: 'import { PaymentGateway } from "./payment-gateway"\nexport { handleStripeWebhook } from "../webhooks/stripe-webhook"',
})
p(43.0, 'message_sent', { from: 'api-dev', to: 'qa-dev', kind: 'teammate', content: 'Webhook handler is in. It rejects bad signatures with SIGNATURE_MISMATCH.' })
p(43.1, 'agent_activity', { name: 'api-dev', activity: 'idle' })
p(43.2, 'agent_activity', { name: 'qa-dev', activity: 'working' })
tool(p, 44.0, 2.5, 'qa-dev', 'Bash', 'node scripts/replay-webhook.js --tampered', { result: 'Tampered payload rejected: SIGNATURE_MISMATCH', tokenCost: 260, tokenSource: 'reported' }, { command: 'node scripts/replay-webhook.js --tampered' })
p(47.0, 'message_sent', { from: 'qa-dev', to: 'api-dev', kind: 'teammate', content: 'Tampered payload is rejected as expected. One thing: log the event id on rejection.' })
p(47.2, 'message_sent', { from: 'qa-dev', to: 'orchestrator', kind: 'teammate', content: 'Webhooks verified, one logging suggestion sent to api-dev.' })
p(47.4, 'agent_activity', { name: 'api-dev', activity: 'working' })
p(49.0, 'agent_activity', { name: 'api-dev', activity: 'done' })
p(49.2, 'agent_activity', { name: 'qa-dev', activity: 'done' })

// ── Act 3 · A Workflow with phases, in a second session of the same project ──
const WORKFLOW_MEMBERS = [
  { name: 'plan-a', phase: 'Plan' }, { name: 'plan-b', phase: 'Plan' },
  { name: 'build-a', phase: 'Build' }, { name: 'build-b', phase: 'Build' }, { name: 'build-c', phase: 'Build' },
]
r(14.0, 'agent_spawn', { name: 'release-lead', isMain: true, task: 'Run the release workflow', model: 'claude-opus-5-5', modelSource: 'configured' })
WORKFLOW_MEMBERS.forEach((m, i) => {
  r(14.3 + i * 0.1, 'agent_spawn', { name: m.name, kind: 'teammate', teamName: 'release', teamKind: 'workflow', parent: 'release-lead', task: `${m.phase} step` })
})
// The phases are announced after the members appeared: the layout must follow
r(15.0, 'team_info', { teamName: 'release', teamKind: 'workflow', leadSessionId: RELEASE, members: WORKFLOW_MEMBERS })
r(16.0, 'agent_activity', { name: 'plan-a', activity: 'working' })
r(16.0, 'agent_activity', { name: 'plan-b', activity: 'working' })
tool(r, 16.5, 1.5, 'plan-a', 'Read', 'CHANGELOG.md', { result: 'Unreleased: 4 entries', tokenCost: 600, tokenSource: 'reported' }, { file_path: 'CHANGELOG.md' })
tool(r, 16.8, 1.5, 'plan-b', 'Grep', 'TODO release', { result: '2 matches', tokenCost: 200, tokenSource: 'reported' }, { pattern: 'TODO release' })
r(19.0, 'agent_activity', { name: 'plan-a', activity: 'done' })
r(19.2, 'agent_activity', { name: 'plan-b', activity: 'done' })
r(19.5, 'agent_activity', { name: 'build-a', activity: 'working' })
r(19.6, 'agent_activity', { name: 'build-b', activity: 'working' })
tool(r, 20.0, 3.0, 'build-a', 'Bash', 'pnpm build', { result: 'Build OK', tokenCost: 300, tokenSource: 'reported' }, { command: 'pnpm build' })
tool(r, 20.5, 4.0, 'build-b', 'Bash', 'pnpm pack', { result: 'agent-lens-1.0.0.tgz', tokenCost: 250, tokenSource: 'reported' }, { command: 'pnpm pack' })

// ── Act 4 · Honest values: what Agent Lens does not know, it says ──
// A usage for a name that matches no agent (unattributed), and a teammate that never produced any event.
// (The tool whose end is never received starts at 16 s in act 1: it only expires after the shortest delay,
// 1 min, so it must start early enough to expire before the playback stops.)
p(52.0, 'tool_call_end', { agent: 'ghost-agent', tool: 'Read', result: 'usage reported for an agent that was never announced', tokenCost: 1800, tokenSource: 'reported' })
p(52.5, 'agent_spawn', { name: 'silent-agent', parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', agentType: 'docs', task: 'Announced, nothing observed yet' })

// ── Act 4b · A loop and a compaction: a sub-agent re-runs the same failing command, its context fills, then is compacted ──
// Exactly REPEAT_THRESHOLD (3) identical calls in a row, each failing: that is the whole proof of the loop, nothing is forced.
// The three logs weigh 176k tokens, so the context reaches 183k of 200k; the runtime then compacts it (auto, size before reported).
p(49.8, 'message', { agent: 'orchestrator', content: 'Lint still fails on the payments package. Handing it to a sub-agent.' })
p(50.0, 'subagent_dispatch', { parent: 'orchestrator', child: 'lint-fixer', toolUseId: 'toolu_tour_lint', task: 'Make pnpm lint pass on the payments package' })
p(50.3, 'agent_spawn', { name: 'lint-fixer', parent: 'orchestrator', toolUseId: 'toolu_tour_lint', task: 'Make pnpm lint pass on the payments package', subagentType: 'lint', model: 'claude-sonnet-5-5', modelSource: 'configured' })
p(50.5, 'context_update', { agent: 'lint-fixer', tokens: 1800, breakdown: breakdown(1400, 400, 0, 0, 0) })
const LINT_FAILURE = { result: 'ESLint: no configuration file found for packages/payments (log: 1,204 lines)', isError: true, errorMessage: 'ESLint: no configuration file found for packages/payments' }
const LINT_CALL = { command: 'pnpm lint --filter payments' }
tool(p, 51.0, 1.5, 'lint-fixer', 'Bash', 'pnpm lint --filter payments', { ...LINT_FAILURE, tokenCost: 52000, tokenSource: 'reported' }, LINT_CALL)
p(52.6, 'context_update', { agent: 'lint-fixer', tokens: 55000, breakdown: breakdown(1400, 400, 52000, 1200, 0) })
tool(p, 53.5, 1.5, 'lint-fixer', 'Bash', 'pnpm lint --filter payments', { ...LINT_FAILURE, tokenCost: 58000, tokenSource: 'reported' }, LINT_CALL)
p(55.1, 'context_update', { agent: 'lint-fixer', tokens: 115000, breakdown: breakdown(1400, 400, 110000, 3200, 0) })
tool(p, 56.0, 1.5, 'lint-fixer', 'Bash', 'pnpm lint --filter payments', { ...LINT_FAILURE, tokenCost: 66000, tokenSource: 'reported' }, LINT_CALL)
p(57.6, 'context_update', { agent: 'lint-fixer', tokens: 183000, breakdown: breakdown(1400, 400, 176000, 5200, 0) })
p(58.0, 'context_compacted', { agent: 'lint-fixer', trigger: 'auto', preTokens: 183000 })
p(58.1, 'context_update', { agent: 'lint-fixer', tokens: 21000, breakdown: breakdown(1400, 19600, 0, 0, 0) })
p(59.0, 'message', { agent: 'lint-fixer', role: 'thinking', content: 'The same ESLint error three times: a config is missing, retrying will not change it. Report back instead of a fourth run.' })
p(60.0, 'subagent_return', { child: 'lint-fixer', parent: 'orchestrator', toolUseId: 'toolu_tour_lint', summary: 'Gave up after 3 identical failures: pnpm lint finds no ESLint config for packages/payments. A human has to choose which config it extends.', durationS: 9.7, durationSource: 'recorded' })
p(60.0, 'agent_complete', { name: 'lint-fixer' })

// ── Act 5 · Wrap-up of the first session ──
p(61.5, 'message', { agent: 'orchestrator', content: 'Payment system refactored: Stripe and PayPal adapters behind one gateway, webhooks with signature checks, 18 passing tests. Lint needs a config decision.' })
p(62.5, 'agent_complete', { name: 'orchestrator' })
r(60.0, 'message', { agent: 'release-lead', content: 'Release artifacts built.' })
r(61.0, 'agent_activity', { name: 'build-a', activity: 'done' })
r(61.2, 'agent_activity', { name: 'build-b', activity: 'done' })
r(61.4, 'agent_activity', { name: 'build-c', activity: 'working' })
r(72.0, 'tool_call_start', { agent: 'build-c', tool: 'Bash', args: 'pnpm publish --dry-run', inputData: { command: 'pnpm publish --dry-run' } })
r(78.0, 'tool_call_end', { agent: 'build-c', tool: 'Bash', result: 'Dry run OK: agent-lens@1.0.0', tokenCost: 280, tokenSource: 'reported' })
r(79.0, 'agent_activity', { name: 'build-c', activity: 'done' })
r(82.0, 'message', { agent: 'release-lead', content: 'Release ready: build, pack and dry-run publish all pass.' })
r(84.0, 'agent_complete', { name: 'release-lead' })

// ── Act 6 · A Codex session: authoritative token counts, reasoning effort ──
d(30.0, 'agent_spawn', { name: 'codex', isMain: true, runtime: 'codex', task: 'Update the API reference for the new gateway', model: 'gpt-5-codex', modelSource: 'configured', effort: 'medium' })
d(30.3, 'message', { agent: 'codex', role: 'user', content: 'Update the API reference for the new payment gateway' })
d(30.8, 'model_detected', { agent: 'codex', model: 'gpt-5-codex', effort: 'high' })
d(31.0, 'context_update', { agent: 'codex', tokens: 5200, tokensMax: 272000, breakdown: breakdown(3000, 400, 0, 1800, 0) })
d(32.0, 'message', { agent: 'codex', role: 'thinking', content: 'List the pages that mention the payment service, then rewrite the reference page.' })
tool(d, 33.0, 0.6, 'codex', 'shell', 'rg -l payment docs/', { result: 'docs/api/payments.md\ndocs/guides/checkout.md', tokenCost: 420, tokenSource: 'reported' }, { command: 'rg -l payment docs/' })
tool(d, 34.0, 1.2, 'codex', 'apply_patch', 'docs/api/payments.md', {
  result: 'Updated docs/api/payments.md: +42 -11', tokenCost: 900, tokenSource: 'reported',
}, { path: 'docs/api/payments.md' })
d(36.0, 'context_update', { agent: 'codex', tokens: 9800, tokensMax: 272000, breakdown: breakdown(3000, 400, 1320, 5080, 0) })
d(38.0, 'message', { agent: 'codex', content: 'Reference page updated. Building the docs to check the links.' })
tool(d, 40.0, 6.0, 'codex', 'shell', 'pnpm docs:build', { result: 'Build OK, 0 broken links', tokenCost: 380, tokenSource: 'reported' }, { command: 'pnpm docs:build' })
d(47.0, 'context_update', { agent: 'codex', tokens: 12400, tokensMax: 272000, breakdown: breakdown(3000, 400, 1700, 7300, 0) })
tool(d, 50.0, 0.8, 'codex', 'apply_patch', 'docs/guides/checkout.md', { result: 'Updated docs/guides/checkout.md: +9 -3', tokenCost: 640, tokenSource: 'reported' }, { path: 'docs/guides/checkout.md' })
tool(d, 56.0, 5.0, 'codex', 'shell', 'pnpm docs:lint', { result: 'Lint OK', tokenCost: 210, tokenSource: 'reported' }, { command: 'pnpm docs:lint' })
d(66.0, 'message', { agent: 'codex', content: 'The API reference and checkout guide now document the gateway and both adapters.' })
d(68.0, 'agent_idle', { name: 'codex', turnEnd: true })

export const TOUR_SCENARIO: SimulationEvent[] = events
  .map((e, i) => ({ e, i }))
  .sort((a, b) => a.e.time - b.e.time || a.i - b.i)
  .map(({ e }) => e)
