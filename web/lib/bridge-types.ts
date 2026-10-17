/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
 * Exception: ConnectionStatus adds the web-only 'connecting' value (initial state
 * before the relay answers); the extension never sends it.
 */

import { CONTROL_ALL } from './control-chars'
import type { SimulationEvent } from './agent-types'

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
  /** Set by the bridge on events of a history batch (connect/reconnect replay): not live, wall-clock timing unknown */
  replayed?: boolean
  /** Set by the relay on events of an imported transcript (#294): read from a file, never seen live */
  imported?: boolean
}

export interface SessionInfo {
  id: string
  label: string
  /** Label reported by the source, set only when `label` is a name chosen by the user (#246) */
  originalLabel?: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** True when lastActivityTime only stands for the start: usable to sort, never to display */
  lastActivityUnknown?: boolean
  /** Start of the session as its transcript records it; `startTime` stays the origin of the event times */
  recordedStartTime?: number
  /** True when no start is recorded and `startTime` is only when watching began: a duration from it is a lower bound */
  startTimeWatched?: boolean
  /** Agent runtime of the session, when the extension reports it */
  runtime?: 'claude' | 'codex' | 'copilot' | 'pi' | 'gemini' | 'opencode'
  /** Workspace name/path of the session, when known */
  workspace?: string
  /** Working directory of the session, when known */
  cwd?: string
  /** Hash of the git common dir: identical for a repository and all its worktrees; absent outside git */
  projectId?: string
  /** Folder name of the repository's main checkout, shown as the group title */
  projectName?: string
  /** Git branch recorded at the head of the session transcript (untrusted, capped); absent when unrecorded or detached */
  branch?: string
  /** Agent Team this session belongs to (tmux teammate sessions), when known */
  teamName?: string
  /** Teammate name inside the team, when the session is a team member */
  memberName?: string
  /** Session that launched this one (Task), when declared by the source; see session-links.ts */
  parentSessionId?: string
  /** Listed only from the read-only session index: not watched live, so it has no events to replay and is never auto-selected */
  indexedOnly?: boolean
  /** Read once from an imported transcript (#294): not observed live, its state is never current */
  imported?: boolean
  /** When the relay read the imported transcript (ms since epoch) */
  importedAt?: number
}

/** Pseudo project grouping imported sessions: their cwd is a path on another machine, never a local project.
 *  The ':' keeps it apart from real project ids (hex hashes). */
export const IMPORTED_PROJECT_ID = 'imported:transcripts'
export const IMPORTED_PROJECT_NAME = 'Imported transcripts'

/**
 * Simulation event of a bridge event. An imported one (#294) is also a replayed one: it carries no wall-clock
 * proof of work, and its agents are stamped with the imported freshness source.
 */
export function toSimulationEvent(event: AgentEvent): SimulationEvent {
  const imported = event.imported === true
  return {
    time: event.time,
    type: event.type as SimulationEvent['type'],
    payload: event.payload,
    sessionId: event.sessionId,
    ...(event.replayed === true || imported ? { replayed: true } : {}),
    ...(imported ? { imported: true } : {}),
  }
}

/** Pseudo session id of the 'All' tab: union of every session (never sent to or by the extension). */
export const ALL_SESSIONS_ID = '__all__'

/** Prefix of the pseudo session ids that select one whole Agent Team ('team:<name>'). */
export const TEAM_SELECTION_PREFIX = 'team:'

/** Pseudo session id selecting the union of a team's sessions (never sent to or by the extension). */
export function teamSelectionId(teamName: string): string {
  return `${TEAM_SELECTION_PREFIX}${teamName}`
}

/** Team name when `id` is a team pseudo selection, else null. */
export function parseTeamSelection(id: string | null | undefined): string | null {
  return typeof id === 'string' && id.startsWith(TEAM_SELECTION_PREFIX) && id.length > TEAM_SELECTION_PREFIX.length
    ? id.slice(TEAM_SELECTION_PREFIX.length)
    : null
}

