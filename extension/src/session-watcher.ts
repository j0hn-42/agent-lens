import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent, SessionInfo, WatchedSession } from './protocol'
import { projectTags, branchTag } from './project-identity'
import { claudeProjectsDir, claudeTeamsDir } from './claude-config-dir'
import {
  SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, RELAY_MAX_FILES_PER_DIR, COLD_RESCAN_CYCLES, ORCHESTRATOR_NAME,
} from './constants'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { ClaudeSessionPipeline, listedStartTimes } from './claude-session-pipeline'
import { safeWatch, foldPathCase, listSubagentTranscripts, newestSessionMtime } from './fs-utils'
import { encodeProjectDirName, PROJECT_DIR_NAME_MAX } from './project-dir'
import { scanSubagentsDir, markTeammatesDone, replayTeammates } from './subagent-watcher'
import { TeamWatcher, readSessionHeader } from './team-watcher'
import { createLogger } from './logger'
import { EventReconciler } from './event-source-priority'

const log = createLogger('SessionWatcher')

/**
 * Watches Claude Code JSONL session transcript files for activity.
 *
 * Supports multiple concurrent sessions — each gets its own WatchedSession
 * with independent state for tool call tracking, dedup, and subagent watchers.
 *
 * Claude Code writes full conversation transcripts to:
 *   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
 *
 * Each line is a JSON object with:
 *   { sessionId, type, message: { role: "assistant"|"user", content: [...] } }
 *
 * Assistant messages contain tool_use blocks: { type: "tool_use", name, id, input }
 * User messages contain tool_result blocks:   { type: "tool_result", tool_use_id, content }
 *
 * We parse these to emit AgentEvent objects for the visualizer.
 */

// WatchedSession and SubagentState are defined in protocol.ts and re-exported here for convenience
export type { WatchedSession, SubagentState } from './protocol'

const CLAUDE_DIR = claudeProjectsDir()
const TEAMS_DIR = claudeTeamsDir()

export class SessionWatcher implements AgentSessionWatcher {
  private dirWatcher: fs.FSWatcher | null = null
  private dirWatchers = new Map<string, fs.FSWatcher>()
  /** Transcripts anciens sans sous-agent actif : filePath -> cycle de scan avant réexamen */
  private coldUntil = new Map<string, number>()
  private scanCycle = 0
  private sessions = new Map<string, WatchedSession>()
  private workspacePath: string | null = null
  /** Resolved absolute workspace path for subdirectory verification */
  private resolvedWorkspace: string | null = null
  /** Cache for isContainedProject results — avoids re-reading JSONL files every scan */
  private containedProjectCache = new Map<string, boolean>()
  private scanInterval: NodeJS.Timeout | null = null
  /** Agent Team config / inbox watcher (created in start()) */
  private teamWatcher: TeamWatcher | null = null
  /** Working directory per watched session (read once from the transcript head) */
  private sessionCwd = new Map<string, string>()
  /** Git branch per watched session, as recorded at the head of its transcript (absent when unrecorded or detached) */
  private sessionBranch = new Map<string, string>()

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new vscode.EventEmitter<string>()
  private readonly _onSessionLifecycle = new vscode.EventEmitter<SessionLifecycleEvent>()
  /** An unwatched session: rediscovered, its history is emitted again (#592) */
  private readonly _onSessionReleased = new vscode.EventEmitter<string>()

  /** Tracking of one transcript, shared with the relay (claude-session-pipeline.ts) */
  private readonly pipeline = new ClaudeSessionPipeline({
    sessions: this.sessions,
    submit: (event) => this.reconciler.submit(event, { source: 'jsonl' }),
    fireLifecycle: (type, sessionId, label) => this.fireLifecycle(type, sessionId, label),
    withHistory: (load) => this.reconciler.withHistory(load),
    onDetected: (sessionId) => this._onSessionDetected.fire(sessionId),
    log: (message) => log.info(message),
  })
  private readonly parser = this.pipeline.parser
  /** Delegate for subagent/permission modules to call back into this watcher */
  private readonly selfDelegate = this.pipeline.delegate

  /** Hook events that survived reconciliation against the transcript (see event-source-priority.ts) */
  private readonly _onHookEvent = new vscode.EventEmitter<AgentEvent>()

