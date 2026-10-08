/**
 * Agent Team config + inbox watcher (#42, #35).
 *
 * Reads ~/.claude/teams/<team>/config.json and ~/.claude/teams/<team>/inboxes/<member>.json
 * (poll based, like the other watchers: no per-file fs.watch handles, so the watcher count is
 * bounded by construction) and reports:
 *  - team_info when a team is discovered or its roster changes (debounced),
 *  - one message_sent per inbox message (de-duplicated, every shape tolerated),
 *  - members that left the roster ('done' teammates),
 *  - team/member tags for sessions (lead and separate tmux member sessions).
 *
 * Everything read here is untrusted: size caps, regular files only (symlinks refused), real path
 * must stay inside the teams directory, bounded counts, sanitized strings. No vscode dependency.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { TeamInfoPayload } from './protocol'
import {
  TEAM_SCAN_INTERVAL_MS, TEAM_INFO_DEBOUNCE_MS, TEAM_MAX_TEAMS, TEAM_MAX_MEMBERS, TEAM_CONFIG_MAX_BYTES,
  TEAM_INBOX_MAX_FILES, TEAM_INBOX_MAX_BYTES, TEAM_INBOX_FIRST_SCAN_MAX, TEAM_INBOX_MAX_MESSAGES, TEAM_INBOX_SEEN_MAX,
  TEAM_JOIN_MATCH_WINDOW_MS, SESSION_HEADER_MAX_BYTES, TEAM_NAME_MAX,
} from './constants'
import { readJsonFileSafe, readTailTextSafe, isPathInside, foldPathCase } from './fs-utils'
import { isValidSessionId } from './relay-guards'
import { sanitizeAgentName, sanitizeMessageContent } from './team-links'
import { sanitizeTeamColor, sanitizeTeamField } from './teammate'
import { createLogger } from './logger'

const log = createLogger('TeamWatcher')

// ─── Pure parsing ────────────────────────────────────────────────────────────

export interface TeamConfigMember {
  name: string
  agentType?: string
  color?: string
  backendType?: string
  joinedAt?: number
  cwd?: string
}

export interface TeamConfig {
  name: string
  leadSessionId: string
  /** Name of the lead (part before '@' of leadAgentId); it is drawn as the orchestrator */
  leadName?: string
  /** Members EXCLUDING the lead, at most TEAM_MAX_MEMBERS */
  members: TeamConfigMember[]
}

function cleanCwd(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return undefined
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(value) ? undefined : value
}

/** Branch name as Claude Code records it in `gitBranch`; a detached HEAD or an odd value is no branch. */
export function cleanBranch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  // eslint-disable-next-line no-control-regex
  if (v.length === 0 || v.length > 200 || v === 'HEAD' || /[\x00-\x1f\x7f]/.test(v)) return undefined
  return v
}

function nameFromAgentId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const at = value.indexOf('@')
  return sanitizeAgentName(at > 0 ? value.slice(0, at) : value) ?? undefined
}

/** Validate a parsed config.json. Returns null unless it names a valid lead session. */
export function parseTeamConfig(raw: unknown, dirName: string): TeamConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const leadSessionId = r.leadSessionId
  if (!isValidSessionId(leadSessionId)) return null
  const name = sanitizeTeamField(r.name) ?? sanitizeTeamField(dirName)
  if (!name) return null
  const leadName = nameFromAgentId(r.leadAgentId)
  const members: TeamConfigMember[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.members)) {
    for (const item of r.members) {
      if (members.length >= TEAM_MAX_MEMBERS) break
      if (!item || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      const memberName = sanitizeAgentName(m.name) ?? nameFromAgentId(m.agentId)
      if (!memberName || seen.has(memberName)) continue
      seen.add(memberName)
      const isLead = memberName === leadName || (typeof m.agentId === 'string' && m.agentId === r.leadAgentId) || m.tmuxPaneId === 'leader'
      if (isLead) continue
      members.push({
        name: memberName,
        agentType: sanitizeTeamField(m.agentType),
        color: sanitizeTeamColor(m.color),
        backendType: sanitizeTeamField(m.backendType),
        joinedAt: typeof m.joinedAt === 'number' && Number.isFinite(m.joinedAt) ? m.joinedAt : undefined,
        cwd: cleanCwd(m.cwd),
      })
    }
  }
  return { name, leadSessionId, ...(leadName ? { leadName } : {}), members }
}

