/**
 * Single resolver for Claude Code's configuration root: CLAUDE_CONFIG_DIR when set
 * (multi-account setups), otherwise ~/.claude. Everything read from Claude's side
 * (projects, teams, memory, settings.json) goes through here.
 *
 * The Agent Lens discovery dir (hook.js, discovery files) deliberately stays at
 * ~/.claude/agent-lens whatever the account: the hook command written in every
 * account's settings.json points to that one stable hook.js, and instances of all
 * accounts find each other there. See discoveryDir().
 */
import * as os from 'os'
import * as path from 'path'
import { claudeConfigDir as sharedClaudeConfigDir } from '../scripts/claude-hooks'

/** Root of Claude Code's config. Blank values fall back to ~/.claude. Shared with setup.js and uninstall.js. */
export const claudeConfigDir: (env?: NodeJS.ProcessEnv, home?: string) => string = sharedClaudeConfigDir

export function claudeProjectsDir(configDir: string = claudeConfigDir()): string {
  return path.join(configDir, 'projects')
}

export function claudeTeamsDir(configDir: string = claudeConfigDir()): string {
  return path.join(configDir, 'teams')
}

export function claudeSettingsPath(configDir: string = claudeConfigDir()): string {
  return path.join(configDir, 'settings.json')
}

/** Shared, account-independent discovery dir (hook.js + {hash}-{pid}.json files). */
export function discoveryDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'agent-lens')
}
