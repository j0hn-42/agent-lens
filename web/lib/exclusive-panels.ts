/**
 * Which side panels may be open together (#370). Files, Conversation and Context share the right dock and are
 * mutually exclusive; Cost is an overlay and is independent, like Stats.
 */
export interface PanelFlags { files: boolean; conversation: boolean; context: boolean; cost: boolean }
export type ExclusivePanel = 'files' | 'conversation' | 'context'

const NO_DOCK: Pick<PanelFlags, ExclusivePanel> = { files: false, conversation: false, context: false }

export function togglePanelFlags(flags: PanelFlags, panel: ExclusivePanel | 'cost'): PanelFlags {
  if (panel === 'cost') return { ...flags, cost: !flags.cost }
  return { ...flags, ...NO_DOCK, [panel]: !flags[panel] }
}

export function openConversationFlags(flags: PanelFlags): PanelFlags {
  return { ...flags, ...NO_DOCK, conversation: true }
}

/**
 * Selecting an agent opens its Conversation tab only when it would not replace a panel the user opened, and not
 * on a narrow viewport where panels are one-at-a-time sheets (#116).
 */
export function shouldAutoOpenConversation(flags: PanelFlags, viewportW: number, sheetBreakpoint = 900): boolean {
  return viewportW >= sheetBreakpoint && !flags.files && !flags.context
}