/** TeamInfoPayload for a config; `memberSessions` maps member name -> session id (tmux members). */
export function toTeamInfoPayload(cfg: TeamConfig, memberSessions: ReadonlyMap<string, string> = new Map()): TeamInfoPayload {
  return {
    teamName: cfg.name,
    leadSessionId: cfg.leadSessionId,
    ...(cfg.leadName ? { leadName: cfg.leadName } : {}),
    members: cfg.members.map(m => ({
      name: m.name,
      ...(m.agentType ? { agentType: m.agentType } : {}),
      ...(m.color ? { color: m.color } : {}),
      ...(m.backendType ? { backendType: m.backendType } : {}),
      ...(memberSessions.has(m.name) ? { sessionId: memberSessions.get(m.name) } : {}),
      ...(m.joinedAt !== undefined ? { joinedAt: m.joinedAt } : {}),
    })),
  }
}

export interface InboxMessage {
  from?: string
  /** Sanitized and capped */
  text: string
  timestamp?: string | number
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value) ?? '' } catch { return '' }
  }
  return ''
}

/**
 * Parse the tail of an inbox file that is too big to read whole. The file is a JSON array of
 * messages: the cut head is dropped up to the first element boundary (`}, {`) that yields valid JSON.
 * undefined when nothing usable is found.
 */
export function parseInboxTail(text: string): unknown[] | undefined {
  const boundary = /\}\s*,\s*\{/g
  let m: RegExpExecArray | null
  let tries = 0
  while ((m = boundary.exec(text)) && tries++ < 16) {
    const start = text.indexOf('{', m.index + 1)
    try {
      const parsed: unknown = JSON.parse('[' + text.slice(start))
      if (Array.isArray(parsed)) return parsed
    } catch { /* boundary inside a string, or a trailing partial write: try the next one */ }
  }
  return undefined
}

/**
 * Normalize an inbox file. The exact message shape is not confirmed, so everything is optional:
 * the file may be an array (or { messages: [...] }) of strings or objects carrying
 * from / to / text / content / message / body / summary / timestamp. Only the last
 * TEAM_INBOX_MAX_MESSAGES entries are kept; entries without any text are dropped.
 */
export function parseInbox(raw: unknown): InboxMessage[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages)) {
    list = (raw as { messages: unknown[] }).messages
  }
  if (list.length > TEAM_INBOX_MAX_MESSAGES) list = list.slice(list.length - TEAM_INBOX_MAX_MESSAGES)
  const out: InboxMessage[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      const text = sanitizeMessageContent(item)
      if (text) out.push({ text })
      continue
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const m = item as Record<string, unknown>
    let text = ''
    for (const key of ['text', 'content', 'message', 'body']) {
      text = sanitizeMessageContent(stringify(m[key]))
      if (text) break
    }
    if (!text) text = sanitizeMessageContent(stringify(m.summary))
    if (!text) continue
    const fromRaw = m.from ?? m.sender
    const from = sanitizeAgentName(typeof fromRaw === 'object' && fromRaw ? (fromRaw as { name?: unknown }).name : fromRaw) ?? undefined
    const ts = m.timestamp ?? m.time ?? m.createdAt
    out.push({
      ...(from ? { from } : {}),
      text,
      ...(typeof ts === 'string' || typeof ts === 'number' ? { timestamp: typeof ts === 'string' ? ts.slice(0, 64) : ts } : {}),
    })
  }
  return out
}

/** Stable per-message keys: content hash plus the occurrence index of identical messages. */
export function inboxKeys(messages: readonly InboxMessage[]): string[] {
  const counts = new Map<string, number>()
  return messages.map(m => {
    const h = crypto.createHash('sha1').update(`${m.from ?? ''}\u0000${m.timestamp ?? ''}\u0000${m.text}`).digest('hex').slice(0, 16)
    const n = counts.get(h) ?? 0
    counts.set(h, n + 1)
    return `${h}#${n}`
  })
}

