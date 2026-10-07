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
