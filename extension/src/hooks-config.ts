import * as vscode from 'vscode'
import * as path from 'path'
import { HOOK_TIMEOUT_S, PERMISSION_HOOK_TIMEOUT_S } from './constants'
import {
  getHookCommand, ensureHookScript, getPermissionHookCommand, ensurePermissionHookScript,
  addWorkspaceToManifest,
} from './discovery'
import {
  applyAgentLensHooks, settingsHaveAgentLensHooks, readSettingsFile, isHooksConfigured,
  migrateLegacyHookFiles, unreadableSettingsMessage,
} from './claude-settings'
import { claudeSettingsPath, discoveryDir } from './claude-config-dir'
import { updateSettings, SettingsUnreadableError } from './settings-writer'
import { applyControlHook, removeControlHook as stripControlHook, settingsHaveControlHook } from '../scripts/claude-hooks'
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

// ─── Operator control hook (#240) ─────────────────────────────────────────────

function controlHookEntry(): { hooks: Array<{ type: string; command: string; timeout: number }> } {
  return { hooks: [{ type: 'command', command: getPermissionHookCommand(), timeout: PERMISSION_HOOK_TIMEOUT_S }] }
}

/** True when the global settings hold the PermissionRequest hook of the operator control. Never throws. */
export function isControlHookInstalled(): boolean {
  return settingsHaveControlHook(readGlobalSettings())
}

/**
 * Called at each start of the Claude runtime: when the control hook is installed, bring its script up to date, as
 * hook.js is, so a protocol change (headers, proof, answer shape) reaches existing installs without a manual
 * reinstall. Never installs anything on a machine that did not ask for the control hook.
 */
export function refreshControlHookScript(): void {
  try {
    if (isControlHookInstalled()) { ensurePermissionHookScript() }
  } catch (err) {
    log.warn('Could not refresh the permission hook script:', err)
  }
}

/**
 * Install the optional PermissionRequest hook (separate from the observation hooks, 60 s timeout). It does nothing
 * unless agentVisualizer.allowControl is on and a panel can answer: otherwise it prints no decision.
 */
export async function installControlHook(): Promise<void> {
  ensurePermissionHookScript()
  const settingsPath = globalSettingsPath()
  try {
    updateSettings(settingsPath, settings => applyControlHook(settings, controlHookEntry()))
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
    'Agent Lens permission hook installed. It is inactive until the setting "agentVisualizer.allowControl" is on, '
    + 'and it only holds a request while the Agent Lens panel can answer it.',
  )
}

/** Remove the PermissionRequest hook of the operator control; the observation hooks and the user's hooks stay. */
export async function removeControlHook(): Promise<void> {
  const settingsPath = globalSettingsPath()
  try {
    updateSettings(settingsPath, settings => { stripControlHook(settings) })
  } catch (err) {
    if (err instanceof SettingsUnreadableError) {
      log.error(err.message)
      vscode.window.showErrorMessage(unreadableSettingsMessage(err))
      return
    }
    throw err
  }
  vscode.window.showInformationMessage('Agent Lens permission hook removed. Claude Code asks for permissions as usual.')
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

export { isDisable1MContext } from './claude-settings'

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
