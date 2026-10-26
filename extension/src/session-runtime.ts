/**
 * Runtime abstraction for agent session watchers.
 *
 * Each supported agent tool (Claude Code, Codex, Copilot, Pi, Gemini CLI, OpenCode, ...) implements
 * AgentSessionWatcher and is started via a runtime factory in extension.ts.
 * The interface deliberately matches what the visualizer needs to render
 * live activity: an event stream, session lifecycle, and replay on panel
 * open. Runtime-specific concerns (hook servers, SQLite lookups, etc.)
 * live inside each runtime's startXxxRuntime() factory, not here.
 */

import * as vscode from 'vscode'
import type { AgentEvent, ExtensionToWebviewMessage, SessionInfo } from './protocol'
import { VisualizerPanel } from './webview-provider'
import { panelLoss } from './panel-loss'
import { SESSION_ID_DISPLAY, STATUS_MESSAGE_DURATION_MS } from './constants'
import type { TypedDisposable, TypedEvent } from './typed-event-emitter'

export type AgentRuntimeMode = 'claude' | 'codex' | 'copilot' | 'pi' | 'gemini' | 'opencode'

export interface SessionLifecycleEvent {
  type: 'started' | 'ended' | 'updated'
  sessionId: string
  label: string
  /** Team / runtime / workspace tags (all optional, untrusted-capped by the watcher) */
  teamName?: string
  memberName?: string
  runtime?: string
  workspace?: string
  cwd?: string
  projectId?: string
  projectName?: string
  /** Git branch recorded at the head of the session transcript (untrusted, capped); absent when unrecorded or detached */
  branch?: string
}

/** The optional tag fields of a lifecycle event, as session info fields. */
export function lifecycleTags(l: SessionLifecycleEvent): Pick<SessionInfo, 'teamName' | 'memberName' | 'runtime' | 'workspace' | 'cwd' | 'projectId' | 'projectName' | 'branch'> {
  return {
    ...(l.teamName ? { teamName: l.teamName } : {}),
    ...(l.memberName ? { memberName: l.memberName } : {}),
    ...(l.runtime ? { runtime: l.runtime } : {}),
    ...(l.workspace ? { workspace: l.workspace } : {}),
    ...(l.cwd ? { cwd: l.cwd } : {}),
    ...(l.projectId && l.projectName ? { projectId: l.projectId, projectName: l.projectName } : {}),
    ...(l.branch ? { branch: l.branch } : {}),
  }
}

/**
 * The session announced by a 'started' lifecycle (#365). When the watcher lists the session, its own times are
 * kept (start recorded by the transcript, last write of the file); `now` only stands in for a session it does
 * not list.
 */
export function startedSessionInfo(lifecycle: SessionLifecycleEvent, listed: SessionInfo | undefined, now: number): SessionInfo {
  const times = listed
    ? {
      startTime: listed.startTime, lastActivityTime: listed.lastActivityTime,
      ...(listed.recordedStartTime !== undefined ? { recordedStartTime: listed.recordedStartTime } : {}),
      ...(listed.startTimeWatched ? { startTimeWatched: true } : {}),
    }
    : { startTime: now, lastActivityTime: now, startTimeWatched: true }
  return { id: lifecycle.sessionId, label: lifecycle.label, status: 'active', ...times, ...lifecycleTags(lifecycle) }
}

/** The session-updated message of a lifecycle event: label, team, and the place (cwd, project, branch) it knows. */
export function updatedSessionMessage(lifecycle: SessionLifecycleEvent): Extract<ExtensionToWebviewMessage, { type: 'session-updated' }> {
  const { teamName, memberName, cwd, projectId, projectName, branch } = lifecycleTags(lifecycle)
  return {
    type: 'session-updated', sessionId: lifecycle.sessionId, label: lifecycle.label,
    ...(teamName ? { teamName } : {}),
    ...(memberName ? { memberName } : {}),
    ...(cwd ? { cwd } : {}),
    ...(projectId && projectName ? { projectId, projectName } : {}),
    ...(branch ? { branch } : {}),
  }
}

/** Interface every runtime's watcher implements. Uses portable typed-event
 *  types (not vscode.Event) so watchers can run in the relay/CLI too. */
export interface AgentSessionWatcher extends TypedDisposable {
  readonly onEvent: TypedEvent<AgentEvent>
  readonly onSessionDetected: TypedEvent<string>
  readonly onSessionLifecycle: TypedEvent<SessionLifecycleEvent>
  start(): void
  isActive(): boolean
  isSessionActive(sessionId: string): boolean
  getActiveSessions(): SessionInfo[]
  replaySessionStart(sessionIds?: string[]): void
  /** A session whose read position the watcher forgot (#592): if it comes back, its history is emitted again
   *  (`replayed`) and may repeat events emitted before. Absent for a watcher that never reads a history twice, and
   *  for one that reads it again unmarked (OpenCode), which is wired with `countPanelLoss: false` instead. */
  readonly onSessionReleased?: TypedEvent<string>
}

