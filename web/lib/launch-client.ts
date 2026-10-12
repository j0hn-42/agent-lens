/**
 * Launch an agent on an issue (#229), client side. Pure: builds the POST /launch and /launch/<id>/stop requests,
 * turns a refusal into a fixed sentence of the message catalog (French or English; the answer body is never read nor shown), validates the views the
 * relay sends (SSE `launch` / `launch-list`, GET /status `launch`) and says in words what was OBSERVED of a launch.
 * The relay decides everything (docs/launch-security.md); this module only asks and reports.
 */
import { CONTROL_ALL } from './control-chars'
import type { LaunchState, LaunchView } from './bridge-types'
import { DEFAULT_LOCALE, translate, type Locale, type MessageKey } from './messages'

export type { LaunchState, LaunchView }

/** Wall clock of one run, in minutes (LAUNCH_CAPS.wallClockMs; scripts/launch-client.test.ts compares them) */
export const LAUNCH_WALL_CLOCK_MIN = 60
/** Launches remembered by the view (the relay keeps the last 20 finished plus the running ones) */
export const LAUNCHES_KEPT = 50

export interface LaunchRequestBody { repo: string; issue: number; role: string }

export interface LaunchStatus {
  maxConcurrent: number
  launches: LaunchView[]
}

export interface BuiltRequest {
  url: string
  init: {
    method: 'POST'
    headers: { Authorization: string; 'Content-Type'?: 'application/json' }
    body?: string
    cache: 'no-store'
    credentials: 'same-origin'
  }
}

const STATES: readonly LaunchState[] = ['requested', 'started', 'session', 'exited', 'stopped', 'expired', 'failed']
const ENDED: ReadonlySet<LaunchState> = new Set(['exited', 'stopped', 'expired', 'failed'])
const ID_RE = /^[0-9a-f]{16}$/
const ISSUE_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/issues\/\d{1,9}$/
const STOP_REASONS = new Set(['stop', 'expired', 'relay-stopped'])

const bearer = (token: string) => `Bearer ${token.trim()}`

/** POST /launch. Only `repo`, `issue` and `role` are copied into the body; the token goes in a header, never in the URL. */
export function buildLaunchRequest(origin: string, req: LaunchRequestBody, token: string): BuiltRequest {
  return {
    url: `${origin}/launch`,
    init: {
      method: 'POST',
      headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: req.repo, issue: req.issue, role: req.role }),
      cache: 'no-store',
      credentials: 'same-origin',
    },
  }
}

/** POST /launch/<id>/stop; null when `id` is not an id the relay draws (16 hex digits). */
export function buildStopRequest(origin: string, id: string, token: string): BuiltRequest | null {
  if (!ID_RE.test(id)) return null
  return {
    url: `${origin}/launch/${id}/stop`,
    init: { method: 'POST', headers: { Authorization: bearer(token) }, cache: 'no-store', credentials: 'same-origin' },
  }
}

const LAUNCH_ERRORS: Record<number, MessageKey> = {
  400: 'launch.err.400', 401: 'launch.err.401', 403: 'launch.err.403', 404: 'launch.err.404', 405: 'launch.err.405',
  408: 'launch.err.408', 409: 'launch.err.409', 413: 'launch.err.413', 415: 'launch.err.415', 422: 'launch.err.422',
  429: 'launch.err.429', 502: 'launch.err.502', 503: 'launch.err.503',
}
const STOP_ERRORS: Record<number, MessageKey> = { 404: 'launch.err.stop.404', 409: 'launch.err.stop.409' }

/** Fixed sentence for an HTTP refusal (message catalog). Takes the status only: the body of the answer is never shown. */
export function launchErrorMessage(status: number, kind: 'launch' | 'stop' = 'launch', locale: Locale = DEFAULT_LOCALE): string {
  const key = (kind === 'stop' ? STOP_ERRORS[status] : undefined) ?? LAUNCH_ERRORS[status]
  return key ? translate(locale, key) : translate(locale, 'launch.err.other', { code: Number.isInteger(status) ? status : '?' })
}

export type FetchLike = (url: string, init: BuiltRequest['init']) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export type LaunchOutcome = { ok: true; launch: LaunchView | null } | { ok: false; message: string }