/** True for the 'All' tab and for team pseudo selections: views that union several sessions. */
export function isUnionSelection(id: string | null | undefined): boolean {
  return id === ALL_SESSIONS_ID || parseTeamSelection(id) !== null
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching' | 'connecting'

/** Non-blocking user-facing notice raised by the bridge (parse failure, reset, relay state). */
export interface BridgeNotice {
  id: number
  kind: 'parse-error' | 'reset' | 'relay-down' | 'relay-up'
  message: string
}

/** State of an agent launch (#229), mirror of extension/src/protocol.ts: each value is set only once observed by the relay */
export type LaunchState = 'requested' | 'started' | 'session' | 'exited' | 'stopped' | 'expired' | 'failed'

/** What the relay tells local clients about a launch (SSE `launch` / `launch-list`, GET /status `launch`); mirror of extension/src/protocol.ts */
export interface LaunchView {
  id: string
  repo: string
  issue: number
  role: string
  /** `--worktree` name, also the branch name */
  worktree: string
  /** The --session-id chosen by the relay: the key that proves launch <-> session */
  sessionId: string
  state: LaunchState
  /** Present once the spawn was observed */
  pid?: number
  requestedAt: number
  startedAt?: number
  sessionSeenAt?: number
  /** A stop was asked for (or the deadline came); the end is only known from the exit */
  stopRequestedAt?: number
  stopReason?: 'stop' | 'expired' | 'relay-stopped'
  endedAt?: number
  exitCode?: number
  signal?: string
  /** Bounded code: ENOENT, EACCES..., 'spawn-error', 'exit-before-start' */
  failure?: string
  /** Absolute path of the worktree, only when it exists after the end (the work is kept there) */
  worktreePath?: string
  outputBytes: number
  outputDroppedBytes: number
}

/** Mirror of scripts/system-stats.ts SystemSample (SSE `system-stats`, #357). */
export interface SystemUsage { total: number; used: number }
export interface SystemSample {
  ts: number
  cpu: { total: number | null; perCore: (number | null)[] }
  mem: SystemUsage | null
  swap: SystemUsage | null
  disk: SystemUsage | null
  load: [number, number, number] | null
  uptime: number | null
  platformNote: string | null
}

/** View of the relay's SSE `quota` message (#467): `remainingPercent` is 100 - used, `resetsAt` in epoch seconds,
 *  `receivedAt` in epoch milliseconds. A window the relay could not prove is null. */
export interface GaugeView { remainingPercent: number; resetsAt: number }
export interface QuotaSnapshotView {
  fiveHour: GaugeView | null
  sevenDay: GaugeView | null
  receivedAt: number
}

// ─── Runtime validation (messages are untrusted: relay, hooks and window.postMessage) ───

const CONNECTION_STATUSES: readonly string[] = ['connected', 'disconnected', 'watching', 'connecting']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isAgentEvent(v: unknown): v is AgentEvent {
  return isRecord(v)
    && typeof v.time === 'number' && Number.isFinite(v.time)
    && typeof v.type === 'string'
    && isRecord(v.payload)
    && (v.sessionId === undefined || typeof v.sessionId === 'string')
}

/**
 * A known session announced again ('session-started': now watched live, or resumed after inactivity). It turns
 * active and takes the times the source gives (#365): the last write of its transcript, not the moment the
 * message arrived; `now` only when the source gives none. Its label (and alias) stays.
 */
export function resumeSession(known: SessionInfo, announced: SessionInfo, now: number): SessionInfo {
  const { indexedOnly: _indexedOnly, ...live } = known
  return {
    ...live,
    status: 'active',
    lastActivityTime: Number.isFinite(announced.lastActivityTime) ? announced.lastActivityTime : now,
    ...(announced.recordedStartTime !== undefined ? { recordedStartTime: announced.recordedStartTime } : {}),
    ...(announced.startTimeWatched !== undefined ? { startTimeWatched: announced.startTimeWatched } : {}),
  }
}

export function isSessionInfo(v: unknown): v is SessionInfo {
  return isRecord(v)
    && typeof v.id === 'string'
    && typeof v.label === 'string'
    && (v.status === 'active' || v.status === 'completed')
    && typeof v.startTime === 'number'
    && typeof v.lastActivityTime === 'number'
    && (v.lastActivityUnknown === undefined || typeof v.lastActivityUnknown === 'boolean')
    && (v.recordedStartTime === undefined || (typeof v.recordedStartTime === 'number' && Number.isFinite(v.recordedStartTime)))
    && (v.startTimeWatched === undefined || typeof v.startTimeWatched === 'boolean')
    && (v.runtime === undefined || v.runtime === 'claude' || v.runtime === 'codex' || v.runtime === 'copilot' || v.runtime === 'pi' || v.runtime === 'gemini' || v.runtime === 'opencode')
    && (v.workspace === undefined || typeof v.workspace === 'string')
    && (v.cwd === undefined || typeof v.cwd === 'string')
    && (v.projectId === undefined || typeof v.projectId === 'string')
    && (v.projectName === undefined || typeof v.projectName === 'string')
    && (v.branch === undefined || typeof v.branch === 'string')
    && (v.teamName === undefined || typeof v.teamName === 'string')
    && (v.memberName === undefined || typeof v.memberName === 'string')
    && (v.parentSessionId === undefined || typeof v.parentSessionId === 'string')
    && (v.indexedOnly === undefined || typeof v.indexedOnly === 'boolean')
    && (v.imported === undefined || typeof v.imported === 'boolean')
    && (v.importedAt === undefined || (typeof v.importedAt === 'number' && Number.isFinite(v.importedAt)))
}

/** Max length of a session id taken from an untrusted source (parent links) */
export const MAX_SESSION_ID_LEN = 128

/** Max length of a team / member name (same as the team tracker) */
export const MAX_NAME_LEN = 80

/** Untrusted single-line text: control characters removed, trimmed, capped. */
export function cleanLine(v: unknown, max = MAX_NAME_LEN): string {
  if (typeof v !== 'string') return ''
  return v.replace(CONTROL_ALL, '').trim().slice(0, max)
}

/**
 * SessionInfo with its team fields sanitised exactly like the team tracker does (so team tab ids,
 * cluster keys and tracker names agree); an empty result drops the field.
 */
export function sanitizeSessionInfo(s: SessionInfo): SessionInfo {
  const { teamName, memberName, parentSessionId, projectId, projectName, branch, ...rest } = s
  const team = cleanLine(teamName)
  const member = cleanLine(memberName)
  const parent = cleanLine(parentSessionId, MAX_SESSION_ID_LEN)
  // A project group needs both its identity and a title; half of it is dropped
  const pid = cleanLine(projectId, 64)
  const pname = cleanLine(projectName)
  const branchName = cleanLine(branch, 200)
  // Imported sessions get their own group; no other session may claim that pseudo project
  const project = rest.imported === true
    ? { projectId: IMPORTED_PROJECT_ID, projectName: IMPORTED_PROJECT_NAME }
    : pid && pname && pid !== IMPORTED_PROJECT_ID ? { projectId: pid, projectName: pname } : {}
  return {
    ...rest,
    ...(team ? { teamName: team } : {}),
    ...(member ? { memberName: member } : {}),
    ...(parent ? { parentSessionId: parent } : {}),
    ...project,
    ...(branchName ? { branch: branchName } : {}),
  }
}

/**
 * Session to select when none is: active sessions first, then the most recently active. Sessions listed
 * only from the session index are never picked (no events to show, an empty canvas on a finished session).
 */
export function pickAutoSelectSession(sessions: ReadonlyArray<SessionInfo>): string | undefined {
  let best: SessionInfo | undefined
  for (const s of sessions) {
    if (s.indexedOnly) continue
    if (!best) { best = s; continue }
    const sa = s.status === 'active' ? 1 : 0
    const ba = best.status === 'active' ? 1 : 0
    if (sa !== ba ? sa > ba : s.lastActivityTime > best.lastActivityTime) best = s
  }
  return best?.id
}

export function isConnectionStatus(v: unknown): v is ConnectionStatus {
  return typeof v === 'string' && CONNECTION_STATUSES.includes(v)
}

// ─── Operator decisions (#240) ───────────────────────────────────────────────
// Mirrors PermissionRequestMessage and the permission-* messages of extension/src/protocol.ts.

/** A waiting PermissionRequest, as the extension shows it to a panel that declared a decision surface */
export interface PermissionRequestMessage {
  sessionId: string
  /** null when the hook input does not name the call and no single open call of the session matches */
  toolUseId: string | null
  nonce: string
  toolName: string
  /** Tool input as JSON text with sorted keys, cut at 64 KiB */
  inputPreview: string
  inputTruncated: boolean
  /** SHA-256 of the whole input */
  inputSha256: string
  requestedAt: number
  expiresAt: number
}

/** How a request ended (extension decision-journal.ts); `sent` = handed to Claude Code, not proof it was applied */
export type PermissionCloseOutcome = 'sent' | 'expired' | 'answered-elsewhere' | 'surface-closed' | 'shutdown' | 'disabled' | 'journal-failed'

/** `outcome` is a PermissionCloseOutcome; kept as text so a value added later is still relayed */
export interface PermissionClosedMessage { nonce: string; sessionId: string; toolUseId: string | null; outcome: string }
export interface PermissionResultMessage { nonce: string | null; ok: boolean; reason?: string }

/** The three answers the page can give; a redirect is a deny that carries the operator's text to Claude (#387) */
export type PermissionAction = 'approve' | 'deny' | 'redirect'

/** What the page answers: only a redirect carries a message, and it must not be empty */
export type PermissionDecision = { sessionId: string; toolUseId: string | null; nonce: string } & (
  | { action: 'approve' | 'deny' }
  | { action: 'redirect'; message: string }
)

const NONCE_RE = /^[0-9a-f]{32}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const CONTROL_PROBE = new RegExp(CONTROL_ALL.source)
/** The extension cuts the preview at 64 Ki characters; a longer one did not come from it */
const PERMISSION_PREVIEW_MAX = 64 * 1024
const MAX_TOOL_NAME_LEN = 256
const MAX_CODE_LEN = 64

const isNonce = (v: unknown): v is string => typeof v === 'string' && NONCE_RE.test(v)
const isId = (v: unknown, max = MAX_SESSION_ID_LEN): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL_PROBE.test(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * The input as it may be shown: every invisible or control character is written as its JSON escape (\uXXXX),
 * so a bidi override or a zero-width character in a command cannot make it read differently from what runs.
 * The text stays valid JSON for the same value.
 */
export function visibleInput(text: string): string {
  return text.replace(CONTROL_ALL, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** A permission-request payload from the extension, field by field; null when any field is not what it sends */
export function parsePermissionRequest(v: unknown): PermissionRequestMessage | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (!isId(r.sessionId) || !isNonce(r.nonce) || !isId(r.toolName, MAX_TOOL_NAME_LEN)) return null
  if (r.toolUseId !== null && !isId(r.toolUseId)) return null
  if (typeof r.inputPreview !== 'string' || r.inputPreview.length > PERMISSION_PREVIEW_MAX) return null
  if (typeof r.inputTruncated !== 'boolean' || typeof r.inputSha256 !== 'string' || !SHA256_RE.test(r.inputSha256)) return null
  if (!isTime(r.requestedAt) || !isTime(r.expiresAt)) return null
  return {
    sessionId: r.sessionId, toolUseId: r.toolUseId as string | null, nonce: r.nonce, toolName: r.toolName,
    inputPreview: r.inputPreview, inputTruncated: r.inputTruncated, inputSha256: r.inputSha256,
    requestedAt: r.requestedAt, expiresAt: r.expiresAt,
  }
}

export function parsePermissionClosed(v: unknown): PermissionClosedMessage | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (!isNonce(r.nonce) || !isId(r.sessionId) || (r.toolUseId !== null && !isId(r.toolUseId)) || !isId(r.outcome, MAX_CODE_LEN)) return null
  return { nonce: r.nonce, sessionId: r.sessionId, toolUseId: r.toolUseId as string | null, outcome: r.outcome }
}

export function parsePermissionResult(v: unknown): PermissionResultMessage | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if ((r.nonce !== null && !isNonce(r.nonce)) || typeof r.ok !== 'boolean') return null
  if (r.reason !== undefined && !isId(r.reason, MAX_CODE_LEN)) return null
  const nonce = r.nonce as string | null
  return r.reason === undefined ? { nonce, ok: r.ok } : { nonce, ok: r.ok, reason: r.reason }
}
