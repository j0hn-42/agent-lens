/**
 * Safe read-modify-write of Claude Code's settings.json (vscode-free).
 * The file belongs to the user: if it cannot be parsed we refuse to touch it (starting from {}
 * would wipe permissions, env, model and other hooks). Writes are atomic (tmp + rename) and the
 * original is kept once as settings.json.bak before the first modification.
 * The implementation lives in ../scripts/claude-hooks.js, shared with scripts/setup.js and uninstall.js.
 */
// One implementation shared with scripts/setup.js and extension/scripts/uninstall.js (#217).
export {
  SettingsUnreadableError, readSettingsStrict, writeFileAtomic, updateSettings,
} from '../scripts/claude-hooks'