  /**
   * Single funnel for the two event sources (issue #53): transcript events (`emit`) and hook events
   * (`submitHookEvent`) are deduplicated here. The survivor is delivered on the channel of its source,
   * so the runtime keeps its own routing for hook events.
   */
  readonly reconciler = new EventReconciler({
    deliver: (event, source) => (source === 'hook' ? this._onHookEvent : this._onEvent).fire(event),
  })

  readonly onEvent = this._onEvent.event
  readonly onHookEvent = this._onHookEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event
  readonly onSessionReleased = this._onSessionReleased.event

  /** Whether any session is actively being tailed */
  isActive(): boolean {
    for (const session of this.sessions.values()) {
      if (session.sessionDetected) return true
    }
    return false
  }

  /** Fire a lifecycle event carrying the session's team / runtime / workspace / cwd tags. */
  private fireLifecycle(type: SessionLifecycleEvent['type'], sessionId: string, label: string): void {
    const tags = this.teamWatcher?.getSessionTags(sessionId)
    const cwd = this.sessionCwd.get(sessionId)
    this._onSessionLifecycle.fire({
      type, sessionId, label,
      runtime: 'claude',
      ...(tags ? { teamName: tags.teamName, ...(tags.memberName ? { memberName: tags.memberName } : {}) } : {}),
      ...(this.resolvedWorkspace ? { workspace: this.resolvedWorkspace.slice(0, 256) } : {}),
      ...(cwd ? { cwd: cwd.slice(0, 256) } : {}),
      ...projectTags(cwd),
      ...branchTag(this.sessionBranch.get(sessionId)),
    })
  }

