/**
 * File conflicts (#227): two or more agents (of one session or of several) that modified the same file.
 * Only what the events prove counts: an edit (Edit, Write, MultiEdit, NotebookEdit) whose success was
 * observed, on an absolute path. A failed, cancelled or unfinished edit, a read, or a relative path (its
 * directory is unknown, so two of them may name two files) never makes a conflict. Pure and bounded.
 * Imports are relative (not "@/"): the root test runner has no path aliases.
 */
import type { FileAttention } from './agent-types'

/** At most this many conflicts are derived (most recent first). */
export const MAX_FILE_CONFLICTS = 100

export interface FileConflictEditor {
  /** Agent key (`<session>:<agent>`) */
  agent: string
  /** Edits of this agent observed to succeed on the file */
  edits: number
  lastEditTime?: number
}

export interface FileConflict {
  /** Normalised absolute path */
  path: string
  /** Agents with at least one successful edit, by first appearance */
  editors: FileConflictEditor[]
  lastEditTime: number
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//

/** Normalised absolute path (separators, `.` and `..`, Windows drive letter), or undefined when it is not absolute. */
export function conflictPath(raw: string): string | undefined {
  if (!raw) return undefined
  const p = raw.replace(/\\/g, '/')
  const drive = WINDOWS_ABSOLUTE.test(p) ? p.slice(0, 2).toLowerCase() : p.startsWith('/') ? '' : undefined
  if (drive === undefined) return undefined
  const out: string[] = []
  for (const seg of p.slice(drive.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return undefined // climbs above the root: not a path we can trust
      out.pop()
    } else out.push(seg)
  }
  return `${drive}/${out.join('/')}`
}

export function deriveFileConflicts(fileAttention: ReadonlyMap<string, FileAttention>): FileConflict[] {
  const byPath = new Map<string, Map<string, FileConflictEditor>>()
  for (const file of fileAttention.values()) {
    if (!file.editors?.length) continue
    const path = conflictPath(file.path)
    if (!path) continue
    let editors = byPath.get(path)
    for (const e of file.editors) {
      if (!(e.succeeded > 0) || !e.agent) continue
      if (!editors) { editors = new Map(); byPath.set(path, editors) }
      const prev = editors.get(e.agent)
      const last = Math.max(prev?.lastEditTime ?? -Infinity, e.lastEditTime ?? -Infinity)
      editors.set(e.agent, {
        agent: e.agent,
        edits: (prev?.edits ?? 0) + e.succeeded,
        ...(Number.isFinite(last) ? { lastEditTime: last } : {}),
      })
    }
  }
  const out: FileConflict[] = []
  for (const [path, editors] of byPath) {
    if (editors.size < 2) continue
    const list = [...editors.values()]
    out.push({ path, editors: list, lastEditTime: Math.max(0, ...list.map(e => e.lastEditTime ?? 0)) })
  }
  out.sort((a, b) => b.lastEditTime - a.lastEditTime || (a.path < b.path ? -1 : 1))
  return out.length > MAX_FILE_CONFLICTS ? out.slice(0, MAX_FILE_CONFLICTS) : out
}

/** Paths in conflict, for a quick lookup of a raw path through `conflictPath`. */
export function conflictPathSet(conflicts: ReadonlyArray<FileConflict>): Set<string> {
  return new Set(conflicts.map(c => c.path))
}

/** "edited by alpha (session Main): 2 successful edits; beta (session Fix): 1 successful edit" */
export function describeConflictEditors(conflict: FileConflict, label: (agentKey: string) => string): string {
  const parts = conflict.editors.map(e => `${label(e.agent)}: ${e.edits} successful ${e.edits === 1 ? 'edit' : 'edits'}`)
  return `edited by ${parts.join('; ')}`
}
