/**
 * Pure helpers for in-place list updates (issue #69): a per-row signature so a row is rebuilt only
 * when something it shows changed, and focus capture / restore around a rebuild. Free of React so it
 * can be unit-tested with node:test.
 */
import type { AgentLike, AgentNode } from './session-tree'
import { getStateLabel } from './state-labels'
import { deriveFreshness, lastKnownStateText } from '../hooks/simulation/freshness'

/** Test seam: called with the agent id each time an agent row really renders (never set in production). */
export const rowRenderProbe: { onRender: ((agentId: string) => void) | null } = { onRender: null }

export interface AgentRowView {
  detail: string
  stale: boolean
  role: 'agent' | 'sub-agent' | 'teammate'
}

/** What an agent row says about its agent: the same wording the row renders. */
export function agentRowView(a: AgentLike, freshnessNow: number): AgentRowView {
  const freshness = deriveFreshness(a, freshnessNow)
  const stale = freshness === 'stale'
  // A stale status is only the last known one: said in words, and the marker is greyed
  const detail = stale
    ? lastKnownStateText(a.state)
    : freshness === 'closed' && a.state !== 'complete'
      ? `closed, ${lastKnownStateText(a.state)}`
      : a.currentTool && a.state === 'tool_calling' ? a.currentTool : getStateLabel(a.state)
  const role = a.kind === 'subagent' ? 'sub-agent' : a.kind === 'teammate' ? 'teammate' : 'agent'
  return { detail, stale, role }
}

/**
 * Signature of an agent row and its whole subtree: equal signatures mean the DOM would be identical,
 * so the row can be kept as is. The selected id is part of it: the highlighted row must update. Fields are separated by a control character that no label contains.
 */
export function agentTreeSignature(node: AgentNode, freshnessNow: number, selectedId: string | null = null): string {
  const a = node.agent
  const view = agentRowView(a, freshnessNow)
  const own = [a.id, a.name, a.state, a.kind ?? '', a.phase ?? '', view.detail, view.stale ? 's' : '', a.tokensUsed, a.tokenStatus ?? '', a.tokensEstimated ? 'e' : '', a.model ?? '', a.id === selectedId ? 'sel' : ''].join('\u0001')
  if (node.children.length === 0) return own
  return `${own}\u0002${node.children.map(c => agentTreeSignature(c, freshnessNow, selectedId)).join('\u0003')}\u0004`
}

// ─── Focus ──────────────────────────────────────────────────────────────────

interface KeyedElement {
  dataset: { rowKey?: string }
  closest(selector: string): KeyedElement | null
}
interface FocusableElement { focus(options?: { preventScroll?: boolean }): void }

/** Key of the row holding `active` (a `data-row-key` ancestor), or null. */
export function focusKeyOf(active: KeyedElement | null): string | null {
  const row = active?.closest('[data-row-key]')
  return row?.dataset.rowKey ?? null
}

/**
 * After a rebuild: put focus back on the row with `key`, but only when focus fell to the body (the
 * focused node was replaced). Focus that moved to another element on purpose is never taken over.
 */
export function restoreFocusByKey(
  container: { querySelector(selector: string): unknown },
  key: string | null,
  active: unknown,
  body: unknown,
): boolean {
  if (key === null || (active !== body && active !== null)) return false
  const escaped = key.replace(/["\\]/g, '\\$&')
  const target = container.querySelector(`[data-row-key="${escaped}"]`) as FocusableElement | null
  if (!target) return false
  target.focus({ preventScroll: true })
  return true
}
