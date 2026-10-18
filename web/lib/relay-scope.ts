/**
 * Scope of the relay's discovery (#291): this workspace, one project, or every workspace. Pure (no React).
 *
 * The state shown is the one GET /status reports: what the relay really scans, never what was asked. A choice
 * only becomes the shown state once the relay confirmed it. "A project" is not a third relay scope: it keeps the
 * relay scope and sets the project filter (projectId / projectName) that the session list already has.
 */
import type { SessionInfo } from './bridge-types'
import { projectOptions } from './session-filter'
import { CONTROL_ALL } from './control-chars'
import { translate, type Locale, type MessageKey } from './messages'
import { runtimeBadge } from './chrome-utils'

export type RelayScope = 'workspace' | 'all'

export interface DiscoveryLimits {
  /** More project folders exist than `maxProjectDirs`: the others are not scanned */
  projectDirsCapped: boolean
  maxProjectDirs: number
  maxFilesPerDir: number
  /** Sessions left out by a ceiling, distinct, bounded: read as "at least" */
  skipped: { watchLimit: number; sizeLimit: number; fileLimit: number }
}

/** A watched runtime that the relay reports it cannot read right now (#420), e.g. "OpenCode: database not found." */
export interface RuntimeProblem {
  runtime: string
  /** The relay's own sentence: control characters removed, capped */
  message: string
}

/**
 * Losses of a watched runtime that no followed session counts (#420): rows it could not read and row changes it will
 * not deliver, in sessions not followed at the time. Lower bounds, never 0 together (no entry then).
 */
export interface RuntimeLoss {
  runtime: string
  unreadableRows: number
  missedUpdates: number
}

export interface RelayScopeState {
  scope: RelayScope
  /** Folder the relay was started in, as the relay reports it */
  workspace: string
  /** null = this relay does not report its ceilings (older relay): nothing is claimed about them */
  discovery: DiscoveryLimits | null
  /** Watched runtimes the relay reports unusable at the time of the status; empty = none reported (or an older relay) */
  runtimeProblems?: RuntimeProblem[]
  /** Losses the relay reports outside the followed sessions; empty = none reported (or an older relay) */
  runtimeLosses?: RuntimeLoss[]
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

const RUNTIME_PROBLEM_MAX = 300

/** Only a runtime the relay says it watches, one entry each, its sentence cleaned and capped. */
function parseRuntimeProblems(status: Record<string, unknown>): RuntimeProblem[] {
  const watched = Array.isArray(status.runtimes) ? status.runtimes.filter((r): r is string => typeof r === 'string') : []
  if (!Array.isArray(status.runtimeProblems)) return []
  const out: RuntimeProblem[] = []
  for (const p of status.runtimeProblems.slice(0, watched.length)) {
    if (typeof p !== 'object' || p === null) continue
    const { runtime, message } = p as Record<string, unknown>
    if (typeof runtime !== 'string' || !watched.includes(runtime) || out.some(o => o.runtime === runtime)) continue
    if (typeof message !== 'string') continue
    const text = message.replace(CONTROL_ALL, '').trim().slice(0, RUNTIME_PROBLEM_MAX)
    if (text) out.push({ runtime, message: text })
  }
  return out
}

/** Only a runtime the relay says it watches, one entry each, two counts and at least one above 0. */
function parseRuntimeLosses(status: Record<string, unknown>): RuntimeLoss[] {
  const watched = Array.isArray(status.runtimes) ? status.runtimes.filter((r): r is string => typeof r === 'string') : []
  if (!Array.isArray(status.runtimeLosses)) return []
  const out: RuntimeLoss[] = []
  for (const l of status.runtimeLosses.slice(0, watched.length)) {
    if (typeof l !== 'object' || l === null) continue
    const { runtime, unreadableRows, missedUpdates } = l as Record<string, unknown>
    if (typeof runtime !== 'string' || !watched.includes(runtime) || out.some(o => o.runtime === runtime)) continue
    if (!isCount(unreadableRows) || !isCount(missedUpdates) || unreadableRows + missedUpdates === 0) continue
    out.push({ runtime, unreadableRows, missedUpdates })
  }
  return out
}

/** Reads GET /status strictly: the scope needs a boolean `allWorkspaces`; anything else is "unknown" (null). */
export function parseRelayScopeState(json: unknown): RelayScopeState | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const s = json as Record<string, unknown>
  if (typeof s.allWorkspaces !== 'boolean' || typeof s.workspace !== 'string') return null
  return { scope: s.allWorkspaces ? 'all' : 'workspace', workspace: s.workspace, discovery: parseDiscovery(s), runtimeProblems: parseRuntimeProblems(s), runtimeLosses: parseRuntimeLosses(s) }
}

