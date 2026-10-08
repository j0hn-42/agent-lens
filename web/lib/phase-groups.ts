/**
 * Grouping of a workflow's agents by phase (#146), shared by the canvas labels, the DOM mirror and the
 * sessions list. A phase is only ever the label the workflow announced for an agent: nothing is inferred.
 * Pure: no React, no DOM.
 */

/** What the grouping reads of an agent / row */
export interface PhaseItem {
  phase?: string
  teamKind?: 'team' | 'workflow'
}

export type PhaseSegment<T> =
  /** Items outside any phase (not workflow agents: the orchestrator, plain sub-agents). Shown without a heading. */
  | { kind: 'plain'; items: T[] }
  /** Workflow agents that announced this phase */
  | { kind: 'phase'; phase: string; items: T[] }
  /** Workflow agents without a phase, explicitly named, only emitted next to at least one real phase */
  | { kind: 'none'; items: T[] }

/**
 * Segments of `items` in display order: the plain items first, then one segment per phase in order of
 * first appearance, then the workflow agents without phase. Without any announced phase there is nothing to
 * group by: a single plain segment keeps the list exactly as it was.
 */
export function groupByPhase<T extends PhaseItem>(items: readonly T[]): Array<PhaseSegment<T>> {
  if (items.length === 0) return []
  const phased = new Map<string, T[]>()
  const plain: T[] = []
  const none: T[] = []
  for (const it of items) {
    if (it.teamKind !== 'workflow') plain.push(it)
    else if (it.phase) {
      const list = phased.get(it.phase)
      if (list) list.push(it); else phased.set(it.phase, [it])
    } else none.push(it)
  }
  if (phased.size === 0) return [{ kind: 'plain', items: [...items] }]
  const out: Array<PhaseSegment<T>> = []
  if (plain.length > 0) out.push({ kind: 'plain', items: plain })
  for (const [phase, list] of phased) out.push({ kind: 'phase', phase, items: list })
  if (none.length > 0) out.push({ kind: 'none', items: none })
  return out
}

/** Name of a segment for assistive technology and labels: "Phase Implement" / "No phase". */
export function phaseSegmentLabel(seg: PhaseSegment<unknown>): string {
  return seg.kind === 'phase' ? `Phase ${seg.phase}` : seg.kind === 'none' ? 'No phase' : ''
}
