/**
 * Every entry of the graph legend (graph-legend.tsx), by section. The legend renders each one with
 * `data-legend-entry`, and the guided tour must explain each one (scripts/guided-steps.test.ts).
 */
export const LEGEND_ENTRIES = {
  states: ['state-idle', 'state-thinking', 'state-tool_calling', 'state-waiting_permission', 'state-error', 'state-paused', 'state-complete'],
  shapes: ['shape-main', 'shape-sub', 'shape-tool', 'shape-discovery', 'shape-complete'],
  edges: ['edge-parent', 'edge-unverified', 'edge-tool', 'edge-badge-hidden', 'edge-badge-active', 'particle-dispatch', 'particle-return'],
  teams: ['team-ring', 'team-idle', 'team-working', 'team-done', 'team-archived', 'team-halo', 'session-halo', 'orchestrator', 'team-row'],
  links: ['link-flight', 'link-recent', 'link-error', 'link-quiet', 'link-bubble'],
  context: ['ctx-system', 'ctx-user', 'ctx-tool-results', 'ctx-reasoning', 'ctx-subagent'],
  discoveries: ['disc-file', 'disc-pattern', 'disc-finding', 'disc-code'],
  runtime: ['rt-claude', 'rt-codex'],
} as const

export type LegendSectionId = keyof typeof LEGEND_ENTRIES
export type LegendEntryId = (typeof LEGEND_ENTRIES)[LegendSectionId][number]

export const LEGEND_ENTRY_IDS: readonly LegendEntryId[] = Object.values(LEGEND_ENTRIES).flat() as LegendEntryId[]