/** A running runtime: its watcher, a status line describing its connection,
 *  and a disposer for runtime-specific resources beyond the watcher itself
 *  (e.g. the Claude hook server and discovery file). */
export interface AgentRuntime {
  readonly mode: AgentRuntimeMode
  readonly watcher: AgentSessionWatcher
  /** Human-readable connection status for the webview. May change over time. */
  connectionStatus(): string
  dispose(): void
}

/** Options for the default watcher → panel wiring. */
export interface WatchPanelWiringOptions {
  /** Human-readable prefix for the session badge (e.g. "Claude", "Codex"). */
  sessionLabelPrefix: string
  /** Optional event transform — return null to suppress an event. */
  transformEvent?: (event: AgentEvent) => AgentEvent | null
  /** false: this watcher's events are not counted in the panel's loss figure (#592), for a watcher that reads a
   *  history again without marking it `replayed` (OpenCode). The figure then leaves them out: a lower bound. */
  countPanelLoss?: boolean
}

/**
 * Hand an event to the current panel (only once its page is ready, unless `requireReady` is false) and count it,
 * delivered or not: a page that opens later gets a reset, never this event (#592, panel-loss.ts).
 */
export function forwardToPanel(
  event: AgentEvent,
  opts: { requireReady?: boolean; countLoss?: boolean; reread?: boolean } = {},
): void {
  // countLoss false: a source whose re-reads cannot be told apart is left out (the figure stays a lower bound)
  if (opts.countLoss !== false) panelLoss.note(event, { reread: opts.reread })
  const panel = VisualizerPanel.getCurrent()
  if (!panel || (opts.requireReady !== false && !panel.isReady)) return
  panel.sendEvent(event)
}

/**
 * The Claude hook events that survived reconciliation against the transcript, to the panel (#53, #592). Those the
 * reconciler dropped never get here and are not counted: they may duplicate transcript events.
 */
export function wireHookEventsToPanel(watcher: { readonly onHookEvent: TypedEvent<AgentEvent> }): TypedDisposable {
  return watcher.onHookEvent((event) => forwardToPanel(event))
}

/**
 * Wire a watcher's event/lifecycle streams to the current visualizer panel.
 * This is the boilerplate every runtime needs: forward events, broadcast
 * session list changes, and reflect session detection in the status bar.
 *
 * Returns a disposable that unhooks all three listeners — callers wiring the
 * watcher multiple times (e.g. re-wiring on panel reopen) should dispose the
 * previous wiring to avoid accumulating listeners.
 */
export function wireWatcherToPanel(
  watcher: AgentSessionWatcher,
  options: WatchPanelWiringOptions,
): TypedDisposable {
  const subs: TypedDisposable[] = []

  subs.push(watcher.onEvent((event) => {
    const transformed = options.transformEvent ? options.transformEvent(event) : event
    if (transformed) forwardToPanel(transformed, { countLoss: options.countPanelLoss })
  }))
  // Its history may come again: counted once, not twice (#592, panel-loss.ts)
  if (watcher.onSessionReleased && options.countPanelLoss !== false) subs.push(watcher.onSessionReleased((sessionId) => panelLoss.release(sessionId)))

  subs.push(watcher.onSessionDetected((sessionId) => {
    const panel = VisualizerPanel.getCurrent()
    if (panel) {
      const sessionCount = watcher.getActiveSessions().length
      panel.setConnectionStatus('watching', sessionCount > 1
        ? `${sessionCount} ${options.sessionLabelPrefix} sessions`
        : `${options.sessionLabelPrefix} ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
    }
    vscode.window.setStatusBarMessage(
      `Agent Visualizer: watching ${options.sessionLabelPrefix} session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      STATUS_MESSAGE_DURATION_MS,
    )
  }))

  subs.push(watcher.onSessionLifecycle((lifecycle) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel) return
    if (lifecycle.type === 'started') {
      const listed = watcher.getActiveSessions().find(s => s.id === lifecycle.sessionId)
      panel.postMessage({ type: 'session-started', session: startedSessionInfo(lifecycle, listed, Date.now()) })
    } else if (lifecycle.type === 'updated') {
      panel.postMessage(updatedSessionMessage(lifecycle))
    } else {
      panel.postMessage({ type: 'session-ended', sessionId: lifecycle.sessionId })
    }
  }))

  return { dispose: () => { for (const s of subs) s.dispose() } }
}
