/**
 * Edges between session clusters in the 'All sessions' view: a parent session and the sessions it
 * launched (Task / worktree). Pure geometry on top of the clusters and the proven session links;
 * a link whose two ends are not both on screen, or that falls inside one cluster, draws nothing.
 * No React and no canvas: unit-testable under node:test.
 */
import type { SessionLink, SessionLinkKind } from '../../../lib/session-links'
import type { Cluster, SessionMeta } from './cluster-model'

export interface SessionLinkSegment {
  /** 'sl:<parentCluster>><childCluster>' */
  key: string
  kind: SessionLinkKind
  parentClusterKey: string
  childClusterKey: string
  /** Start on the parent halo, end on the child halo (world coordinates) */
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Cluster showing a session: the first one (clusters are sorted) listing it among its sessions. */
function clusterOfSession(clusters: ReadonlyArray<Pick<Cluster, 'key' | 'sessionIds'>>): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of clusters) for (const id of c.sessionIds) if (!m.has(id)) m.set(id, c.key)
  return m
}

export function sessionLinkSegments(
  clusters: ReadonlyArray<Pick<Cluster, 'key' | 'sessionIds' | 'cx' | 'cy' | 'r'>>,
  links: ReadonlyArray<SessionLink>,
): SessionLinkSegment[] {
  if (links.length === 0 || clusters.length < 2) return []
  const byKey = new Map(clusters.map(c => [c.key, c]))
  const clusterOf = clusterOfSession(clusters)
  const seen = new Set<string>()
  const out: SessionLinkSegment[] = []
  for (const link of links) {
    const pk = clusterOf.get(link.parentId)
    const ck = clusterOf.get(link.childId)
    if (!pk || !ck || pk === ck) continue
    const key = `sl:${pk}>${ck}`
    if (seen.has(key)) continue
    const p = byKey.get(pk)!
    const c = byKey.get(ck)!
    const dx = c.cx - p.cx
    const dy = c.cy - p.cy
    const dist = Math.hypot(dx, dy)
    if (!Number.isFinite(dist) || dist <= p.r + c.r) continue // halos touch or overlap: no room for an edge
    const ux = dx / dist
    const uy = dy / dist
    seen.add(key)
    out.push({
      key, kind: link.kind, parentClusterKey: pk, childClusterKey: ck,
      x1: p.cx + ux * p.r, y1: p.cy + uy * p.r, x2: c.cx - ux * c.r, y2: c.cy - uy * c.r,
    })
  }
  return out
}

/** Short sentences per cluster for the DOM outline: "launched by X" / "worktree of X" / "launched N sessions". */
export function clusterLinkNotes(
  clusters: ReadonlyArray<Pick<Cluster, 'key' | 'sessionIds'>>,
  links: ReadonlyArray<SessionLink>,
  sessions?: ReadonlyMap<string, SessionMeta>,
): Map<string, string[]> {
  const clusterOf = clusterOfSession(clusters)
  const label = (id: string) => sessions?.get(id)?.label || id
  const notes = new Map<string, string[]>()
  const add = (clusterKey: string | undefined, text: string) => {
    if (!clusterKey) return
    const list = notes.get(clusterKey)
    if (list) list.push(text)
    else notes.set(clusterKey, [text])
  }
  for (const link of links) {
    const pk = clusterOf.get(link.parentId)
    const ck = clusterOf.get(link.childId)
    if (!pk || !ck || pk === ck) continue
    add(ck, link.kind === 'worktree' ? `possibly a worktree of session ${label(link.parentId)}` : `launched by session ${label(link.parentId)}`)
    add(pk, `${link.kind === 'worktree' ? 'possibly started worktree' : 'launched'} session ${label(link.childId)}`)
  }
  return notes
}
