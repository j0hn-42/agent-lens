/**
 * Defensive, vscode-free reading of Claude Code settings files, used to tell the UI whether
 * Agent Lens hooks are configured (empty-state checklist, relay GET /status).
 * settings.json is user-editable and may be missing, huge, invalid or oddly shaped: every
 * function here returns a conservative answer instead of throwing.
 */
import * as fs from 'fs'
import * as path from 'path'
import { SETTINGS_FILE_MAX_BYTES } from './constants'
import { claudeConfigDir, claudeSettingsPath } from './claude-config-dir'
import { settingsHaveAgentLensHooks, migrateLegacyHooks, updateSettings } from '../scripts/claude-hooks'

/** Title of the agentVisualizer.configureHooks command, as shown in the palette (category: title). */
export const CONFIGURE_HOOKS_COMMAND_TITLE = 'Agent Lens: Configure Claude Code Hooks'

// Detection and merging live in one CommonJS module shared with scripts/setup.js and uninstall.js (#217).
// Only command markers count (#199); legacy agent-flow hooks are replaced but are not "configured" (#175).
export {
  isAgentLensHook, isCurrentAgentLensHook, applyAgentLensHooks, settingsHaveAgentLensHooks,
  settingsHaveLegacyHooks, migrateLegacyHooks, removeAgentLensHooks,
} from '../scripts/claude-hooks'

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

/**
 * Rewrite legacy agent-flow/hook.js hooks to `entry` in each settings file (#175). Missing files are
 * skipped and unreadable ones left untouched (reported through `onError`); user hooks, including
 * their own http hooks to 127.0.0.1, are never modified (#199). Returns the files that changed.
 */
export function migrateLegacyHookFiles(
  paths: readonly string[], entry: unknown, onError?: (file: string, err: unknown) => void,
): string[] {
  const changed: string[] = []
  for (const file of paths) {
    try {
      if (updateSettings(file, settings => { migrateLegacyHooks(settings, entry) })) { changed.push(file) }
    } catch (err) {
      onError?.(file, err)
    }
  }
  return changed
}

/** Message for a settings file Agent Lens refused to modify: the actual reason and the exact command title (#175). */
export function unreadableSettingsMessage(err: { filePath: string; reason: string }): string {
  return `Agent Lens: ${err.filePath} cannot be used (${err.reason}). Hooks were not configured and the file `
    + `was left untouched. Fix it, then run the "${CONFIGURE_HOOKS_COMMAND_TITLE}" command.`
}
