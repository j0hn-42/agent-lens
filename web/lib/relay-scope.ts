/**
 * Scope of the relay's discovery (#291): this workspace, one project, or every workspace. Pure (no React).
 *
 * The state shown is the one GET /status reports: what the relay really scans, never what was asked. A choice
 * only becomes the shown state once the relay confirmed it. "A project" is not a third relay scope: it keeps the
 * relay scope and sets the project filter (projectId / projectName) that the session list already has.
 */
import type { SessionInfo } from './bridge-types'
import { projectOptions } from './session-filter'

export type RelayScope = 'workspace' | 'all'

export interface DiscoveryLimits {
  /** More project folders exist than `maxProjectDirs`: the others are not scanned */
  projectDirsCapped: boolean
  maxProjectDirs: number
  maxFilesPerDir: number
  /** Sessions left out by a ceiling, distinct, bounded: read as "at least" */
  skipped: { watchLimit: number; sizeLimit: number; fileLimit: number }
}

export interface RelayScopeState {
  scope: RelayScope
  /** Folder the relay was started in, as the relay reports it */
  workspace: string
  /** null = this relay does not report its ceilings (older relay): nothing is claimed about them */
  discovery: DiscoveryLimits | null
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9

function parseDiscovery(status: Record<string, unknown>): DiscoveryLimits | null {
  const d = status.discovery
  const k = status.skippedSessions
  if (typeof d !== 'object' || d === null || typeof k !== 'object' || k === null) return null
  const dd = d as Record<string, unknown>
  const kk = k as Record<string, unknown>
  if (typeof dd.projectDirsCapped !== 'boolean' || !isCount(dd.maxProjectDirs) || !isCount(dd.maxFilesPerDir)) return null
  if (!isCount(kk.watchLimit) || !isCount(kk.sizeLimit) || !isCount(kk.fileLimit)) return null
  return {
    projectDirsCapped: dd.projectDirsCapped, maxProjectDirs: dd.maxProjectDirs, maxFilesPerDir: dd.maxFilesPerDir,
    skipped: { watchLimit: kk.watchLimit, sizeLimit: kk.sizeLimit, fileLimit: kk.fileLimit },
  }
}

/** Reads GET /status strictly: the scope needs a boolean `allWorkspaces`; anything else is "unknown" (null). */
export function parseRelayScopeState(json: unknown): RelayScopeState | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const s = json as Record<string, unknown>
  if (typeof s.allWorkspaces !== 'boolean' || typeof s.workspace !== 'string') return null
  return { scope: s.allWorkspaces ? 'all' : 'workspace', workspace: s.workspace, discovery: parseDiscovery(s) }
}

// ─── Choices ─────────────────────────────────────────────────────────────────

export type ScopeChoice = { kind: 'workspace' } | { kind: 'all' } | { kind: 'project'; projectId: string }

const PROJECT_PREFIX = 'project:'
const PROJECT_ID_MAX = 256

export function scopeValue(scope: RelayScope, projectId: string | null): string {
  return projectId ? `${PROJECT_PREFIX}${projectId}` : scope
}

/** Select value -> choice; anything that is not one of the offered shapes is refused (null). */
export function parseScopeValue(value: unknown): ScopeChoice | null {
  if (value === 'workspace') return { kind: 'workspace' }
  if (value === 'all') return { kind: 'all' }
  if (typeof value === 'string' && value.startsWith(PROJECT_PREFIX)) {
    const projectId = value.slice(PROJECT_PREFIX.length)
    if (projectId.length > 0 && projectId.length <= PROJECT_ID_MAX) return { kind: 'project', projectId }
  }
  return null
}

export interface ScopeOption { value: string; label: string }

/** This workspace, all workspaces, then the projects present in the list (by name). */
export function scopeOptions(sessions: ReadonlyArray<Pick<SessionInfo, 'projectId' | 'projectName'>>): ScopeOption[] {
  return [
    { value: 'workspace', label: 'This workspace' },
    { value: 'all', label: 'All workspaces' },
    ...projectOptions(sessions).map(p => ({ value: `${PROJECT_PREFIX}${p.projectId}`, label: `Project: ${p.projectName}` })),
  ]
}

/** What the relay must scan and which project filter to set for a choice. A project keeps the current relay scope. */
export function planScopeChoice(choice: ScopeChoice, current: RelayScope): { relayScope: RelayScope; projectId: string | null } {
  switch (choice.kind) {
    case 'workspace': return { relayScope: 'workspace', projectId: null }
    case 'all': return { relayScope: 'all', projectId: null }
    case 'project': return { relayScope: current, projectId: choice.projectId }
  }
}

// ─── Text ────────────────────────────────────────────────────────────────────

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** One line stating the limit in force. null on all workspaces: nothing is limited, the selector says it. */
export function scopeSummary(state: RelayScopeState): string | null {
  return state.scope === 'all' ? null : `Scanning this workspace only (${baseName(state.workspace)})`
}

/** Shown where a list would otherwise be silently empty: the limit, and the way out. null when nothing is limited or unknown. */
export function scopeEmptyHint(state: RelayScopeState | null): string | null {
  if (!state || state.scope !== 'workspace') return null
  return 'Only the sessions of this workspace are discovered. Choose All workspaces to look at the others.'
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** The discovery ceilings that were hit, as sentences. Empty when none was (or the relay does not say). */
export function scopeNotices(state: RelayScopeState): string[] {
  const d = state.discovery
  if (!d) return []
  const out: string[] = []
  const { fileLimit, sizeLimit, watchLimit } = d.skipped
  if (fileLimit > 0) out.push(`At least ${fileLimit} older ${plural(fileLimit, 'transcript is', 'transcripts are')} not followed: more than ${d.maxFilesPerDir} in one folder.`)
  if (sizeLimit > 0) out.push(`At least ${sizeLimit} ${plural(sizeLimit, 'transcript is', 'transcripts are')} too large to follow.`)
  if (watchLimit > 0) out.push(`At least ${watchLimit} ${plural(watchLimit, 'session is', 'sessions are')} not followed: the watch limit is reached.`)
  return out
}

// ─── Client ──────────────────────────────────────────────────────────────────

export type ApplyScopeResult = { ok: true; scope: RelayScope } | { ok: false; reason: string }

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * POST /scope with the strict body the relay expects. The answer is trusted only when it is coherent with the
 * request: otherwise the displayed scope stays the previous one.
 */
export async function applyRelayScope(origin: string, scope: RelayScope, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<ApplyScopeResult> {
  try {
    const res = await fetchImpl(`${origin}/scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, reason: `The relay refused the change of scope (${res.status})` }
    const json: unknown = await res.json()
    const j = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
    if (j.scope !== scope || j.allWorkspaces !== (scope === 'all')) return { ok: false, reason: 'The relay answered with another scope than the one asked' }
    return { ok: true, scope }
  } catch {
    return { ok: false, reason: 'The relay could not be reached to change the scope' }
  }
}

/** GET /status read as a scope state; null when it cannot be proven. */
export async function fetchRelayScopeState(origin: string, signal?: AbortSignal, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<RelayScopeState | null> {
  try {
    const res = await fetchImpl(`${origin}/status`, { signal, cache: 'no-store', headers: { Accept: 'application/json' } })
    return res.ok ? parseRelayScopeState(await res.json()) : null
  } catch {
    return null
  }
}
