/**
 * Workflow groups (#79).
 *
 * The Workflow tool runs a script that launches many agents. Their transcripts live in
 *   <session>/subagents/workflows/<wf_id>/agent-<id>.jsonl (+ agent-<id>.meta.json, journal.jsonl)
 * and the script itself in
 *   <session>/workflows/scripts/<name>-<wf_id>.js
 * Each run is shown like an Agent Team: a group named after the workflow (teamKind 'workflow')
 * whose members are its agents, announced as teammates and reported working / idle / done.
 *
 * Journal rules (journal.jsonl, one JSON object per line; observed types: launched, started, result):
 *   {"type":"started","agentId":"<id>","label":"impl:x","phase":"Implement",...}
 *   {"type":"result","agentId":"<id>","result":{...}}
 * There is NO terminal "completed" entry. An agent with a `result` entry is done. The run is
 * considered complete when every agent that has a `started` entry also has a `result` entry AND
 * nothing was written for WORKFLOW_DONE_QUIET_MS (a script launches the next phase right after a
 * result, so completeness alone would flap between phases).
 *
 * Pure logic + small registry; no vscode dependency. Everything read from disk is untrusted:
 * bounded reads, regular files only (symlinks refused), real paths must stay inside subagents/.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentActivity, SubagentState, TeamInfoPayload, WatchedSession } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, SYSTEM_CONTENT_PREFIXES, SUBAGENT_ID_SUFFIX_LENGTH, TEAM_NAME_MAX, TEAM_INFO_DEBOUNCE_MS,
  WORKFLOW_RECENT_WRITE_MS, WORKFLOW_DONE_QUIET_MS, WORKFLOW_MAX_AGENTS, WORKFLOW_MAX_PER_SESSION,
  WORKFLOW_JOURNAL_MAX_BYTES, WORKFLOW_JOURNAL_MAX_IDS, WORKFLOW_PHASE_MAX, WORKFLOW_SCRIPTS_MAX_ENTRIES,
  WORKFLOW_AGENT_TYPE,
} from './constants'
import { isPathInside, readTailTextSafe } from './fs-utils'
import { sanitizeAgentName } from './team-links'
import { sanitizeTeamField, TeammateTracker } from './teammate'

const WF_ID_RE = /^[\w.-]{1,64}$/
const AGENT_ID_RE = /^[\w.-]{1,128}$/

// ─── Paths and names ─────────────────────────────────────────────────────────

export interface WorkflowRef {
  wfId: string
  /** Workflow name from workflows/scripts/<name>-<wf_id>.js, else the wf_id */
  name: string
  journalPath: string
  /** The session's subagents directory (containment root) */
  subagentsDir: string
}

/** True for a name that starts like system-injected content: never a usable label. */
export function looksSystemInjected(text: string): boolean {
  const t = text.trimStart().toLowerCase()
  return SYSTEM_CONTENT_PREFIXES.some(p => t.startsWith(p.toLowerCase()))
}

/** Single-line, control-free, capped label that is not system-injected text; null otherwise. */
export function cleanWorkflowLabel(value: unknown): string | null {
  const v = sanitizeAgentName(value)
  return v && !looksSystemInjected(v) ? v : null
}

/** Phase label (single line, capped at WORKFLOW_PHASE_MAX). */
export function cleanWorkflowPhase(value: unknown): string | undefined {
  const v = cleanWorkflowLabel(value)
  return v ? v.slice(0, WORKFLOW_PHASE_MAX).trim() || undefined : undefined
}

/**
 * Workflow name = the script file name before "-<wf_id>.js" in <session>/workflows/scripts.
 * Only the directory listing is read (bounded); the script content never is. Falls back to the wf_id.
 */
export function deriveWorkflowName(scriptsDir: string, wfId: string): string {
  const fallback = sanitizeTeamField(wfId) ?? 'workflow'
  let names: string[]
  try { names = fs.readdirSync(scriptsDir).slice(0, WORKFLOW_SCRIPTS_MAX_ENTRIES) } catch { return fallback }
  const suffix = `-${wfId}.js`
  for (const n of names.sort()) {
    if (!n.endsWith(suffix) || n.length === suffix.length) continue
    const label = cleanWorkflowLabel(n.slice(0, -suffix.length))
    if (label) return sanitizeTeamField(label) ?? fallback
  }
  return fallback
}

