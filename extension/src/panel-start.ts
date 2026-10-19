/**
 * What a page of the panel receives when it says `ready` (extension.ts, wirePanel). No vscode dependency: the
 * order of the messages and the loss figure it ends with are tested on their own (#592).
 *
 * Order: the panel is marked ready (live events flow from now on), `reset` clears what an earlier page left, the
 * config, then the session list FIRST so the page selects a session before the replay arrives (otherwise replayed
 * events have no selected session to match and are only buffered), the replay, and last `event-loss`: what this page
 * will never receive. The replay is synchronous, so no live event interleaves, and what it re-sends is taken off the
 * figure (see panel-loss.ts). Nothing is read again from the transcripts or the JSONL event log.
 */
import type { ExtensionToWebviewMessage, SessionInfo, ConnectionStatus } from './protocol'
import { panelLoss as defaultLedger, type PanelLossLedger } from './panel-loss'

export interface PageStartPanel {
  markReady(): void
  postMessage(message: ExtensionToWebviewMessage): void
  setConnectionStatus(status: ConnectionStatus, source: string): void
}

export interface PageStartDeps {
  collectActiveSessions(): SessionInfo[]
  /** Re-emits the agents of these sessions through the watchers (synchronous) */
  replaySessions(sessionIds: string[]): void
  disable1MContext(): boolean
  hooksConfigured(): boolean
  connectionStatus(): string
  /** Whether this panel is still the one to write to when a later update of its figure comes */
  isCurrent?(): boolean
  ledger?: PanelLossLedger
}

export function startPanelPage(panel: PageStartPanel, deps: PageStartDeps): void {
  const ledger = deps.ledger ?? defaultLedger
  panel.markReady()
  // Clear stale webview state from any previous panel instance
  panel.postMessage({ type: 'reset', reason: 'panel-reopened' })
  // Environment-derived config (e.g. CLAUDE_CODE_DISABLE_1M_CONTEXT)
  if (deps.disable1MContext()) panel.postMessage({ type: 'config', config: { disable1MContext: true } })
  // Hooks-configured flag for the empty-state checklist (read defensively, never throws)
  panel.postMessage({ type: 'config', config: { hooksConfigured: deps.hooksConfigured() } })
  const sessions = deps.collectActiveSessions()
  const loss = ledger.snapshotAfterReplay(() => {
    if (sessions.length > 0) {
      panel.postMessage({ type: 'session-list', sessions })
      deps.replaySessions(sessions.map(s => s.id))
    }
  }, (update) => {
    // A history read again while this page is open lowered its figure (panel-loss.ts, release)
    if (deps.isCurrent && !deps.isCurrent()) return
    panel.postMessage({ type: 'event-loss', ...update })
  })
  if (loss) panel.postMessage({ type: 'event-loss', ...loss })
  panel.setConnectionStatus('watching', deps.connectionStatus())
}
