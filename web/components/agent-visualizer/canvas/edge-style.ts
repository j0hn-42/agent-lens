/**
 * Verification state of parent -> child edges (#54), shared by the canvas, the legend and the DOM mirror.
 * Pure, relative imports only (unit-testable under node:test).
 */
import type { Edge } from '../../../lib/agent-types'

/** An edge is a fact only when explicitly verified; a parent-child edge with no verdict is not proven either. */
export function isUnverifiedEdge(edge: Pick<Edge, 'type' | 'verified'>): boolean {
  return edge.type === 'parent-child' && edge.verified !== true
}

/** Dash pattern (world px) of unverified edges */
export const UNVERIFIED_DASH: number[] = [7, 6]
/** Stroke width (world px) and alpha of unverified edges */
export const UNVERIFIED_EDGE = { width: 1.4, alpha: 0.5, activeAlpha: 0.7 } as const

const REASON_TEXT: Record<string, string> = {
  'no-tool-use-id': 'no tool call id on the start event',
  'parent-fallback': 'parent unknown, attached to the main agent',
  'no-call': 'no earlier call by the parent with this id',
  'parent-mismatch': 'another agent made the call with this id',
  'child-mismatch': 'the call names another sub-agent',
  'return-mismatch': 'a return disagrees on parent or name',
  'dispatch-mismatch': 'a dispatch disagrees on parent or name',
}

/** Human-readable reason an edge is unverified (for tooltips); empty when unknown. */
export function unverifiedReasonText(reason: string | undefined): string {
  return (reason && Object.hasOwn(REASON_TEXT, reason) && REASON_TEXT[reason]) || ''
}
