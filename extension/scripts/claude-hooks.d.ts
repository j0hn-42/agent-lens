/** Types for claude-hooks.js (CommonJS, shared by the extension, scripts/setup.js and uninstall.js). */

export const HOOK_COMMAND_MARKER: 'agent-lens/hook.js'
export const LEGACY_HOOK_COMMAND_MARKER: 'agent-flow/hook.js'
export const SETTINGS_FILE_MAX_BYTES: number
export const SETTINGS_PATHS_FILE: string

export type HookKind = 'current' | 'legacy' | null

export function hookKind(hook: unknown): HookKind
export function isAgentLensHook(entry: unknown): boolean
export function isCurrentAgentLensHook(entry: unknown): boolean
export function settingsHaveAgentLensHooks(settings: unknown): boolean
export function settingsHaveLegacyHooks(settings: unknown): boolean
export function removeAgentLensHooks(settings: Record<string, unknown>): boolean
export function applyAgentLensHooks(settings: Record<string, unknown>, hooksConfig: Record<string, unknown[]>): void
export function migrateLegacyHooks(settings: Record<string, unknown>, entry: unknown): boolean

export function claudeConfigDir(env?: NodeJS.ProcessEnv, home?: string): string

export class SettingsUnreadableError extends Error {
  constructor(filePath: string, reason: string)
  readonly filePath: string
  readonly reason: string
}
export function readSettingsStrict(filePath: string, maxBytes?: number): Record<string, unknown> | null
export function writeFileAtomic(filePath: string, content: string): void
export function updateSettings(
  filePath: string,
  mutate: (settings: Record<string, unknown>) => void,
  options?: { deleteIfEmpty?: boolean; maxBytes?: number },
): boolean

export function readSettingsPaths(discoveryDir: string): string[]
export function recordSettingsPath(discoveryDir: string, settingsPath: string): void
