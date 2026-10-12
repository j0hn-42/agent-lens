/**
 * Process supervisor of "launch an agent on an issue" (#229, part 2 of 4). It starts nothing by itself: the route
 * (routes/launch.ts, disabled unless the relay was started with --allow-launch) hands it a command built by the pure
 * launch-policy module. Spawn, group kill, clock, journal and id source are injected, so the whole life cycle is
 * tested without a process.
 *
 * Life cycle, every state set ONLY when its fact was observed (reading-the-ui.md):
 *   requested -> started (the child's 'spawn' event, with its pid) -> session (the transcript of OUR --session-id was seen)
 *   -> exited (exit code) | stopped (we signalled, then saw the exit) | expired (wall clock, then the exit) | failed
 * "failed" is a spawn that threw, an 'error' event, or an exit seen before any start. Asking for a stop does not make a
 * launch "stopped": only the exit does (`stopRequestedAt` records the request).
 *
 * Caps: 1 simultaneous launch by default (2 at most), 1 per issue, 60 minutes of wall clock, 256 KiB of output kept in a
 * ring buffer (never shown, only counted). Stop: SIGTERM to the process group, SIGKILL 10 s later. Dispose (relay exit):
 * SIGKILL at once, the process is going away and no timer would survive it.
 */
import * as childProcess from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { LAUNCH_CAPS, type LaunchCommand, type LaunchRequest } from '../extension/src/launch-policy'

export const KILL_GRACE_MS = 10_000
const HISTORY_MAX_DEFAULT = 20
const FAILURE_CODE_RE = /^[A-Z][A-Z0-9_]{1,30}$/

export type LaunchState = 'requested' | 'started' | 'session' | 'exited' | 'stopped' | 'expired' | 'failed'
const TERMINAL: ReadonlySet<LaunchState> = new Set(['exited', 'stopped', 'expired', 'failed'])
export type StopReason = 'stop' | 'expired' | 'relay-stopped'

/** What clients get (SSE, GET /status): facts only. Never argv, never the output, never the issue text. */
export interface LaunchView {
  id: string
  repo: string
  issue: number
  role: string
  /** `--worktree` name, also the branch name */
  worktree: string
  /** The --session-id we chose: the key that proves launch <-> session */
  sessionId: string
  state: LaunchState
  /** Present once the spawn was observed */
  pid?: number
  requestedAt: number
  startedAt?: number
  sessionSeenAt?: number
  /** A stop was asked for (or the deadline came) at this time; the end is only known from the exit */
  stopRequestedAt?: number
  stopReason?: StopReason
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

export interface JournalEntry {
  ts?: string
  event: 'requested' | 'started' | 'session' | 'stop-requested' | 'signal-failed' | 'killed-on-dispose' | 'ended' | 'refused'
  id?: string
  repo?: string
  issue?: number
  role?: string
  uuid?: string
  pid?: number
  argv?: string[]
  state?: LaunchState
  exitCode?: number
  signal?: string
  durationMs?: number
  reason?: string
}

export interface Journal { append(entry: JournalEntry): boolean }

interface DataSource { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown; on(event: 'error', fn: () => void): unknown }
/** The part of a ChildProcess the supervisor uses */
export interface ChildLike {
  pid?: number
  stdout?: DataSource | null
  stderr?: DataSource | null
  on(event: 'spawn', fn: () => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  on(event: 'exit', fn: (code: number | null, signal: string | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface SpawnOptions {
  cwd: string
  env: Record<string, string>
  shell: false
  detached: true
  stdio: ['ignore', 'pipe', 'pipe']
  windowsHide: true
}
export type SpawnFn = (file: string, args: string[], opts: SpawnOptions) => ChildLike
export type KillGroupFn = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void

export interface Clock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export const defaultClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimer: h => clearTimeout(h as NodeJS.Timeout),
}

export const defaultSpawn: SpawnFn = (file, args, opts) => childProcess.spawn(file, args, opts) as unknown as ChildLike

/** The whole process group (the child leads its own, `detached`), so its children die with it. Windows has no groups. */
export const defaultKillGroup: KillGroupFn = (pid, signal) => {
  process.kill(process.platform === 'win32' ? pid : -pid, signal)
}

/** Exactly the variables claude and gh need. Nothing of the relay's own configuration (AGENT_LENS_*), no NODE_OPTIONS, no LD_*. */
const ENV_ALLOWED = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'SHELL',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
])
const ENV_PREFIXES = ['LC_']

export function launchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    if (ENV_ALLOWED.has(k) || ENV_PREFIXES.some(p => k.startsWith(p))) out[k] = v
  }
  return out
}

