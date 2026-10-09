/**
 * Copilot runtime.
 *
 * Local GitHub Copilot sessions (CLI and app) have no hook mechanism — their only event source is
 * the events.jsonl file of each session directory. This runtime wires CopilotSessionWatcher to the
 * visualizer panel and reports a connection status reflecting the watch root.
 */

import * as vscode from 'vscode'
import * as os from 'os'
import { CopilotSessionWatcher, copilotHome } from './copilot-session-watcher'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('CopilotRuntime')

export function startCopilotRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const watcher = new CopilotSessionWatcher(workspace)
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Copilot',
  })

  watcher.start()

  const homeLabel = copilotHome().replace(os.homedir(), '~')

  const connectionStatus = (): string => `Copilot session watcher (${homeLabel})`

  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`Copilot runtime started (home: ${homeLabel})`)

  return { mode: 'copilot', watcher, connectionStatus, dispose }
}
