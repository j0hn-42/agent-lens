import type { LegendEntryId } from './legend-entries'

export type TourTarget =
  | { kind: 'dom'; id: string }
  | { kind: 'agent'; name: string }
  | { kind: 'none' }

export interface GuidedStep {
  id: string
  /** Scenario time to seek to (web/lib/guided-scenario.ts) */
  time: number
  target: TourTarget
  /** Opens the graph legend while this step is shown (without touching the saved preference) */
  opensLegend?: boolean
  title: string
  body: string
  /** Legend entries this step explains (every entry must be covered, scripts/guided-steps.test.ts) */
  covers: readonly LegendEntryId[]
}

/** Entries no event can produce in a demo: explained in words only, and the text must say so. */
export const DESCRIBED_ONLY: readonly LegendEntryId[] = [
  'state-paused', 'edge-unverified', 'edge-badge-hidden', 'edge-badge-active', 'link-error', 'team-archived', 'session-halo',
  'shape-discovery', 'disc-file', 'disc-pattern', 'disc-finding', 'disc-code',
]

// A main agent is labelled by its first prompt (cut to 40 characters), not by the name in the events.
const ORCHESTRATOR = 'Refactor the payment system to support S'
const CODEX = 'Update the API reference for the new pay'

export const GUIDED_STEPS: readonly GuidedStep[] = [
  { id: 'welcome', time: 1.5, target: { kind: 'agent', name: ORCHESTRATOR }, title: 'Meet your agent',
    body: 'Each large hexagon is a main agent. This one is thinking: it has read your request and is planning. The Claude spark logo tells you its runtime.',
    covers: ['shape-main', 'state-thinking', 'rt-claude'] },
  { id: 'tools', time: 3.2, target: { kind: 'agent', name: ORCHESTRATOR }, title: 'Tool calls',
    body: 'Every tool the agent runs appears as a rounded card on a thin amber line. The agent is calling a tool right now.',
    covers: ['state-tool_calling', 'shape-tool', 'edge-tool'] },
  { id: 'subagent', time: 6.6, target: { kind: 'agent', name: 'explore-agent' }, title: 'Sub-agents',
    body: 'The main agent delegated a task: a small hexagon joined by a thick line. The purple dot is the task travelling to the sub-agent.',
    covers: ['shape-sub', 'edge-parent', 'particle-dispatch'] },
  { id: 'return', time: 9.4, target: { kind: 'agent', name: 'explore-agent' }, title: 'Results come back',
    body: 'A green dot carries the result back to the parent. The sub-agent is done: its outline is now dashed.',
    covers: ['particle-return', 'shape-complete', 'state-complete'] },
  { id: 'context', time: 9.7, target: { kind: 'dom', id: 'legend-context' }, opensLegend: true, title: 'Context usage',
    body: 'The context window fills up with five kinds of content. Each colour is one of them: the system prompt, your messages, tool results, reasoning and sub-agent results.',
    covers: ['ctx-system', 'ctx-user', 'ctx-tool-results', 'ctx-reasoning', 'ctx-subagent'] },
  { id: 'permission', time: 12.5, target: { kind: 'agent', name: ORCHESTRATOR }, title: 'Waiting for you',
    body: 'The agent asked for a permission and is blocked until you answer it in your terminal. Nothing is guessed: this state only appears when the agent really asked.',
    covers: ['state-waiting_permission'] },
  { id: 'error', time: 23.5, target: { kind: 'agent', name: 'test-runner' }, title: 'When something fails',
    body: 'A tool call failed (a missing environment variable) and the agent turned red. Open the card to read the exact error.',
    covers: ['state-error'] },
  { id: 'team', time: 30.4, target: { kind: 'agent', name: 'api-dev' }, opensLegend: true, title: 'Agent Teams',
    body: 'Teammates share a dashed halo and a coloured ring. An open arc means a teammate is working, a hollow ring that it is idle. The orchestrator carries a crown and a LEAD badge. The legend lists each team with its member count. A teammate that has not started yet is idle: a grey outline.',
    covers: ['state-idle', 'team-ring', 'team-working', 'team-idle', 'team-halo', 'orchestrator', 'team-row'] },
  { id: 'messages', time: 30.6, target: { kind: 'agent', name: 'qa-dev' }, title: 'Messages between agents',
    body: 'A long-dashed purple line is a message in flight; a bubble shows the latest message. Click a link to read the conversation.',
    covers: ['link-flight', 'link-bubble'] },
  { id: 'messages-after', time: 34.6, target: { kind: 'agent', name: 'api-dev' }, title: 'Quiet links and finished teammates',
    body: 'Once delivered a message line turns solid green, then fades to a thin quiet line with a count badge. A filled dot means the teammate is done.',
    covers: ['link-recent', 'link-quiet', 'team-done'] },
  { id: 'runtimes', time: 39.0, target: { kind: 'agent', name: CODEX }, title: 'Two runtimes',
    body: 'The knot logo is Codex; the spark is Claude. Both are drawn the same way, so you can compare them side by side.',
    covers: ['rt-codex'] },
  { id: 'not-in-demo', time: 44.5, target: { kind: 'dom', id: 'legend-edges' }, opensLegend: true, title: 'Seen only in a real session',
    body: 'Some legend entries are not shown in this demo because they depend on live conditions or on your clicks: a paused agent, an unverified parent link (dashed), a "+N" badge on a folded branch, a red error message link, an archived agent, the dotted session halo and the discovery cards (file, pattern, finding, code). Keep the legend open to recognise them later.',
    covers: ['state-paused', 'edge-unverified', 'edge-badge-hidden', 'edge-badge-active', 'link-error', 'team-archived', 'session-halo', 'shape-discovery', 'disc-file', 'disc-pattern', 'disc-finding', 'disc-code'] },
] as const
