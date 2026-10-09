/**
 * Single implementation of "which Claude Code hooks belong to Agent Lens" and of the safe
 * settings.json read-modify-write, shared by:
 *   - the extension (TypeScript, bundled by esbuild: extension/src/claude-settings.ts, settings-writer.ts),
 *   - the standalone installer (scripts/setup.js),
 *   - the uninstall script (extension/scripts/uninstall.js), which runs from the installed .vsix
 *     with plain node: hence CommonJS, no dependency, and shipped next to uninstall.js.
 * Types: claude-hooks.d.ts.
 *
 * Detection relies on command markers only (#199): a user's own `type: "http"` hook to
 * http://127.0.0.1:<port>/... is never ours. Hooks written under the project's former name
 * (agent-flow/hook.js) are "legacy": recognised so they can be replaced or removed, but they do
 * not count as configured, since that hook.js reads ~/.claude/agent-flow and never reaches Agent Lens (#175).
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const HOOK_COMMAND_MARKER = 'agent-lens/hook.js'
/** Hooks installed under the project's former name. */
const LEGACY_HOOK_COMMAND_MARKER = 'agent-flow/hook.js'
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024
/** Global settings.json files Agent Lens wrote hooks into (one path per line), for uninstall (#217). */
const SETTINGS_PATHS_FILE = 'settings-paths.txt'

// ─── Detection ──────────────────────────────────────────────────────────────

/** 'current' for an Agent Lens hook, 'legacy' for an agent-flow one, null otherwise. Never throws. */
function hookKind(hook) {
  if (!hook || typeof hook !== 'object' || typeof hook.command !== 'string') return null
  // Normalize backslashes so Windows paths (C:\Users\...\agent-lens\hook.js) match the marker.
  const command = hook.command.replace(/\\/g, '/')
  if (command.includes(HOOK_COMMAND_MARKER)) return 'current'
  if (command.includes(LEGACY_HOOK_COMMAND_MARKER)) return 'legacy'
  return null
}

function entryHooks(entry) {
  return entry && typeof entry === 'object' && Array.isArray(entry.hooks) ? entry.hooks : null
}

/** True when the entry holds at least one Agent Lens hook, current or legacy (to replace or remove it). */
function isAgentLensHook(entry) {
  const hooks = entryHooks(entry)
  return !!hooks && hooks.some(h => hookKind(h) !== null)
}

/** True when the entry holds a current Agent Lens hook (counts as "configured"). */
function isCurrentAgentLensHook(entry) {
  const hooks = entryHooks(entry)
  return !!hooks && hooks.some(h => hookKind(h) === 'current')
}

function hooksSection(settings) {
  if (!settings || typeof settings !== 'object') return null
  const hooks = settings.hooks
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? hooks : null
}

function someEntry(settings, predicate) {
  const hooks = hooksSection(settings)
  if (!hooks) return false
  return Object.values(hooks).some(entries => Array.isArray(entries) && entries.some(predicate))
}

/** True when the settings configure current Agent Lens hooks (legacy agent-flow hooks do not count). */
function settingsHaveAgentLensHooks(settings) {
  return someEntry(settings, isCurrentAgentLensHook)
}

/** True when the settings still hold agent-flow/hook.js hooks. */
function settingsHaveLegacyHooks(settings) {
  return someEntry(settings, entry => {
    const hooks = entryHooks(entry)
    return !!hooks && hooks.some(h => hookKind(h) === 'legacy')
  })
}

// ─── Mutation (in place) ────────────────────────────────────────────────────

/**
 * Remove Agent Lens hooks (current and legacy) from one event's entries. The user's sibling hooks
 * in the same entry are kept; an entry is dropped only when nothing of the user's is left (#199).
 */
function stripEntries(entries) {
  let changed = false
  const kept = []
  for (const entry of entries) {
    const hooks = entryHooks(entry)
    if (!hooks || !hooks.some(h => hookKind(h) !== null)) { kept.push(entry); continue }
    changed = true
    const others = hooks.filter(h => hookKind(h) === null)
    if (others.length > 0) kept.push({ ...entry, hooks: others })
  }
  return { kept, changed }
}

/** Remove every Agent Lens hook from `settings`; empty events and an empty hooks section are deleted. */
function removeAgentLensHooks(settings) {
  const hooks = hooksSection(settings)
  if (!hooks) return false
  let changed = false
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    const result = stripEntries(entries)
    if (!result.changed) continue
    changed = true
    if (result.kept.length === 0) delete hooks[event]
    else hooks[event] = result.kept
  }
  if (changed && Object.keys(hooks).length === 0) delete settings.hooks
  return changed
}

/** Merge Agent Lens hooks into `settings`: user hooks are kept, previous Agent Lens hooks (any event) replaced. */
function applyAgentLensHooks(settings, hooksConfig) {
  const existing = hooksSection(settings)
  const hooks = existing || {}
  if (existing) removeAgentLensHooks({ hooks })
  for (const [event, entries] of Object.entries(hooksConfig)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : []
    hooks[event] = [...current, ...entries]
  }
  settings.hooks = hooks
}

/**
 * Rewrite agent-flow/hook.js hooks to Agent Lens (#175): every event that holds a legacy hook gets
 * its Agent Lens hooks replaced by one `entry`. Events without legacy hooks and user hooks are untouched.
 * Returns true when something changed.
 */
