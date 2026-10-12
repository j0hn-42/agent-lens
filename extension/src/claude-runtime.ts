/**
 * Claude Code runtime.
 *
 * Wires together the two event sources for a Claude Code session:
 *   1. Hook server — receives live events via a stdin-piped hook script
 *      configured in Claude's settings.json
 *   2. Session watcher — tails Claude Code's JSONL transcripts at
 *      ~/.claude/projects/<encoded>/<session>.jsonl
 *
 * Both sources can be active simultaneously; this runtime routes hook
 * events around the watcher when the watcher is already parsing that
 * session's transcript, to avoid duplicate events with divergent names
 * (hooks use agent_type+id; transcripts use description).
 */

import * as vscode from 'vscode'
import * as path from 'path'
import { HookServer } from './hook-server'
import { OperatorControl, setOperatorControl } from './operator-control'
import { discoveryDir } from './claude-config-dir'
import { SessionWatcher } from './session-watcher'
import { VisualizerPanel } from './webview-provider'
import { AgentEvent } from './protocol'
import {
  ORCHESTRATOR_NAME, HOOK_SERVER_NOT_STARTED,
} from './constants'
import { migrateLegacyHooks } from './hooks-config'
import {
  writeDiscoveryFile, removeDiscoveryFile, ensureHookScript,
} from './discovery'
import { purgeStaleDiscoveryFiles } from './discovery-purge'
import { createLogger } from './logger'
import { filterOrchestratorCompletion } from './orchestrator-completion'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('ClaudeRuntime')

/** Events the session watcher already owns end-to-end via the transcript parser.
 *  Letting hooks re-emit these would create duplicate nodes with divergent names
 *  (hook = agent_type-id, transcript = description). */
const SUBAGENT_LIFECYCLE_EVENTS = new Set<AgentEvent['type']>([
  'agent_spawn', 'subagent_dispatch', 'subagent_return', 'agent_complete',
])

export async function startClaudeRuntime(
  context: vscode.ExtensionContext,
): Promise<AgentRuntime> {
  // ─── Hook server ───────────────────────────────────────────────────────────
  // Operator control (#240): off unless agentVisualizer.allowControl is on. The setting is machine-scoped, so a
  // repository's .vscode/settings.json cannot turn it on. Read at each use: no reload needed to switch it off.
  const control = new OperatorControl({
    allowed: () => vscode.workspace.getConfiguration('agentVisualizer').get<boolean>('allowControl', false) === true,
    getPanel: () => VisualizerPanel.getCurrent(),
    journalFile: path.join(discoveryDir(), 'decisions.jsonl'),
  })
  setOperatorControl(control)
  const hookServer = new HookServer(undefined, undefined, { gate: control.gate, token: control.token })
  context.subscriptions.push(hookServer)

  let hookPort: number
  try {
    hookPort = await hookServer.start()
  } catch (err) {
    log.error('Failed to start hook server:', err)
    hookPort = HOOK_SERVER_NOT_STARTED
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  if (hookPort === HOOK_SERVER_NOT_STARTED) {
    log.info('Hook server skipped (another instance owns the port) — using session watcher only')
  } else {
    log.info(`Hook server running on port ${hookPort}`)

    // Write discovery file so the hook script can find us.
    // The hook script reads this at invocation time — no port in settings.json.
    if (workspace) {
      ensureHookScript()
      writeDiscoveryFile(hookPort, workspace, control.discoveryToken())
      // The token is published only while the setting is on: follow the setting without a reload
      context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('agentVisualizer.allowControl')) {
          writeDiscoveryFile(hookPort, workspace, control.discoveryToken())
          control.settingChanged() // requests already held end now, not at the 55 s expiry
        }
      }))
      void purgeStaleDiscoveryFiles().catch(err => log.debug('Discovery purge failed:', err))
      migrateLegacyHooks()
    }
  }

  // ─── Session watcher ───────────────────────────────────────────────────────
  const watcher = new SessionWatcher()
  context.subscriptions.push(watcher)

  // Route hook events → panel, but filter out events the watcher already owns.
  // Every hook event goes through the watcher's EventReconciler (issue #53): a copy the transcript
  // already reported (or reports later) is dropped, and events arriving while a session history is
  // loaded are held and replayed deduplicated. Survivors come back on watcher.onHookEvent.
  if (hookPort !== HOOK_SERVER_NOT_STARTED) {
    context.subscriptions.push(watcher.onHookEvent((event) => {
      const panel = VisualizerPanel.getCurrent()
      if (panel && panel.isReady) panel.sendEvent(event)
    }))
    hookServer.onEvent((event) => {
      const panel = VisualizerPanel.getCurrent()
      if (!panel || !panel.isReady) return

      const eventSessionId = event.sessionId
      const watcherHandlesThis = eventSessionId
        ? watcher.isSessionActive(eventSessionId)
        : watcher.isActive()

      if (watcherHandlesThis) {
        const agentName = event.payload?.agent ?? event.payload?.name ?? event.payload?.child
        const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName

        // Teammate links/messages are emitted by the watcher's transcript parser too
        if (event.type === 'agent_link' || event.type === 'message_sent') return

        if (isOrchestrator) {
          const filtered = filterOrchestratorCompletion(event)
          if (filtered) watcher.submitHookEvent(filtered)
          return
        }

        // Subagent lifecycle events — let the watcher handle these (it has
        // the correct display name from transcript/meta files)
        if (SUBAGENT_LIFECYCLE_EVENTS.has(event.type)) return

        // Subagent tool/message events — pass through
        watcher.submitHookEvent(event)
        return
      }

      watcher.submitHookEvent(event)
      panel.setConnectionStatus('watching', `Claude Code hooks (:${hookPort})`)
    })
  }

  // Route watcher events + lifecycle → panel (with orchestrator completion filter)
  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Claude',
    transformEvent: filterOrchestratorCompletion,
  })

  watcher.start()

  const connectionStatus = (): string => {
    if (hookPort > 0) return `Hooks :${hookPort} + session watcher`
    return 'Session watcher'
  }

  const dispose = (): void => {
    // Remove our discovery file so the hook script won't forward to a dead port.
    // Hook entries in settings.json are left intact — the command is stable
    // (node ~/.claude/agent-lens/hook.js) and the script handles dead instances
    // gracefully via PID checks. This avoids breaking multi-window setups and
    // means hooks survive VS Code restarts without reconfiguration.
    if (workspace) { removeDiscoveryFile(workspace) }
    setOperatorControl(undefined)
    control.dispose()
    wiring.dispose()
    hookServer.dispose()
    watcher.dispose()
  }

  return { mode: 'claude', watcher, connectionStatus, dispose }
}
