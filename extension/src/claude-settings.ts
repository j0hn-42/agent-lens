/**
 * Defensive, vscode-free reading of Claude Code settings files, used to tell the UI whether
 * Agent Lens hooks are configured (empty-state checklist, relay GET /status).
 * settings.json is user-editable and may be missing, huge, invalid or oddly shaped: every
 * function here returns a conservative answer instead of throwing.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ClaudeHookEntry } from './protocol'
import { HOOK_URL_PREFIX, SETTINGS_FILE_MAX_BYTES } from './constants'
import { claudeConfigDir, claudeSettingsPath } from './claude-config-dir'
import { HOOK_COMMAND_MARKER, LEGACY_HOOK_COMMAND_MARKER } from './discovery'

/** Check whether a single hook entry belongs to Agent Lens (command, legacy marker or legacy HTTP url). */
export function isAgentLensHook(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') { return false }
  const hooks = (entry as ClaudeHookEntry).hooks
  if (!Array.isArray(hooks)) { return false }
  return hooks.some(h => {
    if (!h || typeof h !== 'object') { return false }
    // Normalize backslashes so Windows paths (C:\\Users\\...\\agent-lens\\hook.js) match the marker.
    const command = typeof h.command === 'string' ? h.command.replace(/\\/g, '/') : ''
    return command.includes(HOOK_COMMAND_MARKER)
      || command.includes(LEGACY_HOOK_COMMAND_MARKER)
      || (typeof h.url === 'string' && h.url.startsWith(HOOK_URL_PREFIX))
  })
}

/** True when a parsed settings object contains at least one Agent Lens hook. */
export function settingsHaveAgentLensHooks(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') { return false }
  const hooks = (settings as { hooks?: unknown }).hooks
  if (!hooks || typeof hooks !== 'object') { return false }
  return Object.values(hooks as Record<string, unknown>).some(
    entries => Array.isArray(entries) && entries.some(isAgentLensHook),
  )
}

/** Parse a settings file; null when missing, not a regular file, too large or invalid JSON. */
export function readSettingsFile(filePath: string, maxBytes = SETTINGS_FILE_MAX_BYTES): unknown {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > maxBytes) { return null }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/** Global settings plus (when known) the workspace's local settings. */
export function claudeSettingsPaths(workspace?: string, configDir = claudeConfigDir()): string[] {
  const paths = [claudeSettingsPath(configDir)]
  if (workspace) { paths.push(path.join(workspace, '.claude', 'settings.local.json')) }
  return paths
}

/** Whether any of the settings files configures Agent Lens hooks. */
export function isHooksConfigured(workspace?: string, configDir = claudeConfigDir()): boolean {
  return claudeSettingsPaths(workspace, configDir).some(p => settingsHaveAgentLensHooks(readSettingsFile(p)))
}
