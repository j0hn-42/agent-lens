// Pure helpers shared by the message feed, transcript and tool content views.
// Kept free of React / path-alias imports so they can be unit tested with node:test.

// State labels live in state-labels.ts (single source of truth); re-exported for feed consumers.
export { STATE_LABELS, getStateLabel as stateLabel } from './state-labels'

/** Single empty-state wording used by every message list. */
export const EMPTY_MESSAGES = 'No messages yet'
export const EMPTY_SEARCH = 'No matching messages'

/**
 * Truncate text and report how many characters were hidden.
 * The marker is '… (+N chars)'.
 */
export function truncateWithMarker(text: string, max: number): { text: string; hidden: number; marker: string } {
  if (text.length <= max) return { text, hidden: 0, marker: '' }
  const hidden = text.length - max
  return { text: text.slice(0, max), hidden, marker: `… (+${hidden} chars)` }
}

/** Format simulation seconds as m:ss and an ISO-8601 duration for <time dateTime>. */
export function formatElapsed(seconds: number): { label: string; iso: string } {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(s)
  const m = Math.floor(whole / 60)
  const rem = String(whole % 60).padStart(2, '0')
  return { label: `${m}:${rem}`, iso: `PT${s.toFixed(1)}S` }
}

/**
 * Which agents received new text messages since the last call.
 * `prevLens` holds raw conversation lengths per agent; returns the next lengths.
 */
export function agentsWithNewText(
  prevLens: ReadonlyMap<string, number>,
  conversations: ReadonlyMap<string, readonly { type: string }[]>,
  textTypes: ReadonlySet<string>,
): { increased: string[]; nextLens: Map<string, number> } {
  const increased: string[] = []
  const nextLens = new Map<string, number>()
  for (const [agentId, msgs] of conversations) {
    const prev = prevLens.get(agentId) ?? 0
    nextLens.set(agentId, msgs.length)
    for (let i = prev; i < msgs.length; i++) {
      if (textTypes.has(msgs[i].type)) { increased.push(agentId); break }
    }
  }
  return { increased, nextLens }
}

/** Roving-tabindex keyboard navigation for tablists. Returns next index or null. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (current + 1) % count
    case 'ArrowLeft': case 'ArrowUp': return (current - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}

/** Lists below this size are rendered in full (no windowing). */
export const VIRTUALIZE_THRESHOLD = 200

/**
 * Final render window for a list. Small lists render in full; larger ones use the
 * computed window, widened so the item holding keyboard focus is never unmounted.
 */
export function resolveRenderWindow(
  count: number,
  start: number,
  end: number,
  focusedIndex: number,
  threshold: number = VIRTUALIZE_THRESHOLD,
): { start: number; end: number; virtualized: boolean } {
  if (count < threshold) return { start: 0, end: count, virtualized: false }
  let s = Math.max(0, Math.min(start, count))
  let e = Math.max(s, Math.min(end, count))
  if (focusedIndex >= 0 && focusedIndex < count) {
    if (focusedIndex < s) s = focusedIndex
    if (focusedIndex >= e) e = focusedIndex + 1
  }
  return { start: s, end: e, virtualized: true }
}

/** Keep the first `max` lines and report how many were hidden ('… (+N lines)'). */
export function truncateLines(text: string, max: number): { lines: string[]; hidden: number } {
  const all = text.split('\n')
  return { lines: all.slice(0, max), hidden: Math.max(0, all.length - max) }
}

/** Unread tab keys after new text arrived: never mark the active tab, nor 'all'. */
export function markUnread(
  prev: ReadonlySet<string>,
  increased: readonly string[],
  activeTab: string,
): Set<string> {
  const next = new Set(prev)
  if (activeTab === 'all') return next
  for (const id of increased) if (id !== activeTab) next.add(id)
  return next
}

/** Index of the active tab; falls back to the first tab so one tab is always tabbable. */
export function activeTabIndexOf(keys: readonly string[], active: string): number {
  return Math.max(0, keys.indexOf(active))
}

/** Visible keyboard focus ring (inset so it is not clipped by scroll containers). */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#aaeeff]'