  /** Stop watching a long-finished session and free its parser / team bookkeeping. */
  private unwatchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.pipeline.release(session)
    this.sessionCwd.delete(sessionId)
    this.sessionBranch.delete(sessionId)
    this.reconciler.forgetSession(sessionId)
    this.sessions.delete(sessionId)
    this.teamWatcher?.forgetSession(sessionId)
    // A transcript that grows again is attached anew and its history re-emitted (claude-session-pipeline.ts, attach)
    this._onSessionReleased.fire(sessionId)
  }

  /**
   * Stop watching sessions with no activity for longer than the discovery window, ended or only silent:
   * nothing is announced (a silence is not an end, #360), and a transcript that grows again is rediscovered.
   */
  private pruneEndedSessions(now = Date.now()): void {
    for (const s of [...this.sessions.values()]) {
      if ((now - s.lastActivityTime) / 1000 > ACTIVE_SESSION_AGE_S) this.unwatchSession(s.sessionId)
    }
  }

  /** Whether a specific session is active */
  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && session.sessionDetected
  }

  /** Get list of currently tracked sessions */
  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => {
      const tags = this.teamWatcher?.getSessionTags(s.sessionId)
      const cwd = this.sessionCwd.get(s.sessionId)
      return {
        id: s.sessionId,
        label: s.label,
        status: s.sessionCompleted ? 'completed' as const : 'active' as const,
        ...listedStartTimes(s),
        lastActivityTime: s.lastActivityTime,
        runtime: 'claude',
        ...(tags ? { teamName: tags.teamName, ...(tags.memberName ? { memberName: tags.memberName } : {}) } : {}),
        ...(this.resolvedWorkspace ? { workspace: this.resolvedWorkspace.slice(0, 256) } : {}),
        ...(cwd ? { cwd: cwd.slice(0, 256) } : {}),
        ...projectTags(cwd),
        ...branchTag(this.sessionBranch.get(s.sessionId)),
      }
    })
  }

  /** Re-emit session start + conversation events for a newly connected webview.
   *  If sessionIds is provided, only replay those sessions. */
  replaySessionStart(sessionIds?: string[]): void {
    // What is re-sent here was read before, not seen now: the webview must not show it as live (#361)
    this.reconciler.asReplayed(() => this.resendSessionStart(sessionIds))
  }

  private resendSessionStart(sessionIds?: string[]): void {
    for (const [sessionId, session] of this.sessions) {
      if (!session.sessionDetected) { continue }
      if (sessionIds && !sessionIds.includes(sessionId)) { continue }
      this.emit({
        time: 0,
        type: 'agent_spawn',
        payload: {
          name: ORCHESTRATOR_NAME,
          isMain: true,
          task: session.label,
          ...(session.model ? { model: session.model, modelSource: 'runtime' as const } : {}),
        },
      }, sessionId)

      for (const [, sub] of session.subagentWatchers) {
        if (session.spawnedSubagents.has(sub.agentName)) {
          const model = session.modelDetectedAgents.get(sub.agentName)
          const record = sub.agentId ? this.parser.getSubagentRegistry(sessionId).getByFileKey(sub.agentId) : undefined
          const parent = record?.parentName ?? ORCHESTRATOR_NAME
          const task = record?.label ?? sub.agentName
          const ids = {
            ...(record?.toolUseId ? { toolUseId: record.toolUseId } : {}),
            ...(record ? { label: record.label } : {}),
          }
          const tm = sub.teammate?.meta
          const teammateExtras = tm ? {
            kind: 'teammate', teamName: tm.teamName, backendType: 'in-process',
            ...(tm.teamKind ? { teamKind: tm.teamKind } : {}),
            ...(tm.color ? { color: tm.color } : {}),
            ...(tm.agentType ? { agentType: tm.agentType } : {}),
          } : {}
          this.emit({ time: 0, type: 'subagent_dispatch', payload: { parent, child: sub.agentName, task, ...ids } }, sessionId)
          this.emit({ time: 0, type: 'agent_spawn', payload: { name: sub.agentName, parent, task, ...ids, ...teammateExtras, ...(model ? { model, modelSource: 'runtime' as const } : tm?.model ? { model: tm.model, modelSource: 'configured' as const } : {}) } }, sessionId)
        }
        sub.spawnEmitted = false
      }

      for (const [agent, model] of session.modelDetectedAgents) {
        this.emit({
          time: 0,
          type: 'model_detected',
          payload: { agent, model },
        }, sessionId)
      }

      replayTeammates(this.selfDelegate, session, sessionId)
      this._onSessionDetected.fire(sessionId)
    }
    this.teamWatcher?.replay(sessionIds)
  }

  start(): void {
    // Scope to the current workspace so we only watch sessions for this project
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspaceFolder) {
      // Claude Code encodes project paths: /Users/simon/my_project → -Users-simon-my-project
      // Resolve symlinks first, then replace /, \, : (drive letter), and _ with -
      let resolved = workspaceFolder
      try { resolved = fs.realpathSync(resolved) } catch { /* use original if realpathSync fails */ }
      const encoded = encodeProjectDirName(resolved)

      this.resolvedWorkspace = resolved

      // Try the resolved encoding first; fall back to unresolved if the directory doesn't exist
      // (handles edge cases where Claude Code didn't resolve symlinks the same way).
      // findProjectDirName returns the on-disk casing, so downstream string
      // comparisons against readdir results stay exact.
      const unresolvedEncoded = encodeProjectDirName(workspaceFolder)
      this.workspacePath = this.findProjectDirName(encoded)
        ?? this.findProjectDirName(unresolvedEncoded)
        ?? encoded
      log.info(`Starting — scoped to project: ${this.workspacePath}`)
    } else {
      log.info('Starting — no workspace, scanning all projects')
    }

    this.scanForActiveSessions()

    // Watch project directories for instant new-file detection.
    // Watch both the exact workspace dir and the parent CLAUDE_DIR (to detect
    // new subdirectory project dirs, e.g. CLI sessions started from a subfolder).
    this.watchProjectDirs()

    // Re-scan periodically as fallback (1s instead of 3s for faster detection)
    this.scanInterval = setInterval(() => {
      this.pruneEndedSessions()
      this.scanForActiveSessions()
    }, SCAN_INTERVAL_MS)

    // Agent Teams: ~/.claude/teams config (team_info, member sessions, 'done' members) and inboxes
    this.teamWatcher = new TeamWatcher({
      teamsDir: TEAMS_DIR,
      workspaces: this.resolvedWorkspace ? [this.resolvedWorkspace] : null,
      host: {
        listSessions: () => [...this.sessions.values()]
          .filter(s => s.sessionDetected)
          .map(s => ({ sessionId: s.sessionId, filePath: s.filePath, startTime: s.sessionStartTime })),
        emitTeamInfo: (sessionId, payload) => this.emit({
          time: this.elapsed(sessionId), type: 'team_info', payload: { ...payload },
        }, sessionId),
        emitInbox: (sessionId, from, to, content) => this.parser.emitInboxMessage(sessionId, from, to, content),
        setLeadAlias: (sessionId, leadName) => this.parser.setLeadAlias(sessionId, leadName),
        onSessionTags: (sessionId) => {
          const s = this.sessions.get(sessionId)
          if (s) this.fireLifecycle('updated', sessionId, s.label)
        },
        onMembersGone: (sessionId, _team, names) => {
          const s = this.sessions.get(sessionId)
          if (s) markTeammatesDone(this.selfDelegate, s, sessionId, names)
        },
      },
    })
    this.teamWatcher.start()
  }

  /** Set up fs.watch on known project directories and the parent CLAUDE_DIR */
  private watchProjectDirs(): void {
    // Watch the exact workspace project dir
    if (this.workspacePath) {
      const projectDir = path.join(CLAUDE_DIR, this.workspacePath)
      this.watchDirForJsonl(projectDir)
    }

    // Watch CLAUDE_DIR itself so we detect new subdirectory project dirs
    // (e.g. when a CLI session starts in a subfolder and creates a new project dir)
    if (this.workspacePath && fs.existsSync(CLAUDE_DIR)) {
      try {
        this.dirWatcher = safeWatch(CLAUDE_DIR, (_eventType, filename) => {
          if (!filename) return
          // A new project dir appeared — check if it's a subdirectory of our workspace
          const dirPath = path.join(CLAUDE_DIR, filename)
          try {
            if (fs.statSync(dirPath).isDirectory() && this.isContainedProject(filename)) {
              this.watchDirForJsonl(dirPath)
              this.scanForActiveSessions()
            }
          } catch { /* stat may fail for transient files */ }
        })
      } catch (err) { log.debug('CLAUDE_DIR watch failed:', err) }
    }
  }

  /** Watch a single project directory for new .jsonl files */
  private watchDirForJsonl(projectDir: string): void {
    if (this.dirWatchers.has(projectDir)) return // already watching
    if (!fs.existsSync(projectDir)) return
    try {
      const watcher = safeWatch(projectDir, (_eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          const sessionId = path.basename(filename, '.jsonl')
          this.coldUntil.delete(path.join(projectDir, filename))
          if (!this.sessions.has(sessionId)) {
            this.scanForActiveSessions()
          }
        }
      })
      if (watcher) this.dirWatchers.set(projectDir, watcher)
    } catch (err) { log.debug('Dir watch failed (may not exist yet):', err) }
  }

  /** Find the actual on-disk project dir name under CLAUDE_DIR for an encoded
   *  workspace path. On Windows the lookup is case-insensitive (VS Code reports
   *  `c:\...` while Claude Code encodes `C--...`) and returns the real casing.
   *  Returns null when no matching directory exists. */
  private findProjectDirName(encoded: string): string | null {
    const long = encoded.length > PROJECT_DIR_NAME_MAX
    if (process.platform !== 'win32' && !long) {
      return fs.existsSync(path.join(CLAUDE_DIR, encoded)) ? encoded : null
    }
    try {
      // A name past the limit is stored cut, followed by a hash (#249): match its prefix
      const folded = (long ? encoded.slice(0, PROJECT_DIR_NAME_MAX) : encoded)
      const key = foldPathCase(folded)
      for (const entry of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const name = foldPathCase(entry.name)
        if (long ? name.startsWith(key) : name === key) return entry.name
      }
    } catch { /* CLAUDE_DIR may not exist yet */ }
    return null
  }

  /** Check whether a project dir contains sessions running under the workspace.
   *  The encoded dir name is lossy (hyphens and path separators both become -),
   *  so instead of trying to decode it, we read the cwd from the JSONL files
   *  in the directory — that's the authoritative source of truth.
   *  Results are cached since a project dir's cwd never changes. */
  private isContainedProject(encodedDirName: string): boolean {
    if (!this.workspacePath || !this.resolvedWorkspace) return false
    // Quick prefix check to avoid reading files from obviously unrelated dirs
    // (case-folded on Windows — encodings from different tools disagree on case)
    if (!foldPathCase(encodedDirName).startsWith(foldPathCase(this.workspacePath) + '-')) return false

    const cached = this.containedProjectCache.get(encodedDirName)
    if (cached !== undefined) return cached

    const result = this.readCwdFromProjectDir(encodedDirName)
    // Only cache positive results — a dir with no JSONL files yet (race on
    // creation) should be re-checked on the next scan once files appear.
    if (result) this.containedProjectCache.set(encodedDirName, true)
    return result
  }

  /** Read JSONL files in a project dir to find the cwd and check containment. */
  private readCwdFromProjectDir(encodedDirName: string): boolean {
    if (!this.resolvedWorkspace) return false
    const workspaceFolded = foldPathCase(this.resolvedWorkspace)
    const dirPath = path.join(CLAUDE_DIR, encodedDirName)
    try {
      const files = fs.readdirSync(dirPath)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        // Read enough to cover the first few lines (cwd is typically on line 3)
        const fd = fs.openSync(path.join(dirPath, file), 'r')
        try {
          const buf = Buffer.alloc(8192)
          const bytesRead = fs.readSync(fd, buf, 0, 8192, 0)
          if (bytesRead === 0) continue
          const lines = buf.toString('utf8', 0, bytesRead).split('\n')
          for (const line of lines) {
            if (!line.includes('"cwd"')) continue
            try {
              const entry = JSON.parse(line)
              if (typeof entry.cwd === 'string') {
                let cwd = entry.cwd
                try { cwd = fs.realpathSync(cwd) } catch { /* use as-is */ }
                const cwdFolded = foldPathCase(cwd)
                return cwdFolded === workspaceFolded
                  || cwdFolded.startsWith(workspaceFolded + path.sep)
              }
            } catch { /* malformed line, try next */ }
          }
        } finally { fs.closeSync(fd) }
      }
    } catch { /* dir may not exist or be readable */ }
    return false
  }

  private scanForActiveSessions(): void {
    this.scanCycle++
    if (this.scanCycle % COLD_RESCAN_CYCLES === 0) {
      for (const [f, until] of this.coldUntil) if (until <= this.scanCycle) this.coldUntil.delete(f)
    }
    if (!fs.existsSync(CLAUDE_DIR)) {
      return
    }

    try {
      const dirsToScan: string[] = []
      if (this.workspacePath) {
        // Always include the exact workspace project dir
        const projectDir = path.join(CLAUDE_DIR, this.workspacePath)
        if (fs.existsSync(projectDir)) {
          dirsToScan.push(projectDir)
        }

        // Also include subdirectory project dirs (e.g. CLI sessions started
        // from a subfolder like project/extension/src). Uses containment check
        // to avoid matching unrelated projects with a similar path prefix.
        try {
          const allDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
          for (const dir of allDirs) {
            if (!dir.isDirectory()) continue
            const fullPath = path.join(CLAUDE_DIR, dir.name)
            if (fullPath === projectDir) continue // already added
            if (this.isContainedProject(dir.name)) {
              dirsToScan.push(fullPath)
            }
          }
        } catch { /* readdir may fail if CLAUDE_DIR is being modified */ }
      } else {
        const projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
        for (const dir of projectDirs) {
          if (dir.isDirectory()) {
            dirsToScan.push(path.join(CLAUDE_DIR, dir.name))
          }
        }
      }

      const activeFiles: { sessionId: string; filePath: string; mtime: number }[] = []

      for (const projectPath of dirsToScan) {
        try {
          const files = fs.readdirSync(projectPath)
          const fresh: { filePath: string; sessionId: string; mtimeMs: number }[] = []
          for (const file of files) {
            if (!file.endsWith('.jsonl')) { continue }
            const filePath = path.join(projectPath, file)
            const sessionId = path.basename(file, '.jsonl')
            // Session déjà suivie : plus de stat (son poll relit déjà les sous-agents)
            if (this.sessions.has(sessionId)) continue
            // Transcript ancien déjà examiné : réexaminé seulement tous les COLD_RESCAN_CYCLES scans
            if ((this.coldUntil.get(filePath) ?? 0) > this.scanCycle) { continue }
            try { fresh.push({ filePath, sessionId, mtimeMs: fs.statSync(filePath).mtimeMs }) } catch { /* vanished */ }
          }
          // Le plafond garde les plus récents (l'ordre de readdir n'est pas chronologique)
          fresh.sort((a, b) => b.mtimeMs - a.mtimeMs)
          const cutoff = Date.now() - ACTIVE_SESSION_AGE_S * 1000
          // Au-delà du plafond : écartés et mis au froid, pas re-stat à chaque cycle
          for (const { filePath } of fresh.slice(RELAY_MAX_FILES_PER_DIR)) {
            this.coldUntil.set(filePath, this.scanCycle + COLD_RESCAN_CYCLES)
          }
          for (const { filePath, sessionId, mtimeMs } of fresh.slice(0, RELAY_MAX_FILES_PER_DIR)) {
            let newestMtime = mtimeMs

            // Also check subagent files — a session's main JSONL may be stale
            // while subagents are still actively writing. Inutile si le principal est récent.
            if (newestMtime < cutoff) {
              const subagentsDir = path.join(projectPath, sessionId, 'subagents')
              try {
                for (const subPath of listSubagentTranscripts(subagentsDir)) {
                  const subStat = fs.statSync(subPath)
                  if (subStat.mtimeMs > newestMtime) newestMtime = subStat.mtimeMs
                }
              } catch { /* expected if subagents dir doesn't exist yet */ }
            }

            if (newestMtime >= cutoff) {
              this.coldUntil.delete(filePath)
              activeFiles.push({
                sessionId,
                filePath,
                mtime: newestMtime,
              })
            } else {
              this.coldUntil.set(filePath, this.scanCycle + COLD_RESCAN_CYCLES)
            }
          }
        } catch (err) {
          log.debug('Failed to scan project dir:', err)
        }
      }

      // Start watching any new active files
      for (const af of activeFiles) {
        if (!this.sessions.has(af.sessionId)) {
          log.info(`Active session found: ${af.filePath}`)
          this.watchSession(af.sessionId, af.filePath)
        } else {
          // Already watching — scan for subagents
          scanSubagentsDir(this.selfDelegate, this.parser, af.sessionId)
        }
      }
    } catch (err) {
      log.error('Scan error:', err)
    }
  }

  private watchSession(sessionId: string, filePath: string): void {
    const header = readSessionHeader(filePath)
    const session = this.pipeline.newSession(sessionId, filePath, {
      lastActivityTime: newestSessionMtime(filePath, sessionId), recordedStartTime: header.startMs,
    })
    this.sessions.set(sessionId, session)
    if (header.cwd) this.sessionCwd.set(sessionId, header.cwd)
    if (header.branch) this.sessionBranch.set(sessionId, header.branch)
    this.pipeline.attach(session)
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private elapsed(sessionId?: string): number {
    return this.pipeline.elapsed(sessionId)
  }

  private emit(event: AgentEvent, sessionId?: string): void {
    this.pipeline.emit(event, sessionId)
  }

  /** Submit an event received from the Claude Code hooks; delivered on `onHookEvent` unless the transcript already reported it. */
  submitHookEvent(event: AgentEvent): void {
    this.reconciler.submit(event, { source: 'hook' })
    // After the event: a SessionEnd closes the session once its agent_complete is delivered (#360)
    this.pipeline.observeHookEvent(event)
  }

  dispose(): void {
    this.teamWatcher?.dispose()
    this.teamWatcher = null
    this.sessionCwd.clear()
    this.sessionBranch.clear()
    this.dirWatcher?.close()
    this.dirWatcher = null
    for (const w of this.dirWatchers.values()) w.close()
    this.dirWatchers.clear()
    for (const session of this.sessions.values()) this.pipeline.release(session)
    this.sessions.clear()
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
    this.reconciler.clear()
    this._onEvent.dispose()
    this._onHookEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
    this._onSessionReleased.dispose()
  }
}