/** wf_id when the path is `<session>/subagents/workflows/<wf_id>/agent-<id>.jsonl`, else null. */
export function workflowIdOf(jsonlPath: string): string | null {
  const wfDir = path.dirname(jsonlPath)
  const workflowsDir = path.dirname(wfDir)
  if (path.basename(workflowsDir) !== 'workflows' || path.basename(path.dirname(workflowsDir)) !== 'subagents') return null
  const wfId = path.basename(wfDir)
  return WF_ID_RE.test(wfId) ? wfId : null
}

/** The workflow a transcript belongs to (name read from workflows/scripts). Null for any other location. */
export function workflowRefFromPath(jsonlPath: string): WorkflowRef | null {
  const wfId = workflowIdOf(jsonlPath)
  if (!wfId) return null
  const wfDir = path.dirname(jsonlPath)
  const subagentsDir = path.dirname(path.dirname(wfDir))
  return {
    wfId,
    name: deriveWorkflowName(path.join(path.dirname(subagentsDir), 'workflows', 'scripts'), wfId),
    journalPath: path.join(wfDir, 'journal.jsonl'),
    subagentsDir,
  }
}

/** Label + phase from a parsed agent-<id>.meta.json (description / workflowPhase). */
export function parseWorkflowMeta(raw: unknown): { label?: string; phase?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const m = raw as Record<string, unknown>
  const label = cleanWorkflowLabel(m.description)
  const phase = cleanWorkflowPhase(m.workflowPhase)
  return { ...(label ? { label } : {}), ...(phase ? { phase } : {}) }
}

/** Stable fallback label for an agent without usable meta. */
export function workflowFallbackLabel(agentId: string): string {
  return `agent-${agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}`
}

// ─── Journal ─────────────────────────────────────────────────────────────────

export interface JournalInfo {
  started: Set<string>
  finished: Set<string>
}

/** Parse journal.jsonl text. `truncated`: the text starts mid-file, so its first line is dropped. */
export function parseWorkflowJournal(text: string, truncated = false): JournalInfo {
  const info: JournalInfo = { started: new Set(), finished: new Set() }
  const lines = text.split(/\r?\n/)
  if (truncated) lines.shift()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let e: { type?: unknown; agentId?: unknown }
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e.agentId !== 'string' || !AGENT_ID_RE.test(e.agentId)) continue
    const set = e.type === 'started' ? info.started : e.type === 'result' ? info.finished : null
    if (set && set.size < WORKFLOW_JOURNAL_MAX_IDS) set.add(e.agentId)
  }
  return info
}

/** Every started agent has a result (and at least one started). */
export function journalAllFinished(info: JournalInfo): boolean {
  if (info.started.size === 0) return false
  for (const id of info.started) if (!info.finished.has(id)) return false
  return true
}

// ─── Activity ────────────────────────────────────────────────────────────────

/** What the tracker needs to know about its group. */
export interface WorkflowAgentContext {
  isAgentDone(agentId: string, now: number): boolean
}

/**
 * working: pending tool_use, or transcript written in the last WORKFLOW_RECENT_WRITE_MS.
 * done: the journal says so (or the group went stale), or the turn ended and nothing was written
 * for WORKFLOW_DONE_QUIET_MS. idle: anything else.
 */
export class WorkflowAgentTracker extends TeammateTracker {
  constructor(lastWriteMs: number, private readonly ctx: WorkflowAgentContext, private readonly agentId: string) {
    super(lastWriteMs)
  }

  override activity(now = Date.now()): AgentActivity {
    if (this.done) return 'done'
    if (this.ctx.isAgentDone(this.agentId, now)) return 'done'
    if (this.pending.size > 0) return 'working'
    const age = now - this.lastWriteMs
    if (age < WORKFLOW_RECENT_WRITE_MS) return 'working'
    if (this.turnEnded && age >= WORKFLOW_DONE_QUIET_MS) return 'done'
    return 'idle'
  }
}

// ─── File selection and safety ───────────────────────────────────────────────

/** A regular, non-symlink file whose real path stays inside the subagents directory. */
export function isSafeTranscript(filePath: string, subagentsDir: string): boolean {
  try {
    if (!fs.lstatSync(filePath).isFile()) return false
    return isPathInside(fs.realpathSync(filePath), fs.realpathSync(subagentsDir))
  } catch { return false }
}

