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

/** "Workspace alpha · 2 sessions · 1 team": the zone header, which says its kind in words. */
export function zoneHeaderText(z: Pick<WorkspaceZone, 'name' | 'sessionCount' | 'teamCount'>): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const parts = [`Workspace ${z.name}`]
  if (z.sessionCount > 0) parts.push(count(z.sessionCount, 'session'))
  if (z.teamCount > 0) parts.push(count(z.teamCount, 'team'))
  return parts.join(' · ')
}
