/**
 * Search and filter of the session list (#125): free text, project, runtime. Pure (no React).
 * Only fields the session list really carries are searched; nothing is inferred (no branch data exists).
 */
import type { SessionInfo } from './bridge-types'

export type RuntimeFilter = 'claude' | 'codex'

export interface SessionFilter {
  query: string
  /** projectId to keep, or null for every project */
  projectId: string | null
  runtime: RuntimeFilter | null
}

export const EMPTY_SESSION_FILTER: Readonly<SessionFilter> = Object.freeze({ query: '', projectId: null, runtime: null })

export function isFilterActive(f: SessionFilter): boolean {
  return f.query.trim().length > 0 || f.projectId !== null || f.runtime !== null
}

export interface ProjectOption { projectId: string; projectName: string }

/** Projects present in the list, by name. */
export function projectOptions(sessions: ReadonlyArray<Pick<SessionInfo, 'projectId' | 'projectName'>>): ProjectOption[] {
  const seen = new Map<string, string>()
  for (const s of sessions) {
    if (s.projectId && s.projectName && !seen.has(s.projectId)) seen.set(s.projectId, s.projectName)
  }
  return [...seen].map(([projectId, projectName]) => ({ projectId, projectName }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId))
}

/** Runtimes present in the list. */
export function runtimeOptions(sessions: ReadonlyArray<Pick<SessionInfo, 'runtime'>>): RuntimeFilter[] {
  const out: RuntimeFilter[] = []
  for (const r of ['claude', 'codex'] as const) if (sessions.some(s => s.runtime === r)) out.push(r)
  return out
}

/**
 * A stored project that no session belongs to any more is ignored (the list is not emptied by a filter
 * that no control can show); the runtime is kept as is.
 */
export function effectiveFilter(f: SessionFilter, sessions: ReadonlyArray<Pick<SessionInfo, 'projectId' | 'projectName'>>): SessionFilter {
  if (f.projectId === null) return f
  return projectOptions(sessions).some(p => p.projectId === f.projectId) ? f : { ...f, projectId: null }
}

export function sessionMatches(
  s: SessionInfo,
  f: SessionFilter,
  /** Names of the agents of this session (only those the current view knows) */
  agentNames: readonly string[] = [],
): boolean {
  if (f.projectId !== null && s.projectId !== f.projectId) return false
  if (f.runtime !== null && s.runtime !== f.runtime) return false
  const terms = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = [s.label, s.projectName, s.workspace, s.cwd, s.teamName, s.memberName, ...agentNames]
    .filter((v): v is string => typeof v === 'string').join('\n').toLowerCase()
  return terms.every(t => haystack.includes(t))
}

export function filterSessionList(
  sessions: ReadonlyArray<SessionInfo>,
  f: SessionFilter,
  agentNamesOf?: (sessionId: string) => readonly string[],
): SessionInfo[] {
  if (!isFilterActive(f)) return sessions as SessionInfo[]
  return sessions.filter(s => sessionMatches(s, f, agentNamesOf?.(s.id)))
}

/** Agent names grouped by session id. */
export function agentNamesBySession(agents: Iterable<{ sessionId: string; name: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of agents) {
    const list = out.get(a.sessionId)
    if (list) list.push(a.name)
    else out.set(a.sessionId, [a.name])
  }
  return out
}