export interface WorkflowSelection {
  /** Ordinary transcripts (unchanged) followed by the selected workflow transcripts */
  files: string[]
  /** wf_ids of the selected workflows */
  workflows: Set<string>
}

/**
 * Apply the caps: at most `maxWorkflows` workflows (newest file mtime inside them first: transcripts and journal, not the folder, whose mtime only moves when files are created) and `maxAgents`
 * transcripts per workflow (newest file mtime first). Ordinary transcripts pass through.
 * `mtimeOf` is only called when a cap actually has to be applied.
 */
export function selectWorkflowTranscripts(
  files: readonly string[],
  subagentsDir: string,
  mtimeOf: (p: string) => number = p => { try { return fs.statSync(p).mtimeMs } catch { return 0 } },
  maxWorkflows = WORKFLOW_MAX_PER_SESSION,
  maxAgents = WORKFLOW_MAX_AGENTS,
): WorkflowSelection {
  const ordinary: string[] = []
  const byWorkflow = new Map<string, string[]>()
  const root = path.resolve(subagentsDir)
  for (const f of files) {
    const rel = path.relative(root, path.resolve(f)).split(path.sep)
    if (rel.length === 3 && rel[0] === 'workflows') {
      const list = byWorkflow.get(rel[1]) ?? []
      list.push(f)
      byWorkflow.set(rel[1], list)
    } else {
      ordinary.push(f)
    }
  }
  let ids = [...byWorkflow.keys()].sort()
  if (ids.length > maxWorkflows) {
    const newestInside = (id: string): number => Math.max(
      mtimeOf(path.join(root, 'workflows', id, 'journal.jsonl')),
      ...byWorkflow.get(id)!.map(f => mtimeOf(f)),
    )
    const mtimes = new Map(ids.map(id => [id, newestInside(id)]))
    ids = ids.sort((a, b) => (mtimes.get(b)! - mtimes.get(a)!) || a.localeCompare(b)).slice(0, maxWorkflows)
  }
  const out = [...ordinary]
  for (const id of ids) {
    let list = byWorkflow.get(id)!.sort()
    if (list.length > maxAgents) {
      const mtimes = new Map(list.map(f => [f, mtimeOf(f)]))
      list = list.sort((a, b) => (mtimes.get(b)! - mtimes.get(a)!) || a.localeCompare(b)).slice(0, maxAgents)
    }
    out.push(...list)
  }
  return { files: out, workflows: new Set(ids) }
}

// ─── Groups ──────────────────────────────────────────────────────────────────

export class WorkflowGroup implements WorkflowAgentContext {
  /** transcript path -> state of the member agent */
  readonly members = new Map<string, SubagentState>()
  journal: JournalInfo = { started: new Set(), finished: new Set() }
  journalMtimeMs = 0
  /** Signature of the last emitted-or-scheduled team_info payload ('' = never) */
  sig = ''
  timer?: NodeJS.Timeout
  private journalSig = ''
  private journalComplete = false

  constructor(
    readonly wfId: string,
    public name: string,
    private readonly journalPath: string,
    private readonly rootDir: string,
  ) {}

  /** Re-read the journal when its size/mtime changed (one lstat otherwise). */
  refreshJournal(): void {
    let sig: string
    let mtimeMs: number
    try {
      const st = fs.lstatSync(this.journalPath)
      if (!st.isFile()) return
      sig = `${st.size}:${st.mtimeMs}`
      mtimeMs = st.mtimeMs
    } catch { return }
    if (sig === this.journalSig) return
    const tail = readTailTextSafe(this.journalPath, WORKFLOW_JOURNAL_MAX_BYTES, this.rootDir)
    if (!tail) return
    this.journalSig = sig
    this.journalMtimeMs = mtimeMs
    this.journal = parseWorkflowJournal(tail.text, tail.truncated)
    this.journalComplete = journalAllFinished(this.journal)
  }

  /** Most recent write across the member transcripts and the journal. */
  newestWriteMs(): number {
    let newest = this.journalMtimeMs
    for (const st of this.members.values()) {
      const w = st.teammate?.tracker.lastWriteMs
      if (w !== undefined && w > newest) newest = w
    }
    return newest
  }

