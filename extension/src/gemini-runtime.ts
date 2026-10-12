/**
 * Gemini CLI runtime (#238).
 *
 * Gemini CLI has no hook mechanism this extension uses: its only event source is the JSONL file of
 * each session. This runtime wires GeminiSessionWatcher to the visualizer panel and reports a
 * connection status reflecting the watch root.
 */

import * as vscode from 'vscode'
import * as os from 'os'
import { GeminiSessionWatcher, geminiTmpRoot } from './gemini-session-watcher'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('GeminiRuntime')

export function startGeminiRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const watcher = new GeminiSessionWatcher(workspace)
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Gemini',
  })

  watcher.start()

  const rootLabel = geminiTmpRoot().replace(os.homedir(), '~')

  const connectionStatus = (): string => `Gemini CLI session watcher (${rootLabel})`

  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`Gemini CLI runtime started (sessions: ${rootLabel})`)

  return { mode: 'gemini', watcher, connectionStatus, dispose }
}
