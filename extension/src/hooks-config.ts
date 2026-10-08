import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { ClaudeHookEntry } from './protocol'
import { HOOK_URL_PREFIX, HOOK_TIMEOUT_S } from './constants'
import {
  getHookCommand, ensureHookScript,
  addWorkspaceToManifest,
} from './discovery'
import { applyAgentLensHooks, settingsHaveAgentLensHooks, readSettingsFile, isHooksConfigured } from './claude-settings'
import { claudeSettingsPath } from './claude-config-dir'
import { updateSettings, SettingsUnreadableError } from './settings-writer'
import { createLogger } from './logger'

const log = createLogger('Hooks')

/** Claude's global settings.json (follows CLAUDE_CONFIG_DIR); resolved on each call. */
function globalSettingsPath(): string { return claudeSettingsPath() }

/** Read Claude Code's global settings.json for read-only checks. Null when missing or unreadable. */
function readGlobalSettings(): Record<string, unknown> | null {
  const settings = readSettingsFile(globalSettingsPath())
  return settings && typeof settings === 'object' ? settings as Record<string, unknown> : null
}

// ─── Detection ────────────────────────────────────────────────────────────────

function hooksAlreadyConfigured(): boolean {
  if (hasAgentLensHooks(globalSettingsPath())) { return true }

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

  const hookCommand = getHookCommand()
  const hookEntry = { hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S }] }

  const hooksConfig = {
    SessionStart: [hookEntry],
    PreToolUse: [hookEntry],
    PostToolUse: [hookEntry],
    PostToolUseFailure: [hookEntry],
    SubagentStart: [hookEntry],
    SubagentStop: [hookEntry],
    Notification: [hookEntry],
    Stop: [hookEntry],
    SessionEnd: [hookEntry],
  }

  try {
    updateSettings(globalSettingsPath(), settings => applyAgentLensHooks(settings, hooksConfig))
  } catch (err) {
    if (err instanceof SettingsUnreadableError) {
      log.error(err.message)
      vscode.window.showErrorMessage(
        `Agent Lens: ${err.filePath} is not valid JSON (${err.reason}). Hooks were not configured and the file was left untouched. Fix it, then run the "Configure Claude Code hooks" command.`,
      )
      return
    }
    throw err
  }

  vscode.window.showInformationMessage(
    'Claude Code hooks configured. New sessions will stream events to Agent Lens.',
  )
}

// ─── Migration ────────────────────────────────────────────────────────────────

/** Replace legacy HTTP hooks with command hooks. Called once on activation.
 *  Caller must call ensureHookScript() first. */
export function migrateHttpHooks(): void {
  const pathsToCheck: string[] = [globalSettingsPath()]
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    pathsToCheck.push(path.join(workspaceFolder, '.claude', 'settings.local.json'))
  }

  const hookCommand = getHookCommand()

  for (const settingsPath of pathsToCheck) {
    try {
      if (!fs.existsSync(settingsPath)) { continue }
      const changed = updateSettings(settingsPath, settings => {
        const hooks = settings.hooks
        if (!hooks || typeof hooks !== 'object') { return }
        for (const entries of Object.values(hooks as Record<string, unknown>)) {
          if (!Array.isArray(entries)) { continue }
          for (const entry of entries) {
            const e = entry as ClaudeHookEntry
            if (!Array.isArray(e?.hooks)) { continue }
            for (const h of e.hooks) {
              if (h?.url?.startsWith(HOOK_URL_PREFIX)) {
                // Replace HTTP hook with command hook
                delete h.url
                h.type = 'command'
                h.command = hookCommand
                if (h.timeout === undefined) { h.timeout = HOOK_TIMEOUT_S }
              }
            }
          }
        }
      })
      if (changed) {
        log.info(`Migrated HTTP hooks → command hooks in ${settingsPath}`)
        // Ensure migrated project-level hooks are tracked in the manifest
        if (workspaceFolder && settingsPath.includes(workspaceFolder)) {
          addWorkspaceToManifest(workspaceFolder)
        }
      }
    } catch (err) {
      log.error(`Failed to migrate ${settingsPath}:`, err)
    }
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

export async function promptHookSetupIfNeeded(_context: vscode.ExtensionContext): Promise<void> {
  if (hooksAlreadyConfigured()) { return }
  await configureClaudeHooks()
}
