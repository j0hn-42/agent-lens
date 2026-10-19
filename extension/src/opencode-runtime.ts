/**
 * OpenCode runtime (#346).
 *
 * OpenCode has no hook mechanism this extension uses: its only event source is its SQLite database,
 * read-only. This runtime wires OpenCodeSessionWatcher to the visualizer panel and reports a
 * connection status that says whether the database was found.
 */

import * as vscode from 'vscode'
import { OpenCodeSessionWatcher } from './opencode-session-watcher'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('OpenCodeRuntime')

export function startOpenCodeRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const watcher = new OpenCodeSessionWatcher(workspace)
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'OpenCode',
    // Its re-reads (a replaced database, an evicted session that comes back) are emitted without `replayed`, so they
    // cannot be told from new events: left out of the panel's loss figure rather than counted twice (#592)
    countPanelLoss: false,
  })

  watcher.start()

  const connectionStatus = (): string => watcher.status()

  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`OpenCode runtime started (${watcher.status()})`)

  return { mode: 'opencode', watcher, connectionStatus, dispose }
}