/** Keeps the last `capacity` bytes written, counts the rest as dropped. Memory is fixed. */
export class RingBuffer {
  private readonly buf: Buffer
  private head = 0
  private len = 0
  totalBytes = 0
  constructor(private readonly capacity: number) { this.buf = Buffer.alloc(capacity) }
  get droppedBytes(): number { return this.totalBytes - this.len }
  write(chunk: Buffer): void {
    this.totalBytes += chunk.length
    if (chunk.length === 0) return
    if (chunk.length >= this.capacity) {
      chunk.copy(this.buf, 0, chunk.length - this.capacity)
      this.head = 0
      this.len = this.capacity
      return
    }
    const first = Math.min(chunk.length, this.capacity - this.head)
    chunk.copy(this.buf, this.head, 0, first)
    if (first < chunk.length) chunk.copy(this.buf, 0, first)
    this.head = (this.head + chunk.length) % this.capacity
    this.len = Math.min(this.capacity, this.len + chunk.length)
  }
  toString(): string {
    if (this.len < this.capacity) return this.buf.toString('utf8', 0, this.len)
    return Buffer.concat([this.buf.subarray(this.head), this.buf.subarray(0, this.head)]).toString('utf8')
  }
}

export type StartRefusal = 'concurrent' | 'issue-active' | 'journal' | 'disposed' | 'command'
export type StartResult = { ok: true; launch: LaunchView } | { ok: false; reason: StartRefusal }
export type StopResult = { ok: true; launch: LaunchView } | { ok: false; reason: 'unknown' | 'ended' }

export interface SupervisorDeps {
  /** cwd of the child (the workspace, whose origin was checked) */
  workspace: string
  spawn?: SpawnFn
  killGroup?: KillGroupFn
  journal: Journal
  clock?: Clock
  randomId?: () => string
  /** The relay's environment; filtered by {@link launchEnv} */
  env?: NodeJS.ProcessEnv
  /** 1 (default) or 2 */
  maxConcurrent?: number
  wallClockMs?: number
  historyMax?: number
  onChange?: (view: LaunchView) => void
  pathExists?: (p: string) => boolean
}

interface Record_ {
  view: LaunchView
  command: LaunchCommand
  child: ChildLike | null
  ring: RingBuffer
  pendingSession: boolean
  wallTimer: unknown
  killTimer: unknown
  signalled: boolean
}

export interface LaunchSupervisor {
  /** Why a start would be refused right now, or null (cheap pre-check; `start` checks again) */
  check(req: LaunchRequest): StartRefusal | null
  start(req: LaunchRequest, command: LaunchCommand): StartResult
  stop(id: string): StopResult
  /** The relay saw a transcript for this session id */
  sessionSeen(sessionId: string): void
  get(id: string): LaunchView | undefined
  list(): LaunchView[]
  /** Last bytes of stdout+stderr (internal diagnostics; never sent to clients) */
  tail(id: string): string
  /** Journal a refusal: a fixed reason and, when it was validated, the request. Never raw input. */
  recordRefusal(reason: string, req?: LaunchRequest): void
  dispose(): void
}