  isAgentDone(agentId: string, now: number): boolean {
    if (this.journal.finished.has(agentId)) return true
    const quiet = now - this.newestWriteMs()
    // A workflow nobody wrote to for ACTIVE_SESSION_AGE_S stays announced but finished
    if (quiet >= ACTIVE_SESSION_AGE_S * 1000) return true
    return this.journalComplete && quiet >= WORKFLOW_DONE_QUIET_MS
  }

  allDone(now: number): boolean {
    for (const st of this.members.values()) {
      if (st.teammate && st.teammate.tracker.activity(now) !== 'done') return false
    }
    return true
  }

  payload(leadSessionId: string): TeamInfoPayload {
    const members: TeamInfoPayload['members'] = []
    for (const st of this.members.values()) {
      if (!st.teammate || members.length >= WORKFLOW_MAX_AGENTS) continue
      members.push({
        name: st.agentName,
        agentType: WORKFLOW_AGENT_TYPE,
        ...(st.teammate.meta.phase ? { phase: st.teammate.meta.phase } : {}),
      })
    }
    return { teamName: this.name, teamKind: 'workflow', leadSessionId, members }
  }
}

export interface WorkflowEnv {
  sessionId: string
  /** False once the session is gone: pending debounced team_info are dropped */
  alive(): boolean
  emitTeamInfo(payload: TeamInfoPayload): void
  /** Re-evaluate and report the activity of one member */
  emitActivity(state: SubagentState, now: number): void
  debounceMs?: number
}

export class WorkflowRegistry {
  readonly groups = new Map<string, WorkflowGroup>()

  /** The group of a workflow, created on first use. Names stay unique within the session. */
  groupFor(ref: WorkflowRef, nameHint = ref.name): WorkflowGroup {
    const existing = this.groups.get(ref.wfId)
    if (existing) return existing
    let name = nameHint
    for (const g of this.groups.values()) {
      if (g.name === name) {
        name = `${name.slice(0, TEAM_NAME_MAX - 6)} #${ref.wfId.slice(-4)}`
        break
      }
    }
    const group = new WorkflowGroup(ref.wfId, name, ref.journalPath, ref.subagentsDir)
    group.refreshJournal()
    this.groups.set(ref.wfId, group)
    return group
  }

  /**
   * Evaluate every group: activity of each member, then team_info when the roster changed (the first
   * one at once, later changes debounced like the team watcher).
   */
  tick(env: WorkflowEnv, now = Date.now()): void {
    const debounceMs = env.debounceMs ?? TEAM_INFO_DEBOUNCE_MS
    for (const group of this.groups.values()) {
      group.refreshJournal()
      for (const st of group.members.values()) env.emitActivity(st, now)
      const sig = JSON.stringify(group.payload(env.sessionId))
      if (sig === group.sig) continue
      const first = group.sig === ''
      group.sig = sig
      if (group.timer) clearTimeout(group.timer)
      if (first || debounceMs <= 0) {
        group.timer = undefined
        env.emitTeamInfo(group.payload(env.sessionId))
      } else {
        group.timer = setTimeout(() => {
          group.timer = undefined
          if (env.alive()) env.emitTeamInfo(group.payload(env.sessionId))
        }, debounceMs)
        group.timer.unref?.()
      }
    }
  }

  /** Re-send team_info of every group (a webview connected late). */
  replay(env: WorkflowEnv): void {
    for (const group of this.groups.values()) {
      if (group.timer) { clearTimeout(group.timer); group.timer = undefined }
      group.sig = JSON.stringify(group.payload(env.sessionId))
      env.emitTeamInfo(group.payload(env.sessionId))
    }
  }

  /** Forget fully finished groups that fell out of the selection (the caller closes their watchers). */
  prune(selected: ReadonlySet<string>, now = Date.now()): WorkflowGroup[] {
    const dropped: WorkflowGroup[] = []
    for (const [id, group] of this.groups) {
      if (selected.has(id) || !group.allDone(now)) continue
      if (group.timer) clearTimeout(group.timer)
      this.groups.delete(id)
      dropped.push(group)
    }
    return dropped
  }
}

const registries = new WeakMap<WatchedSession, WorkflowRegistry>()

export function getWorkflowRegistry(session: WatchedSession, create = true): WorkflowRegistry | undefined {
  let r = registries.get(session)
  if (!r && create) { r = new WorkflowRegistry(); registries.set(session, r) }
  return r
}
