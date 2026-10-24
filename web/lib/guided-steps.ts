import type { LegendEntryId } from './legend-entries'
import { translate, type Locale, type MessageKey } from './messages'

export type TourTarget =
  | { kind: 'dom'; id: string }
  | { kind: 'agent'; name: string }
  /** A real agent, by its key (`<session>:<name>`): names are not unique in a live session */
  | { kind: 'agent-key'; key: string }
  | { kind: 'none' }

/** A step of a tour: what it points at and says. The demo adds a scenario time, a live session has none. */
export interface TourStep {
  id: string
  target: TourTarget
  /** Opens the graph legend while this step is shown (without touching the saved preference) */
  opensLegend?: boolean
  title: string
  body: string
  /** Legend entries this step explains (every entry must be covered, scripts/guided-steps.test.ts) */
  covers: readonly LegendEntryId[]
}

export interface GuidedStep extends TourStep {
  /** Scenario time to seek to (web/lib/guided-scenario.ts) */
  time: number
}

/** Entries no event can produce in a demo: explained in words only, and the text must say so. */
export const DESCRIBED_ONLY: readonly LegendEntryId[] = [
  'particle-dispatch', 'particle-return',
  'state-paused', 'state-error', 'edge-unverified', 'edge-file-conflict', 'edge-badge-hidden', 'edge-badge-active', 'link-error', 'session-halo',
  'shape-discovery', 'disc-file', 'disc-pattern', 'disc-finding', 'disc-code',
  'rt-copilot', 'rt-pi', 'rt-gemini', 'rt-opencode',
  'mark-loop', 'mark-repeated',
]

// A main agent is labelled by its first prompt (cut to 40 characters), not by the name in the events.
const ORCHESTRATOR = 'Refactor the payment system to support S'
const CODEX = 'Update the API reference for the new pay'

const STEP_DEFS: readonly Omit<GuidedStep, 'title' | 'body'>[] = [
  { id: 'welcome', time: 1.5, target: { kind: 'agent', name: ORCHESTRATOR },
    covers: ['shape-main', 'state-thinking', 'rt-claude'] },
  { id: 'tools', time: 3.2, target: { kind: 'agent', name: ORCHESTRATOR },
    covers: ['state-tool_calling', 'shape-tool', 'edge-tool'] },
  { id: 'subagent', time: 6.6, target: { kind: 'agent', name: 'explore-agent' },
    covers: ['shape-sub', 'edge-parent', 'particle-dispatch'] },
  { id: 'return', time: 9.4, target: { kind: 'agent', name: 'explore-agent' },
    covers: ['particle-return', 'shape-complete', 'state-complete', 'team-archived'] },
  { id: 'context', time: 9.7, target: { kind: 'dom', id: 'legend-context' }, opensLegend: true,
    covers: ['ctx-system', 'ctx-user', 'ctx-tool-results', 'ctx-reasoning', 'ctx-subagent'] },
  { id: 'permission', time: 12.5, target: { kind: 'agent', name: ORCHESTRATOR },
    covers: ['state-waiting_permission'] },
  { id: 'error', time: 23.5, target: { kind: 'agent', name: 'test-runner' },
    covers: ['state-error'] },
  { id: 'team', time: 30.4, target: { kind: 'agent', name: 'api-dev' }, opensLegend: true,
    covers: ['state-idle', 'team-ring', 'team-working', 'team-idle', 'team-halo', 'orchestrator', 'team-row'] },
  { id: 'messages', time: 30.6, target: { kind: 'agent', name: 'qa-dev' },
    covers: ['link-flight', 'link-bubble'] },
  { id: 'messages-after', time: 36.5, target: { kind: 'agent', name: 'api-dev' },
    covers: ['link-recent', 'team-done'] },
  { id: 'runtimes', time: 39.0, target: { kind: 'agent', name: CODEX },
    covers: ['rt-codex'] },
  { id: 'quiet-links', time: 43.5, target: { kind: 'agent', name: 'api-dev' },
    covers: ['link-quiet'] },
  { id: 'not-in-demo', time: 44.5, target: { kind: 'dom', id: 'legend-edges' }, opensLegend: true,
    covers: ['state-paused', 'edge-unverified', 'edge-file-conflict', 'edge-badge-hidden', 'edge-badge-active', 'link-error', 'session-halo', 'shape-discovery', 'disc-file', 'disc-pattern', 'disc-finding', 'disc-code', 'rt-copilot', 'rt-pi', 'rt-gemini', 'rt-opencode', 'mark-loop', 'mark-repeated'] },
]

/**
 * The steps of the demo tour in a language. The words live in the message catalog (tour.step.<id>.title and .body),
 * the rest (scenario time, target, what each step covers) is the same in every language.
 */
export function guidedSteps(locale: Locale): readonly GuidedStep[] {
  return STEP_DEFS.map(def => ({
    ...def,
    title: translate(locale, `tour.step.${def.id}.title` as MessageKey),
    body: translate(locale, `tour.step.${def.id}.body` as MessageKey),
  }))
}