function migrateLegacyHooks(settings, entry) {
  const hooks = hooksSection(settings)
  if (!hooks) return false
  let changed = false
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    const hasLegacy = entries.some(e => { const h = entryHooks(e); return !!h && h.some(x => hookKind(x) === 'legacy') })
    if (!hasLegacy) continue
    hooks[event] = [...stripEntries(entries).kept, JSON.parse(JSON.stringify(entry))]
    changed = true
  }
  return changed
}

// ─── Files ──────────────────────────────────────────────────────────────────

/** Claude Code's config root: CLAUDE_CONFIG_DIR when set (multi-account), otherwise ~/.claude. */
function claudeConfigDir(env = process.env, home = os.homedir()) {
  const raw = (env.CLAUDE_CONFIG_DIR || '').trim()
  if (!raw) return path.join(home, '.claude')
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2))
  return path.resolve(raw)
}

class SettingsUnreadableError extends Error {
  constructor(filePath, reason) {
    super(`Cannot read ${filePath} (${reason}). Agent Lens will not modify it: fix or remove the file, then retry.`)
    this.name = 'SettingsUnreadableError'
    this.filePath = filePath
    this.reason = reason
  }
}

/** Parsed settings object, or null when the file does not exist. Throws SettingsUnreadableError otherwise. */
function readSettingsStrict(filePath, maxBytes = SETTINGS_FILE_MAX_BYTES) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw new SettingsUnreadableError(filePath, err.message)
  }
  if (!stat.isFile()) throw new SettingsUnreadableError(filePath, 'not a regular file')
  if (stat.size > maxBytes) throw new SettingsUnreadableError(filePath, 'file too large')
  let raw
  try { raw = fs.readFileSync(filePath, 'utf-8') } catch (err) { throw new SettingsUnreadableError(filePath, err.message) }
  if (raw.trim() === '') throw new SettingsUnreadableError(filePath, 'empty file')
  let parsed
  try { parsed = JSON.parse(raw) } catch (err) { throw new SettingsUnreadableError(filePath, `invalid JSON: ${err.message}`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsUnreadableError(filePath, 'not a JSON object')
  }
  return parsed
}

/**
 * Atomic write: unique temp file next to the target (exclusive create), fsync, rename over it.
 * A symlinked target is written through (the link survives); an existing file keeps its mode,
 * a new one is created 0600 (its folder 0700). On failure the temp file is removed and the
 * previous file is untouched.
 */
function writeFileAtomic(filePath, content) {
  let target = filePath
  let mode = 0o600
  try {
    target = fs.realpathSync(filePath)
    const stat = fs.statSync(target)
    if (stat.isFile()) mode = stat.mode & 0o777
  } catch { /* new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', mode)
    fs.writeSync(fd, content)
    fs.fchmodSync(fd, mode) // the create mode went through the umask
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, target)
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp) } catch { /* never created or already gone */ }
    throw err
  }
}

/**
 * Apply `mutate` to the settings at `filePath` and write the result atomically, keeping a one-time
 * `.bak` of the original. Throws SettingsUnreadableError (file untouched) when the existing file is
 * unusable. Returns false (and writes nothing) when `mutate` changed nothing.
 * With `{ deleteIfEmpty: true }` a file left as `{}` is removed instead of rewritten.
 */
function updateSettings(filePath, mutate, options = {}) {
  const existing = readSettingsStrict(filePath, options.maxBytes)
  const settings = existing || {}
  const before = JSON.stringify(settings)
  mutate(settings)
  if (existing && JSON.stringify(settings) === before) return false
  if (!existing && Object.keys(settings).length === 0) return false

  if (existing) {
    const backupPath = `${filePath}.bak`
    // Keep the very first original: a later run must not replace it with an already-modified copy.
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath)
  }
  if (options.deleteIfEmpty && Object.keys(settings).length === 0) {
    fs.unlinkSync(filePath)
    return true
  }
  writeFileAtomic(filePath, JSON.stringify(settings, null, 2) + '\n')
  return true
}

// ─── Settings files Agent Lens wrote to ─────────────────────────────────────

/** Paths recorded by recordSettingsPath (missing or unreadable list: []). */
function readSettingsPaths(discoveryDir) {
  try {
    const raw = fs.readFileSync(path.join(discoveryDir, SETTINGS_PATHS_FILE), 'utf-8')
    return [...new Set(raw.split(/\r?\n/).map(l => l.trim()).filter(l => path.isAbsolute(l)))]
  } catch {
    return []
  }
}

/** Remember a global settings.json Agent Lens wrote hooks into, so uninstall can clean every account. */
function recordSettingsPath(discoveryDir, settingsPath) {
  const resolved = path.resolve(settingsPath)
  const known = readSettingsPaths(discoveryDir)
  if (known.includes(resolved)) return
  writeFileAtomic(path.join(discoveryDir, SETTINGS_PATHS_FILE), [...known, resolved].join('\n') + '\n')
}

module.exports = {
  HOOK_COMMAND_MARKER,
  LEGACY_HOOK_COMMAND_MARKER,
  SETTINGS_FILE_MAX_BYTES,
  SETTINGS_PATHS_FILE,
  hookKind,
  isAgentLensHook,
  isCurrentAgentLensHook,
  settingsHaveAgentLensHooks,
  settingsHaveLegacyHooks,
  removeAgentLensHooks,
  applyAgentLensHooks,
  migrateLegacyHooks,
  claudeConfigDir,
  SettingsUnreadableError,
  readSettingsStrict,
  writeFileAtomic,
  updateSettings,
  readSettingsPaths,
  recordSettingsPath,
}