export interface SessionHeader {
  cwd?: string
  /** Git branch recorded by the transcript at its first entry carrying one (absent when detached or unrecorded) */
  branch?: string
  /** Epoch ms of the first timestamped entry */
  startMs?: number
}

/** Read cwd + first timestamp from the head of a session transcript (bounded, regular files only). */
export function readSessionHeader(filePath: string): SessionHeader {
  try {
    const st = fs.lstatSync(filePath)
    if (!st.isFile()) return {}
    const fd = fs.openSync(filePath, 'r')
    let text: string
    try {
      const buf = Buffer.alloc(Math.min(SESSION_HEADER_MAX_BYTES, st.size))
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      text = buf.toString('utf-8', 0, n)
    } finally {
      fs.closeSync(fd)
    }
    const header: SessionHeader = {}
    let branchSeen = false // the first entry that records a branch decides, even a detached HEAD
    for (const line of text.split('\n')) {
      if (header.cwd !== undefined && header.startMs !== undefined && branchSeen) break
      if (!line.startsWith('{')) continue
      try {
        const e = JSON.parse(line) as { cwd?: unknown; timestamp?: unknown; gitBranch?: unknown }
        if (header.cwd === undefined) header.cwd = cleanCwd(e.cwd)
        if (!branchSeen && typeof e.gitBranch === 'string') {
          branchSeen = true
          const branch = cleanBranch(e.gitBranch)
          if (branch) header.branch = branch
        }
        if (header.startMs === undefined && typeof e.timestamp === 'string') {
          const t = Date.parse(e.timestamp)
          if (Number.isFinite(t)) header.startMs = t
        }
      } catch { /* partial last line or garbage */ }
    }
    return header
  } catch {
    return {}
  }
}

function sameDir(a: string, b: string): boolean {
  return foldPathCase(path.resolve(a)) === foldPathCase(path.resolve(b))
}

export interface MemberSessionCandidate { sessionId: string; cwd?: string; startMs: number }

/**
 * Best-effort match of a tmux member to the separate session it runs: same cwd, started at or
 * shortly after joinedAt (within TEAM_JOIN_MATCH_WINDOW_MS); the closest start wins.
 * `taken` session ids (lead, other members) are skipped.
 */
