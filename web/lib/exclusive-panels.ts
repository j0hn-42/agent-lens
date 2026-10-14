/**
 * Selecting an agent opens its Conversation tab (#370) only when it would not replace a panel the user opened
 * (Files and Context share the right dock with Conversation; Cost is an independent overlay), and not on a narrow
 * viewport where panels are one-at-a-time sheets (#116).
 */
export function shouldAutoOpenConversation(
  open: { files: boolean; context: boolean },
  viewportW: number,
  sheetBreakpoint: number,
): boolean {
  return viewportW >= sheetBreakpoint && !open.files && !open.context
}
