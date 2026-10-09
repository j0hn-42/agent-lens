import * as vscode from 'vscode'
import * as path from 'path'
import { HOOK_TIMEOUT_S } from './constants'
import {
  getHookCommand, ensureHookScript,
  addWorkspaceToManifest,
} from './discovery'
import {
  applyAgentLensHooks, settingsHaveAgentLensHooks, readSettingsFile, isHooksConfigured,
  migrateLegacyHookFiles, unreadableSettingsMessage,
} from './claude-settings'
import { claudeSettingsPath, discoveryDir } from './claude-config-dir'
import { updateSettings, SettingsUnreadableError } from './settings-writer'
import { recordSettingsPath } from '../scripts/claude-hooks'
import { createLogger } from './logger'

const log = createLogger('Hooks')

/** Claude's global settings.json (follows CLAUDE_CONFIG_DIR); resolved on each call. */
function globalSettingsPath(): string { return claudeSettingsPath() }

/** Read Claude Code's global settings.json for read-only checks. Null when missing or unreadable. */
function readGlobalSettings(): Record<string, unknown> | null {
  const settings = readSettingsFile(globalSettingsPath())
  return settings && typeof settings === 'object' ? settings as Record<string, unknown> : null
}

/** Remember the global settings file we wrote hooks into, so uninstall cleans every account (#217). */
function rememberGlobalSettings(settingsPath: string): void {
  try {
    recordSettingsPath(discoveryDir(), settingsPath)
  } catch (err) {
    log.debug('Failed to record settings path:', err)
  }
}

function hookEntry(): { hooks: Array<{ type: string; command: string; timeout: number }> } {
  return { hooks: [{ type: 'command', command: getHookCommand(), timeout: HOOK_TIMEOUT_S }] }
}

// ─── Detection ────────────────────────────────────────────────────────────────

/** Only current agent-lens/hook.js hooks count: legacy agent-flow ones never reach Agent Lens (#175). */
function hooksAlreadyConfigured(): boolean {
  if (hasAgentLensHooks(globalSettingsPath())) {
    rememberGlobalSettings(globalSettingsPath())
    return true
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    const projectPath = path.join(workspaceFolder, '.claude', 'settings.local.json')
    if (hasAgentLensHooks(projectPath)) {
      // Backfill manifest for workspaces configured before the manifest existed
      addWorkspaceToManifest(workspaceFolder)
      return true
    }
  }

  return false
}

function hasAgentLensHooks(settingsPath: string): boolean {
  return settingsHaveAgentLensHooks(readSettingsFile(settingsPath))
}

/** True when Agent Lens hooks are present in the global or the workspace settings. Never throws. */
export function areHooksConfigured(): boolean {
  return isHooksConfigured(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
}

// ─── Configure ────────────────────────────────────────────────────────────────

export async function configureClaudeHooks(): Promise<void> {
  ensureHookScript()

  const entry = hookEntry()
  const hooksConfig = {
    SessionStart: [entry],
    PreToolUse: [entry],
    PostToolUse: [entry],
    PostToolUseFailure: [entry],
    SubagentStart: [entry],
    SubagentStop: [entry],
    Notification: [entry],
    Stop: [entry],
    SessionEnd: [entry],
  }

  const settingsPath = globalSettingsPath()
  try {
    updateSettings(settingsPath, settings => applyAgentLensHooks(settings, hooksConfig))
  } catch (err) {
    if (err instanceof SettingsUnreadableError) {
      log.error(err.message)
      vscode.window.showErrorMessage(unreadableSettingsMessage(err))
      return
    }
    throw err
  }
  rememberGlobalSettings(settingsPath)

  vscode.window.showInformationMessage(
    'Claude Code hooks configured. New sessions will stream events to Agent Lens.',
  )
}

// ─── Migration ────────────────────────────────────────────────────────────────

/** Rewrite hooks left by Agent Flow (agent-flow/hook.js) to Agent Lens' hook. Called on activation.
 *  User hooks, including their own http hooks to 127.0.0.1, are never touched (#199).
 *  Caller must call ensureHookScript() first. */
export function migrateLegacyHooks(): void {
  const global = globalSettingsPath()
  const pathsToCheck: string[] = [global]
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const projectPath = workspaceFolder ? path.join(workspaceFolder, '.claude', 'settings.local.json') : undefined
  if (projectPath) { pathsToCheck.push(projectPath) }

  const changed = migrateLegacyHookFiles(pathsToCheck, hookEntry(), (file, err) => {
    log.error(`Failed to migrate ${file}:`, err)
  })
  for (const file of changed) {
    log.info(`Migrated agent-flow hooks → Agent Lens hooks in ${file}`)
    if (file === global) { rememberGlobalSettings(global) }
    // Ensure migrated project-level hooks are tracked in the manifest
    if (workspaceFolder && file === projectPath) { addWorkspaceToManifest(workspaceFolder) }
  }
}

// ─── Claude Code Environment ─────────────────────────────────────────────────

/** Check whether CLAUDE_CODE_DISABLE_1M_CONTEXT is set (via env or Claude Code settings). */
export function isDisable1MContext(): boolean {
  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') { return true }
  const settings = readGlobalSettings()
  return (settings?.env as Record<string, unknown>)?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1'
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

/** Configure hooks unless current Agent Lens hooks are present. Settings holding only legacy
 *  agent-flow hooks are migrated first; if that is not enough, the full configuration runs (#175). */
export async function promptHookSetupIfNeeded(_context: vscode.ExtensionContext): Promise<void> {
  if (hooksAlreadyConfigured()) { return }
  ensureHookScript()
  migrateLegacyHooks()
  if (hooksAlreadyConfigured()) { return }
  await configureClaudeHooks()
}