/** Fetch failed before any answer: no relay, or a cross-origin page (the relay answers no CORS preflight on /launch). */
async function send(fetchFn: FetchLike, req: BuiltRequest, kind: 'launch' | 'stop', locale: Locale): Promise<LaunchOutcome> {
  let res: Awaited<ReturnType<FetchLike>>
  try { res = await fetchFn(req.url, req.init) } catch { return { ok: false, message: translate(locale, 'launch.err.network') } }
  if (!res.ok) return { ok: false, message: launchErrorMessage(res.status, kind, locale) }
  let body: unknown = null
  try { body = await res.json() } catch { /* accepted, answer unreadable: no view is invented */ }
  return { ok: true, launch: parseLaunchView(body) }
}

export function postLaunch(
  fetchFn: FetchLike, origin: string, req: LaunchRequestBody, token: string, locale: Locale = DEFAULT_LOCALE,
): Promise<LaunchOutcome> {
  return send(fetchFn, buildLaunchRequest(origin, req, token), 'launch', locale)
}

export function postStop(fetchFn: FetchLike, origin: string, id: string, token: string, locale: Locale = DEFAULT_LOCALE): Promise<LaunchOutcome> {
  const req = buildStopRequest(origin, id, token)
  if (!req) return Promise.resolve({ ok: false, message: launchErrorMessage(404, 'stop', locale) })
  return send(fetchFn, req, 'stop', locale)
}

// ─── Validation of what the relay sends ──────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const cleanText = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.replace(CONTROL_ALL, '').slice(0, max) || undefined : undefined

/** A bounded code (ENOENT, spawn-error...): letters, digits, `_` and `-` only, else nothing */
const safeCode = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : ''
  return s || undefined
}

/** A view of the relay, field by field; anything malformed in a required field refuses the whole view. */
export function parseLaunchView(v: unknown): LaunchView | null {
  if (!isRecord(v)) return null
  const { id, repo, issue, role, worktree, sessionId, state, requestedAt } = v
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue <= 0) return null
  if (typeof role !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(role)) return null
  if (typeof worktree !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(worktree)) return null
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) return null
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) return null
  if (!isTime(requestedAt)) return null
  const out: LaunchView = {
    id, repo, issue, role, worktree, sessionId, state: state as LaunchState, requestedAt,
    outputBytes: isTime(v.outputBytes) ? v.outputBytes : 0,
    outputDroppedBytes: isTime(v.outputDroppedBytes) ? v.outputDroppedBytes : 0,
  }
  if (typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0) out.pid = v.pid
  for (const k of ['startedAt', 'sessionSeenAt', 'stopRequestedAt', 'endedAt'] as const) if (isTime(v[k])) out[k] = v[k] as number
  if (typeof v.stopReason === 'string' && STOP_REASONS.has(v.stopReason)) out.stopReason = v.stopReason as LaunchView['stopReason']
  if (typeof v.exitCode === 'number' && Number.isInteger(v.exitCode)) out.exitCode = v.exitCode
  const signal = safeCode(v.signal)?.slice(0, 16)
  if (signal) out.signal = signal
  const failure = safeCode(v.failure)
  if (failure) out.failure = failure
  const worktreePath = cleanText(v.worktreePath, 1024)
  if (worktreePath) out.worktreePath = worktreePath
  return out
}

/** `launch` of GET /status. null = the relay has no launch surface (started without --allow-launch). */
export function parseLaunchStatus(status: unknown): LaunchStatus | null {
  if (!isRecord(status) || !isRecord(status.launch)) return null
  const { maxConcurrent, launches } = status.launch
  if (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10) return null
  const list = Array.isArray(launches) ? launches.map(parseLaunchView).filter((l): l is LaunchView => l !== null) : []
  return { maxConcurrent, launches: list.slice(0, LAUNCHES_KEPT) }
}

export function isLaunchMessage(data: unknown): boolean {
  return isRecord(data) && (data.type === 'launch' || data.type === 'launch-list')
}

function capped(map: Map<string, LaunchView>): Map<string, LaunchView> {
  if (map.size <= LAUNCHES_KEPT) return map
  const oldest = [...map.values()].sort((a, b) => a.requestedAt - b.requestedAt).slice(0, map.size - LAUNCHES_KEPT)
  for (const l of oldest) map.delete(l.id)
  return map
}

