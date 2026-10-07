// Fixed UI vocabulary (issue #32). Every panel title, aria-label, tooltip and empty state takes its words
// from here, so one thing never has two names. Pure data: no React and no path-alias imports (node:test).

/** The panels of the app, under the one name each is called everywhere. */
export const PANEL_NAMES = {
  conversation: 'Conversation',
  files: 'Files',
  timeline: 'Timeline',
  cost: 'Cost',
} as const

export type PanelKey = keyof typeof PANEL_NAMES

/** Terms of the agent hierarchy: Session > Agent (Main / Lead) > Subagent / Teammate. */
export const HIERARCHY_TERMS = {
  session: 'Session',
  agent: 'Agent',
  main: 'Main',
  lead: 'Lead',
  subagent: 'Subagent',
  teammate: 'Teammate',
} as const

/** The hierarchy as a sentence fragment, for help text. */
export const HIERARCHY_TEXT = `${HIERARCHY_TERMS.session} > ${HIERARCHY_TERMS.agent} (${HIERARCHY_TERMS.main} / ${HIERARCHY_TERMS.lead}) > ${HIERARCHY_TERMS.subagent} / ${HIERARCHY_TERMS.teammate}`

/** The one empty-state wording of the app: "No <things> yet". */
export function emptyState(things: string): string {
  return `No ${things} yet`
}

/** Empty state of a search / filter that matches nothing. */
export function emptyMatch(things: string): string {
  return `No matching ${things}`
}

/** Accessible name of the control that opens a panel, with its shortcut. */
export function openPanelLabel(panel: PanelKey, shortcut?: string): string {
  return shortcut ? `${PANEL_NAMES[panel]} (${shortcut})` : PANEL_NAMES[panel]
}

/** Labels of the Conversation panel (title, pill, controls). */
export const CONVERSATION_LABELS = {
  title: PANEL_NAMES.conversation,
  /** Collapsed pill: opens the panel */
  open: `Open ${PANEL_NAMES.conversation}`,
  close: `Close ${PANEL_NAMES.conversation}`,
  /** Top bar button: visible text, aria-label and tooltip */
  buttonText: PANEL_NAMES.conversation,
  buttonLabel: openPanelLabel('conversation', 'C'),
  tablist: 'Filter messages by agent',
  search: 'Search messages',
  empty: emptyState('messages'),
  emptySearch: emptyMatch('messages'),
} as const

/**
 * UI vocabulary for grouped agents. Hierarchy: Session > Workflow > Agent. "Team" stays reserved for
 * Agent Teams (Claude Code's TeamCreate), whose members are called teammates.
 * Pure: no React, no DOM; relative imports only so node:test can load it.
 */

/** What a group of agents is: an Agent Team or one run of the Workflow tool. */
export type GroupKind = 'team' | 'workflow'

/** Unknown / missing values are plain teams (the historical default). */
export function normalizeGroupKind(v: unknown): GroupKind {
  return v === 'workflow' ? 'workflow' : 'team'
}

export const GROUP_NOUN: Readonly<Record<GroupKind, string>> = { team: 'Team', workflow: 'Workflow' }

/** "Team" | "Workflow" */
export function groupNoun(kind: GroupKind | undefined): string {
  return GROUP_NOUN[normalizeGroupKind(kind)]
}

/** "team" | "workflow" */
export function groupNounLower(kind: GroupKind | undefined): string {
  return groupNoun(kind).toLowerCase()
}

/** Member noun of a group: "member(s)" for a team, "agent(s)" for a workflow. */
export function memberNoun(kind: GroupKind | undefined, count = 1): string {
  const base = normalizeGroupKind(kind) === 'workflow' ? 'agent' : 'member'
  return count === 1 ? base : `${base}s`
}

/** "Workflow tempo-wave-a" / "Team alpha" */
export function groupHeading(kind: GroupKind | undefined, title: string): string {
  return `${groupNoun(kind)} ${title}`
}