export function matchMemberSession(
  member: Pick<TeamConfigMember, 'cwd' | 'joinedAt'>,
  candidates: readonly MemberSessionCandidate[],
  taken: ReadonlySet<string> = new Set(),
): string | undefined {
  if (!member.cwd || member.joinedAt === undefined) return undefined
  const slack = 5000
  let best: { id: string; delta: number } | undefined
  for (const c of candidates) {
    if (taken.has(c.sessionId) || !c.cwd || !sameDir(c.cwd, member.cwd)) continue
    const delta = c.startMs - member.joinedAt
    if (delta < -slack || delta > TEAM_JOIN_MATCH_WINDOW_MS) continue
    if (!best || Math.abs(delta) < best.delta) best = { id: c.sessionId, delta: Math.abs(delta) }
  }
  return best?.id
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

export interface TeamSessionTags { teamName: string; memberName?: string }

export interface TeamWatcherHost {
  /** Sessions the runtime currently watches */
  listSessions(): Array<{ sessionId: string; filePath: string; startTime: number }>
  emitTeamInfo(sessionId: string, payload: TeamInfoPayload): void
  /** One inbox message; the runtime routes it through the transcript parser's dedupe */
  emitInbox(sessionId: string, from: string, to: string, content: string): void
  /** The lead's team name maps to the orchestrator node */
  setLeadAlias?(sessionId: string, leadName: string): void
  /** Members dropped from the roster (or the whole team vanished): their teammates are 'done' */
  onMembersGone?(sessionId: string, teamName: string, names: Set<string>): void
  /** A session became (or stopped being) a team session */
  onSessionTags?(sessionId: string, tags: TeamSessionTags | null): void
}

export interface TeamWatcherOptions {
  /** ~/.claude/teams (injected in tests) */
  teamsDir: string
  host: TeamWatcherHost
  /** Workspace roots to serve; null = all workspaces */
  workspaces: string[] | null
  intervalMs?: number
  debounceMs?: number
}

interface InboxState { sig: string; seen: Set<string> }

interface TeamState {
  cfg: TeamConfig
  payload: TeamInfoPayload
  sig: string
  emittedKey?: string
  timer?: NodeJS.Timeout
  inboxes: Map<string, InboxState>
  memberSessions: Map<string, string>
}

export class TeamWatcher {
  private teams = new Map<string, TeamState>()
  private headers = new Map<string, SessionHeader>()
  private tags = new Map<string, string>()
  private interval: NodeJS.Timeout | null = null
  private disposed = false
  private readonly intervalMs: number
  private readonly debounceMs: number
  private readonly teamsDir: string

  constructor(private readonly opts: TeamWatcherOptions) {
    this.intervalMs = opts.intervalMs ?? TEAM_SCAN_INTERVAL_MS
    this.debounceMs = opts.debounceMs ?? TEAM_INFO_DEBOUNCE_MS
    this.teamsDir = opts.teamsDir
  }

  start(): void {
    if (this.interval || this.disposed) return
    this.scan()
    this.interval = setInterval(() => this.scan(), this.intervalMs)
    this.interval.unref?.()
  }

  /** Number of teams currently tracked (bounded by TEAM_MAX_TEAMS). */
  get teamCount(): number { return this.teams.size }

  /** Tags of a session ({teamName, memberName}) for session list entries. */
  getSessionTags(sessionId: string): TeamSessionTags | undefined {
    const key = this.tags.get(sessionId)
    if (key === undefined) return undefined
    const [teamName, memberName] = key.split('\u0000')
    return { teamName, ...(memberName ? { memberName } : {}) }
  }

  /** Forget everything about a session that ended (cleanup on session end). */
  forgetSession(sessionId: string): void {
    this.headers.delete(sessionId)
    this.tags.delete(sessionId)
    for (const t of this.teams.values()) {
      if (t.cfg.leadSessionId === sessionId) t.emittedKey = undefined
      for (const [member, sid] of t.memberSessions) if (sid === sessionId) t.memberSessions.delete(member)
    }
  }

  /** Re-send team_info for the given sessions (a webview connected late). */
  replay(sessionIds?: readonly string[]): void {
    for (const t of this.teams.values()) {
      if (sessionIds && !sessionIds.includes(t.cfg.leadSessionId)) continue
      if (!this.isWatched(t.cfg.leadSessionId)) continue
      this.fire(t)
    }
  }

  private isWatched(sessionId: string): boolean {
    return this.opts.host.listSessions().some(s => s.sessionId === sessionId)
  }

  private inWorkspaces(cwd: string | undefined): boolean {
    const roots = this.opts.workspaces
    if (roots === null) return true
    if (!cwd) return false
    let real = path.resolve(cwd)
    try { real = fs.realpathSync(real) } catch { /* nonexistent cwd: compare as given */ }
    const f = foldPathCase(real)
    return roots.some(r => {
      let root = path.resolve(r)
      try { root = fs.realpathSync(root) } catch { /* as given */ }
      const rf = foldPathCase(root)
      return f === rf || f.startsWith(rf + path.sep)
    })
  }

  /** One pass over the teams directory. Cheap enough to run every TEAM_SCAN_INTERVAL_MS. */
  scan(): void {
    if (this.disposed) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(this.teamsDir, { withFileTypes: true }) } catch { entries = [] }
    const dirs = entries
      .filter(e => e.isDirectory() && !e.isSymbolicLink() && e.name.length <= TEAM_NAME_MAX * 2)
      .map(e => e.name)
      .sort()
      .slice(0, TEAM_MAX_TEAMS)
    const live = new Set(dirs)
    const sessions = this.opts.host.listSessions()

    for (const [dirName, state] of [...this.teams]) {
      if (!live.has(dirName)) this.dropTeam(dirName, state)
    }
    for (const dirName of dirs) {
      try { this.scanTeam(dirName, sessions) } catch (err) { log.debug('Team scan failed:', err) }
    }
  }

  private dropTeam(dirName: string, state: TeamState): void {
    if (state.timer) clearTimeout(state.timer)
    this.teams.delete(dirName)
    if (this.isWatched(state.cfg.leadSessionId)) {
      this.opts.host.onMembersGone?.(state.cfg.leadSessionId, state.cfg.name, new Set(state.cfg.members.map(m => m.name)))
    }
    this.untag(state.cfg.leadSessionId)
    for (const sid of state.memberSessions.values()) this.untag(sid)
  }

  private scanTeam(dirName: string, sessions: ReturnType<TeamWatcherHost['listSessions']>): void {
    const teamDir = path.join(this.teamsDir, dirName)
    const raw = readJsonFileSafe(path.join(teamDir, 'config.json'), TEAM_CONFIG_MAX_BYTES, this.teamsDir)
    const cfg = parseTeamConfig(raw, dirName)
    const prev = this.teams.get(dirName)
    if (!cfg) {
      // Unreadable or invalid config: keep what we know (a half-written file must not drop teammates)
      return
    }
    const leadWatched = sessions.some(s => s.sessionId === cfg.leadSessionId)
    const relevant = leadWatched || this.opts.workspaces === null || cfg.members.some(m => this.inWorkspaces(m.cwd))
    if (!relevant) {
      if (prev) this.dropTeam(dirName, prev)
      return
    }
    if (!prev && this.teams.size >= TEAM_MAX_TEAMS) return

    // Separate-session (tmux) members: match by cwd + joinedAt against discovered session files
    const memberSessions = new Map<string, string>()
    const taken = new Set<string>([cfg.leadSessionId])
    const candidates: MemberSessionCandidate[] = []
    if (cfg.members.some(m => m.backendType !== 'in-process' && m.cwd)) {
      for (const s of sessions) {
        if (s.sessionId === cfg.leadSessionId) continue
        let h = this.headers.get(s.sessionId)
        if (!h) {
          h = readSessionHeader(s.filePath)
          if (h.cwd !== undefined) {
            if (this.headers.size >= 512) this.headers.delete(this.headers.keys().next().value as string)
            this.headers.set(s.sessionId, h)
          }
        }
        candidates.push({ sessionId: s.sessionId, cwd: h.cwd, startMs: h.startMs ?? s.startTime })
      }
      const ordered = [...cfg.members].sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))
      for (const m of ordered) {
        if (m.backendType === 'in-process') continue
        const sid = matchMemberSession(m, candidates, taken)
        if (sid) { memberSessions.set(m.name, sid); taken.add(sid) }
      }
    }

    const payload = toTeamInfoPayload(cfg, memberSessions)
    const sig = JSON.stringify(payload)
    const state: TeamState = prev ?? { cfg, payload, sig: '', inboxes: new Map(), memberSessions }

    // Roster shrink -> those teammates are done
    if (prev) {
      const now = new Set(cfg.members.map(m => m.name))
      const gone = new Set(prev.cfg.members.map(m => m.name).filter(n => !now.has(n)))
      if (gone.size > 0 && leadWatched) this.opts.host.onMembersGone?.(cfg.leadSessionId, cfg.name, gone)
    }
    state.cfg = cfg
    state.payload = payload
    state.memberSessions = memberSessions
    this.teams.set(dirName, state)

    // Session tags (lead + tmux members) so the UI can group tabs
    if (leadWatched) this.tag(cfg.leadSessionId, { teamName: cfg.name, ...(cfg.leadName ? { memberName: cfg.leadName } : {}) })
    for (const [member, sid] of memberSessions) this.tag(sid, { teamName: cfg.name, memberName: member })

    if (sig !== state.sig) {
      // First discovery is reported at once; later roster changes are debounced
      const first = state.sig === ''
      state.sig = sig
      if (state.timer) clearTimeout(state.timer)
      if (first || this.debounceMs <= 0) this.fire(state)
      else state.timer = setTimeout(() => { state.timer = undefined; this.fire(state) }, this.debounceMs)
    } else if (!state.timer && leadWatched && state.emittedKey !== `${cfg.leadSessionId}|${sig}`) {
      // Lead session appeared (or was re-attached) after the config was first seen
      this.fire(state)
    }

    if (leadWatched) {
      if (cfg.leadName) this.opts.host.setLeadAlias?.(cfg.leadSessionId, cfg.leadName)
      this.scanInboxes(state, teamDir)
    }
  }

  private fire(state: TeamState): void {
    if (this.disposed) return
    const lead = state.cfg.leadSessionId
    if (!this.isWatched(lead)) return
    state.emittedKey = `${lead}|${state.sig}`
    this.opts.host.emitTeamInfo(lead, state.payload)
  }

  private tag(sessionId: string, tags: TeamSessionTags): void {
    const key = `${tags.teamName}\u0000${tags.memberName ?? ''}`
    if (this.tags.get(sessionId) === key) return
    this.tags.set(sessionId, key)
    this.opts.host.onSessionTags?.(sessionId, tags)
  }

  private untag(sessionId: string): void {
    if (!this.tags.delete(sessionId)) return
    this.opts.host.onSessionTags?.(sessionId, null)
  }

  private scanInboxes(state: TeamState, teamDir: string): void {
    const inboxDir = path.join(teamDir, 'inboxes')
    let names: string[]
    try {
      const st = fs.lstatSync(inboxDir)
      if (!st.isDirectory()) return
      if (!isPathInside(fs.realpathSync(inboxDir), fs.realpathSync(this.teamsDir))) return
      names = fs.readdirSync(inboxDir).filter(n => n.endsWith('.json') && n.length <= TEAM_NAME_MAX * 2 + 5).sort().slice(0, TEAM_INBOX_MAX_FILES)
    } catch { return }

    const present = new Set(names)
    for (const known of [...state.inboxes.keys()]) if (!present.has(known)) state.inboxes.delete(known)

    for (const fileName of names) {
      const owner = sanitizeAgentName(fileName.slice(0, -'.json'.length))
      if (!owner) continue
      const filePath = path.join(inboxDir, fileName)
      let sig: string
      let size: number
      try {
        const st = fs.lstatSync(filePath)
        if (!st.isFile()) continue
        size = st.size
        sig = `${st.size}:${st.mtimeMs}`
      } catch { continue }
      let inbox = state.inboxes.get(fileName)
      if (inbox && inbox.sig === sig) continue

      let raw: unknown
      if (size > TEAM_INBOX_MAX_BYTES) {
        // Too big to read whole: the newest messages are at the end of the array
        const tail = readTailTextSafe(filePath, TEAM_INBOX_MAX_BYTES, this.teamsDir)
        raw = tail ? parseInboxTail(tail.text) : undefined
      } else {
        raw = readJsonFileSafe(filePath, TEAM_INBOX_MAX_BYTES, this.teamsDir)
      }
      if (raw === undefined) continue // half-written: retry next scan
      const messages = parseInbox(raw)
      const firstSight = !inbox
      if (!inbox) { inbox = { sig, seen: new Set() }; state.inboxes.set(fileName, inbox) }
      inbox.sig = sig
      // An emptied inbox means "delivered": identical messages sent later are new again
      if (messages.length === 0) { inbox.seen.clear(); continue }
      const keys = inboxKeys(messages)
      const fallbackFrom = state.cfg.leadName ?? 'team-lead'
      // First sight of this inbox: only the newest messages are replayed (all are remembered), so
      // history cannot flood the replay buffer and evict early agent_spawn / team_info events.
      const replayFrom = firstSight ? Math.max(0, messages.length - TEAM_INBOX_FIRST_SCAN_MAX) : 0
      for (let i = 0; i < messages.length; i++) {
        if (inbox.seen.has(keys[i])) continue
        inbox.seen.add(keys[i])
        if (inbox.seen.size > TEAM_INBOX_SEEN_MAX) inbox.seen.delete(inbox.seen.values().next().value as string)
        if (i < replayFrom) continue
        const m = messages[i]
        this.opts.host.emitInbox(state.cfg.leadSessionId, m.from ?? fallbackFrom, owner, m.text)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    for (const t of this.teams.values()) if (t.timer) clearTimeout(t.timer)
    this.teams.clear()
    this.headers.clear()
    this.tags.clear()
  }
}