/** Merges one `launch` or `launch-list` message into the map (a new map when something changed, else `prev`). */
export function reduceLaunches(prev: ReadonlyMap<string, LaunchView>, msg: unknown): ReadonlyMap<string, LaunchView> {
  if (!isRecord(msg)) return prev
  const views = msg.type === 'launch' ? [parseLaunchView(msg.launch)]
    : msg.type === 'launch-list' && Array.isArray(msg.launches) ? msg.launches.slice(0, LAUNCHES_KEPT).map(parseLaunchView)
    : []
  const valid = views.filter((l): l is LaunchView => l !== null)
  if (valid.length === 0) return prev
  const next = new Map(prev)
  for (const l of valid) next.set(l.id, l)
  return capped(next)
}

export function isLaunchEnded(l: LaunchView): boolean {
  return ENDED.has(l.state)
}

/** The launch of this issue that has not ended, if the relay reported one. */
export function activeLaunchFor(launches: ReadonlyMap<string, LaunchView>, repo: string, issue: number): LaunchView | undefined {
  for (const l of launches.values()) if (l.repo === repo && l.issue === issue && !isLaunchEnded(l)) return l
  return undefined
}

/** The most recent launch of this issue (running or ended). */
export function latestLaunchFor(launches: ReadonlyMap<string, LaunchView>, repo: string, issue: number): LaunchView | undefined {
  let best: LaunchView | undefined
  for (const l of launches.values()) if (l.repo === repo && l.issue === issue && (!best || l.requestedAt > best.requestedAt)) best = l
  return best
}

function ending(l: LaunchView, locale: Locale): string {
  if (typeof l.exitCode === 'number') return translate(locale, 'launch.end.code', { code: l.exitCode })
  const signal = safeCode(l.signal)
  return signal ? translate(locale, 'launch.end.signal', { signal }) : ''
}

/** The state in words, from the fact the relay observed: no "started" without a pid, no "session seen" without sessionSeenAt. */
export function launchStateLabel(l: LaunchView, locale: Locale = DEFAULT_LOCALE): string {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const stopAsked = l.stopRequestedAt !== undefined && !isLaunchEnded(l) ? t('launch.state.stopAsked') : ''
  const running = () => (l.pid !== undefined ? t('launch.state.started', { pid: l.pid }) : t('launch.state.startPending'))
  switch (l.state) {
    case 'requested': return t('launch.state.requested') + stopAsked
    case 'started': return running() + stopAsked
    case 'session': return (l.pid !== undefined && l.sessionSeenAt !== undefined ? t('launch.state.session', { pid: l.pid }) : running()) + stopAsked
    case 'exited': return t('launch.state.exited', { end: ending(l, locale) })
    case 'stopped': return t('launch.state.stopped', { end: ending(l, locale) })
    case 'expired': return t('launch.state.expired', { min: LAUNCH_WALL_CLOCK_MIN, end: ending(l, locale) })
    case 'failed': {
      const code = safeCode(l.failure)
      return t('launch.state.failed', { code: code ? ` (${code})` : '' })
    }
  }
}

/** `owner/name` of a github.com issue URL (pull requests are not launchable). */
export function repoOfIssueUrl(url: string): string | undefined {
  const m = ISSUE_URL_RE.exec(url)
  return m ? `${m[1]}/${m[2]}` : undefined
}

/**
 * The command the relay will run, as shown in the confirmation dialog. The session id and the budget are drawn
 * and set by the relay; the tool lists and the prompt are fixed by it (docs/node-inspector.md). The order of the
 * flags is that of buildLaunchCommand (compared by scripts/launch-client.test.ts).
 */
export function launchCommandPreview(req: LaunchRequestBody, locale: Locale = DEFAULT_LOCALE): string {
  const t = (key: MessageKey) => translate(locale, key)
  return `claude -p --worktree issue-${req.issue}-${req.role} --session-id ${t('launch.preview.session')} --output-format stream-json --verbose `
    + `--max-budget-usd ${t('launch.preview.budget')} --permission-mode default --setting-sources project --strict-mcp-config `
    + `--allowedTools ${t('launch.preview.tools')} --disallowedTools ${t('launch.preview.tools')} -- "${t('launch.preview.prompt')}"`
}
