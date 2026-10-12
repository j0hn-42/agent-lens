/**
 * Edges between agents that edited the same file (#227). One segment per pair of agents on screen,
 * whatever the number of files they share; a pair with an agent off screen draws nothing (the
 * outline and the Files panel still list it). Pure geometry: unit-testable under node:test.
 */
import type { FileConflict } from '../../../lib/file-conflicts'

export interface FileConflictSegment {
  /** 'fc:<agentA>|<agentB>' (keys sorted) */
  key: string
  a: string
  b: string
  /** Paths the two agents both edited */
  paths: string[]
  x1: number
  y1: number
  x2: number
  y2: number
}

/** A conflict lists few agents; past this many, only the first ones are paired (bounded work per frame). */
const MAX_AGENTS_PER_CONFLICT = 8

export function fileConflictSegments(
  conflicts: ReadonlyArray<FileConflict>,
  agents: ReadonlyMap<string, { x: number; y: number }>,
): FileConflictSegment[] {
  if (conflicts.length === 0) return []
  const byKey = new Map<string, FileConflictSegment>()
  for (const c of conflicts) {
    const ids = c.editors.slice(0, MAX_AGENTS_PER_CONFLICT).map(e => e.agent)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]]
        const key = `fc:${a}|${b}`
        const seg = byKey.get(key)
        if (seg) { seg.paths.push(c.path); continue }
        const pa = agents.get(a)
        const pb = agents.get(b)
        if (!pa || !pb) continue
        if (![pa.x, pa.y, pb.x, pb.y].every(Number.isFinite)) continue
        byKey.set(key, { key, a, b, paths: [c.path], x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y })
      }
    }
  }
  return [...byKey.values()]
}