export function createLaunchSupervisor(deps: SupervisorDeps): LaunchSupervisor {
  const maxConcurrent = deps.maxConcurrent ?? LAUNCH_CAPS.concurrentDefault
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > LAUNCH_CAPS.concurrentMax) {
    throw new Error(`maxConcurrent must be an integer from 1 to ${LAUNCH_CAPS.concurrentMax}`)
  }
  const spawn = deps.spawn ?? defaultSpawn
  const killGroup = deps.killGroup ?? defaultKillGroup
  const clock = deps.clock ?? defaultClock
  const randomId = deps.randomId ?? (() => crypto.randomBytes(8).toString('hex'))
  const wallClockMs = deps.wallClockMs ?? LAUNCH_CAPS.wallClockMs
  const historyMax = deps.historyMax ?? HISTORY_MAX_DEFAULT
  const pathExists = deps.pathExists ?? ((p: string) => fs.existsSync(p))
  const env = launchEnv(deps.env ?? process.env)
  const records = new Map<string, Record_>()
  let disposed = false

  const isActive = (r: Record_) => !TERMINAL.has(r.view.state)
  const issueKey = (req: LaunchRequest) => `${req.repo.toLowerCase()}#${req.issue}`
  const snapshot = (r: Record_): LaunchView => ({ ...r.view, outputBytes: r.ring.totalBytes, outputDroppedBytes: r.ring.droppedBytes })
  const announce = (r: Record_) => { try { deps.onChange?.(snapshot(r)) } catch { /* a listener must not break the life cycle */ } }
  const note = (r: Record_ | null, entry: JournalEntry): boolean => {
    const base: JournalEntry = { ts: new Date(clock.now()).toISOString(), ...entry }
    if (r) Object.assign(base, { id: r.view.id, repo: r.view.repo, issue: r.view.issue, role: r.view.role, uuid: r.view.sessionId, ...entry })
    try { return deps.journal.append(base) } catch { return false }
  }

  function check(req: LaunchRequest): StartRefusal | null {
    if (disposed) return 'disposed'
    const key = issueKey(req)
    let running = 0
    for (const r of records.values()) {
      if (!isActive(r)) continue
      running++
      if (issueKey(r.view) === key) return 'issue-active'
    }
    return running >= maxConcurrent ? 'concurrent' : null
  }

  function clearTimers(r: Record_) {
    if (r.wallTimer !== undefined) { clock.clearTimer(r.wallTimer); r.wallTimer = undefined }
    if (r.killTimer !== undefined) { clock.clearTimer(r.killTimer); r.killTimer = undefined }
  }

  function trimHistory() {
    const ended = [...records.values()].filter(r => !isActive(r))
    for (const r of ended.slice(0, Math.max(0, ended.length - historyMax))) records.delete(r.view.id)
  }

  function finish(r: Record_, state: LaunchState, extra: Partial<LaunchView> = {}) {
    clearTimers(r)
    const endedAt = clock.now()
    r.view = { ...r.view, state, endedAt, ...extra }
    if (r.view.worktree) {
      const wt = path.join(deps.workspace, '.claude', 'worktrees', r.view.worktree)
      let there = false
      try { there = pathExists(wt) } catch { /* unknown: not shown */ }
      if (there) r.view.worktreePath = wt
    }
    note(r, {
      event: 'ended', state, pid: r.view.pid, exitCode: r.view.exitCode, signal: r.view.signal,
      reason: r.view.failure ?? r.view.stopReason, durationMs: endedAt - (r.view.startedAt ?? r.view.requestedAt),
    })
    announce(r)
    trimHistory()
  }

  function signalGroup(r: Record_, signal: 'SIGTERM' | 'SIGKILL') {
    const pid = r.view.pid
    if (pid === undefined) { try { r.child?.kill(signal) } catch { /* gone */ } return }
    try {
      killGroup(pid, signal)
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'ESRCH') return // already gone: the exit event settles the state
      note(r, { event: 'signal-failed', pid, signal, reason: String((err as { code?: unknown })?.code ?? 'error').slice(0, 32) })
      try { r.child?.kill(signal) } catch { /* gone */ }
    }
  }

  /** Ask the run to end: SIGTERM now (once the pid is known), SIGKILL after the grace period. */
  function requestStop(r: Record_, reason: StopReason) {
    if (r.view.stopRequestedAt !== undefined) return
    r.view = { ...r.view, stopRequestedAt: clock.now(), stopReason: reason }
    note(r, { event: 'stop-requested', reason, pid: r.view.pid })
    announce(r)
    if (r.view.pid !== undefined) sendTerm(r)
  }

  function sendTerm(r: Record_) {
    if (r.signalled) return
    r.signalled = true
    signalGroup(r, 'SIGTERM')
    r.killTimer = clock.setTimer(() => { r.killTimer = undefined; if (isActive(r)) signalGroup(r, 'SIGKILL') }, KILL_GRACE_MS)
  }

  function onSpawn(r: Record_) {
    if (r.view.state !== 'requested') return
    const pid = r.child?.pid
    if (typeof pid !== 'number') return finish(r, 'failed', { failure: 'spawn-error' })
    const now = clock.now()
    r.view = { ...r.view, state: 'started', pid, startedAt: now }
    note(r, { event: 'started', pid })
    if (r.pendingSession) {
      r.pendingSession = false
      r.view = { ...r.view, state: 'session', sessionSeenAt: now }
      note(r, { event: 'session', pid })
    }
    announce(r)
    if (r.view.stopRequestedAt !== undefined) sendTerm(r)
  }

  function onExit(r: Record_, code: number | null, signal: string | null) {
    if (!isActive(r)) return
    const out: Partial<LaunchView> = {}
    if (typeof code === 'number') out.exitCode = code
    if (typeof signal === 'string') out.signal = signal
    if (r.view.startedAt === undefined) return finish(r, 'failed', { ...out, failure: 'exit-before-start' })
    const state: LaunchState = r.view.stopReason === 'expired' ? 'expired' : r.view.stopReason ? 'stopped' : 'exited'
    finish(r, state, out)
  }

  function onError(r: Record_, err: Error) {
    if (!isActive(r)) return
    const code = (err as { code?: unknown })?.code
    finish(r, 'failed', { failure: typeof code === 'string' && FAILURE_CODE_RE.test(code) ? code : 'spawn-error' })
  }

  function feed(r: Record_, src: DataSource | null | undefined) {
    if (!src) return
    src.on('data', chunk => r.ring.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    src.on('error', () => { /* a broken pipe ends with the exit event */ })
  }

  return {
    check,

    start(req, command) {
      if (command.file !== 'claude' || !Array.isArray(command.args)) return { ok: false, reason: 'command' }
      const refusal = check(req)
      if (refusal) return { ok: false, reason: refusal }
      const now = clock.now()
      const r: Record_ = {
        view: {
          id: randomId(), repo: req.repo, issue: req.issue, role: req.role, worktree: command.worktree, sessionId: command.sessionId,
          state: 'requested', requestedAt: now, outputBytes: 0, outputDroppedBytes: 0,
        },
        command, child: null, ring: new RingBuffer(LAUNCH_CAPS.outputBufferBytes),
        pendingSession: false, wallTimer: undefined, killTimer: undefined, signalled: false,
      }
      // No entry, no launch: the journal is the trace of who started what
      if (!note(r, { event: 'requested', argv: command.args })) return { ok: false, reason: 'journal' }
      records.set(r.view.id, r)
      announce(r)
      try {
        const child = spawn(command.file, command.args, {
          cwd: deps.workspace, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })
        r.child = child
        child.on('spawn', () => onSpawn(r))
        child.on('error', err => onError(r, err))
        child.on('exit', (code, signal) => onExit(r, code, signal))
        feed(r, child.stdout)
        feed(r, child.stderr)
        r.wallTimer = clock.setTimer(() => { r.wallTimer = undefined; if (isActive(r)) requestStop(r, 'expired') }, wallClockMs)
      } catch {
        finish(r, 'failed', { failure: 'spawn-error' })
      }
      return { ok: true, launch: snapshot(r) }
    },

    stop(id) {
      const r = records.get(id)
      if (!r) return { ok: false, reason: 'unknown' }
      if (!isActive(r)) return { ok: false, reason: 'ended' }
      requestStop(r, 'stop')
      return { ok: true, launch: snapshot(r) }
    },

    sessionSeen(sessionId) {
      for (const r of records.values()) {
        if (!isActive(r) || r.view.sessionId !== sessionId || r.view.sessionSeenAt !== undefined || r.pendingSession) continue
        if (r.view.state === 'requested') { r.pendingSession = true; continue }
        r.view = { ...r.view, state: 'session', sessionSeenAt: clock.now() }
        note(r, { event: 'session', pid: r.view.pid })
        announce(r)
      }
    },

    get: id => { const r = records.get(id); return r ? snapshot(r) : undefined },
    list: () => [...records.values()].map(snapshot),
    tail: id => records.get(id)?.ring.toString() ?? '',

    recordRefusal(reason, req) {
      note(null, { event: 'refused', reason: String(reason).slice(0, 40), ...(req ? { repo: req.repo, issue: req.issue, role: req.role } : {}) })
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const r of records.values()) {
        clearTimers(r)
        if (!isActive(r)) continue
        note(r, { event: 'killed-on-dispose', pid: r.view.pid })
        signalGroup(r, 'SIGKILL')
      }
    },
  }
}
