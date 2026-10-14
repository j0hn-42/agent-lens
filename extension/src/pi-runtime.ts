/**
 * Pi runtime (#238).
 *
 * The Pi coding agent has no hook mechanism this extension uses: its only event source is the JSONL
 * file of each session. This runtime wires PiSessionWatcher to the visualizer panel and reports a
 * connection status reflecting the watch root.
 */

import * as vscode from 'vscode'
import * as os from 'os'
import { PiSessionWatcher, piSessionsRoot } from './pi-session-watcher'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('PiRuntime')

export function startPiRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const watcher = new PiSessionWatcher(workspace)
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Pi',
  })

  watcher.start()

  const rootLabel = piSessionsRoot().replace(os.homedir(), '~')

  const connectionStatus = (): string => `Pi session watcher (${rootLabel})`

  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`Pi runtime started (sessions: ${rootLabel})`)

  return { mode: 'pi', watcher, connectionStatus, dispose }
}