/** Delays between re-reads of GET /status while a runtime problem is shown (#420), then the last one, for as long as it is shown */
const RUNTIME_PROBLEM_RECHECK_MS = [5_000, 10_000, 20_000, 40_000] as const
const RUNTIME_PROBLEM_RECHECK_MAX_MS = 60_000

/**
 * When to read GET /status again (ms), or null when no runtime problem or loss is shown. A notice read once could stay
 * after it turned false (the database appears while the page is connected), and a count of losses only grows while
 * the relay runs: it is re-read on a growing delay, capped at a minute, and never dropped from the schedule while it is shown.
 */
export function runtimeProblemRecheckDelay(state: RelayScopeState | null, attempt: number): number | null {
  if (!state?.runtimeProblems?.length && !state?.runtimeLosses?.length) return null
  const i = Number.isInteger(attempt) && attempt > 0 ? attempt : 0
  return i < RUNTIME_PROBLEM_RECHECK_MS.length ? RUNTIME_PROBLEM_RECHECK_MS[i] : RUNTIME_PROBLEM_RECHECK_MAX_MS
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
export function scopeOptions(sessions: ReadonlyArray<Pick<SessionInfo, 'projectId' | 'projectName'>>, locale: Locale = 'en'): ScopeOption[] {
  return [
    { value: 'workspace', label: translate(locale, 'scope.option.workspace') },
    { value: 'all', label: translate(locale, 'scope.option.all') },
    ...projectOptions(sessions).map(p => ({ value: `${PROJECT_PREFIX}${p.projectId}`, label: translate(locale, 'scope.option.project', { name: p.projectName }) })),
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
export function scopeSummary(state: RelayScopeState, locale: Locale = 'en'): string | null {
  return state.scope === 'all' ? null : translate(locale, 'scope.summary', { name: baseName(state.workspace) })
}

/** Shown where a list would otherwise be silently empty: the limit, and the way out. null when nothing is limited or unknown. */
export function scopeEmptyHint(state: RelayScopeState | null): string | null {
  if (!state || state.scope !== 'workspace') return null
  return 'Only the sessions of this workspace are discovered. Choose All workspaces to look at the others.'
}

/** A message that exists as <base>.one / <base>.other (French: 0 and 1 are singular). */
const pluralText = (locale: Locale, base: string, n: number, params: Record<string, string | number> = {}) =>
  translate(locale, `${base}.${new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other'}` as MessageKey, { n, ...params })

/** The discovery ceilings that were hit, the runtimes the relay cannot read and their losses outside the followed sessions, as sentences. Empty when none (or the relay does not say). */
export function scopeNotices(state: RelayScopeState, locale: Locale = 'en'): string[] {
  const out: string[] = (state.runtimeProblems ?? []).map(p => p.message)
  for (const l of state.runtimeLosses ?? []) {
    const runtime = runtimeBadge(l.runtime as SessionInfo['runtime'])?.label ?? l.runtime
    if (l.missedUpdates > 0) out.push(pluralText(locale, 'scope.notice.runtimeMissed', l.missedUpdates, { runtime }))
    if (l.unreadableRows > 0) out.push(pluralText(locale, 'scope.notice.runtimeUnreadable', l.unreadableRows, { runtime }))
  }
  const d = state.discovery
  if (!d) return out
  const { fileLimit, sizeLimit, watchLimit } = d.skipped
  if (fileLimit > 0) out.push(pluralText(locale, 'scope.notice.fileLimit', fileLimit, { max: d.maxFilesPerDir }))
  if (sizeLimit > 0) out.push(pluralText(locale, 'scope.notice.sizeLimit', sizeLimit))
  if (watchLimit > 0) out.push(pluralText(locale, 'scope.notice.watchLimit', watchLimit))
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
