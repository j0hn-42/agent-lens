/**
 * Workspace zones: when clusters of several projects are on screen, each project gets one rounded zone
 * around its halos, so a workspace reads as a place and not as another group. A team halo is a coloured
 * circle; a zone is a neutral rectangle with a header, so the two levels differ by shape and not by colour.
 * Only clusters whose project is proven belong to a zone (never guessed). No React, no canvas.
 */
import { WORKSPACE_ZONE } from '../../../lib/canvas-constants'
import type { Cluster } from './cluster-model'

export interface WorkspaceZone {
  projectId: string
  /** Display name of the project */
  name: string
  /** World-space rectangle */
  x: number
  y: number
  w: number
  h: number
  clusterKeys: string[]
  sessionCount: number
  teamCount: number
}

/** One zone per project, sorted by project id; none unless at least two projects are known. */
export function computeWorkspaceZones(clusters: ReadonlyArray<Cluster>): WorkspaceZone[] {
  const byProject = new Map<string, Cluster[]>()
  for (const c of clusters) {
    if (!c.projectId || !c.projectName) continue
    const list = byProject.get(c.projectId)
    if (list) list.push(c); else byProject.set(c.projectId, [c])
  }
  if (byProject.size < 2) return []
  const zones: WorkspaceZone[] = []
  for (const [projectId, list] of byProject) {
    const x0 = Math.min(...list.map(c => c.cx - c.r)) - WORKSPACE_ZONE.padSide
    const x1 = Math.max(...list.map(c => c.cx + c.r)) + WORKSPACE_ZONE.padSide
    const y0 = Math.min(...list.map(c => c.cy - c.r)) - WORKSPACE_ZONE.padTop
    const y1 = Math.max(...list.map(c => c.cy + c.r)) + WORKSPACE_ZONE.padSide
    const teamCount = list.filter(c => c.kind === 'team').length
    zones.push({
      projectId, name: list[0].projectName!, x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      clusterKeys: list.map(c => c.key), sessionCount: list.length - teamCount, teamCount,
    })
  }
  return zones.sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
}

export interface WorkspaceHeaderBox {
  /** Header text, cut with an ellipsis to the zone width */
  text: string
  /** World-space chip */
  x: number
  y: number
  w: number
  h: number
  /** Font size and inner padding (world px) */
  fontPx: number
  pad: number
  /** World units per screen px below zoom 1 (the header keeps its on-screen size), else 1 */
  k: number
}

/**
 * Chip of the zone header at `zoom`, shared by the draw code and the overlay plan (a halo title must not
 * cover it, #378). `measure(text, fontPx)` gives the width of `text` at that font size.
 */
export function workspaceHeaderRect(
  z: Pick<WorkspaceZone, 'x' | 'y' | 'w' | 'name' | 'sessionCount' | 'teamCount'>, zoom: number,
  measure: (text: string, fontPx: number) => number, text: string = zoneHeaderText(z),
): WorkspaceHeaderBox {
  const k = Math.max(1, 1 / Math.max(zoom || 1, 1e-3))
  const fontPx = WORKSPACE_ZONE.headerFontSize * k
  const pad = 8 * k
  // Never wider than the zone itself: a long name is cut, not drawn over its neighbour
  const maxW = Math.max(0, z.w - 2 * pad - 2 * WORKSPACE_ZONE.cornerRadius)
  let shown = text
  while (shown.length > 1 && measure(shown, fontPx) > maxW) shown = shown.slice(0, -2) + '…'
  return {
    text: shown, x: z.x + WORKSPACE_ZONE.cornerRadius, y: z.y + 12 * k,
    w: measure(shown, fontPx) + 2 * pad, h: fontPx + 2 * pad * 0.6, fontPx, pad, k,
  }
}

/** "Workspace alpha · 2 sessions · 1 team": the zone header, which says its kind in words. */
export function zoneHeaderText(z: Pick<WorkspaceZone, 'name' | 'sessionCount' | 'teamCount'>): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const parts = [`Workspace ${z.name}`]
  if (z.sessionCount > 0) parts.push(count(z.sessionCount, 'session'))
  if (z.teamCount > 0) parts.push(count(z.teamCount, 'team'))
  return parts.join(' · ')
}
