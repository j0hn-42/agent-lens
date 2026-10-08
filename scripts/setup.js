#!/usr/bin/env node
/**
 * Standalone setup script for Agent Lens.
 *
 * Performs the same hook configuration that the VS Code extension does on
 * activation, so developers can run the webview in dev mode without needing
 * to launch the extension in the debugger first.
 *
 * What it does:
 *   1. Installs the hook forwarding script at ~/.claude/agent-lens/hook.js
 *   2. Configures Claude Code hooks in <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json
 *
 * The hook script and discovery files always live under ~/.claude/agent-lens, whatever the
 * account: every account's settings.json points to that one stable hook.js.
 * A settings.json that cannot be parsed is never modified (see updateSettingsFile).
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-lens')
const HOOK_SCRIPT_PATH = path.join(DISCOVERY_DIR, 'hook.js')
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024

/** Claude Code's config root: CLAUDE_CONFIG_DIR when set, otherwise ~/.claude (mirrors extension/src/claude-config-dir.ts). */
function claudeConfigDir(env = process.env, home = os.homedir()) {
  const raw = (env.CLAUDE_CONFIG_DIR || '').trim()
  if (!raw) return path.join(home, '.claude')
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2))
  return path.resolve(raw)
}

function settingsPath() {
  return path.join(claudeConfigDir(), 'settings.json')
}

const HOOK_TIMEOUT_S = 2
const HOOK_SAFETY_MARGIN_MS = 500
const HOOK_FORWARD_TIMEOUT_MS = 1000
const HOOK_COMMAND_MARKER = 'agent-lens/hook.js'
const LEGACY_HOOK_COMMAND_MARKER = 'agent-flow/hook.js' // hooks installed under the former project name

// ─── Resolve node path ──────────────────────────────────────────────────────

function resolveNodePath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'command'
    const args = process.platform === 'win32' ? ['node'] : ['-v', 'node']
    const result = execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000 }).trim()
    const firstLine = result.split(/\r?\n/)[0].trim()
    if (firstLine) return firstLine
  } catch {}
  return 'node'
}

// ─── Hook script content (mirrors extension/src/discovery.ts) ───────────────

function getHookScriptContent() {
  return `#!/usr/bin/env node
// Agent Lens hook forwarder v3 — installed by the Agent Lens setup script.
// Claude Code invokes this as a command hook. It reads a discovery directory to
// find live extension instances, checks their PIDs, and forwards the event via
// HTTP POST. Dead instances are cleaned up automatically.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

setTimeout(() => process.exit(0), ${HOOK_TIMEOUT_S * 1000 - HOOK_SAFETY_MARGIN_MS});

const DIR = path.join(os.homedir(), '.claude', 'agent-lens');
const IS_WIN = process.platform === 'win32';

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

function isAlive(pid) {
  if (IS_WIN) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let cwd;
  try { cwd = JSON.parse(input).cwd; } catch { process.exit(0); }
  if (!cwd) process.exit(0);

  const resolvedCwd = normPath(cwd);

  let allFiles;
  try {
    allFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json');
  } catch { process.exit(0); }
  if (!allFiles.length) process.exit(0);

  const matches = [];
  for (const file of allFiles) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d.workspace || !d.pid || !d.port) continue;

    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }

    const ws = normPath(d.workspace);
    if (resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep)) {
      matches.push({ d, file, wsLen: ws.length });
    }
  }

  if (!matches.length) process.exit(0);

  // Most specific workspace first; instances of the same workspace form one tier.
  matches.sort((a, b) => b.wsLen - a.wsLen);
  const tiers = [];
  for (const m of matches) {
    const last = tiers[tiers.length - 1];
    if (last && last[0].wsLen === m.wsLen) last.push(m); else tiers.push([m]);
  }

  // Forward to the best tier. If every instance of it refuses the connection (stale discovery
  // file of a crashed instance), drop the file and fall back to the next, less specific tier.
  function sendTier(i) {
    if (i >= tiers.length) process.exit(0);
    const targets = tiers[i];
    let pending = targets.length;
    let reached = false;
    for (const { d, file } of targets) {
      let settled = false;
      const finish = (ok, refused) => {
        if (settled) return; settled = true;
        if (ok) reached = true;
        if (refused) { try { fs.unlinkSync(path.join(DIR, file)); } catch {} }
        if (--pending <= 0) { if (reached) process.exit(0); else sendTier(i + 1); }
      };
      const req = http.request({
        hostname: '127.0.0.1', port: d.port, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: ${HOOK_FORWARD_TIMEOUT_MS},
      }, res => { res.resume(); res.on('end', () => finish(true, false)); });
      // Only a refused connection proves the instance is gone; other errors may follow a delivery.
      req.on('error', e => finish(!(e && e.code === 'ECONNREFUSED'), !!(e && e.code === 'ECONNREFUSED')));
      req.on('timeout', () => { req.destroy(); });
      req.write(input);
      req.end();
    }
  }
  sendTier(0);
});
`
}

// ─── Install hook script ────────────────────────────────────────────────────

function ensureHookScript() {
  if (!fs.existsSync(DISCOVERY_DIR)) {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  }

  const script = getHookScriptContent()
  try {
    if (fs.existsSync(HOOK_SCRIPT_PATH) && fs.readFileSync(HOOK_SCRIPT_PATH, 'utf8') === script) {
      console.log('Hook script already up to date:', HOOK_SCRIPT_PATH)
      return
    }
  } catch {}

  const tmpPath = HOOK_SCRIPT_PATH + `.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, script, { mode: 0o755 })
  fs.renameSync(tmpPath, HOOK_SCRIPT_PATH)
  console.log('Installed hook script:', HOOK_SCRIPT_PATH)
}

// ─── Configure Claude Code hooks ────────────────────────────────────────────

function isAgentLensHook(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false
  return entry.hooks.some(h => {
    if (!h || typeof h !== 'object') return false
    const command = typeof h.command === 'string' ? h.command.replace(/\\/g, '/') : ''
    return command.includes(HOOK_COMMAND_MARKER) ||
      command.includes(LEGACY_HOOK_COMMAND_MARKER) ||
      (typeof h.url === 'string' && h.url.startsWith('http://127.0.0.1:'))
  })
}

// ─── Safe settings.json update (mirrors extension/src/settings-writer.ts) ───

class SettingsUnreadableError extends Error {
  constructor(filePath, reason) {
    super(`Cannot read ${filePath} (${reason}). Agent Lens will not modify it: fix or remove the file, then retry.`)
    this.name = 'SettingsUnreadableError'
    this.filePath = filePath
    this.reason = reason
  }
}

/** Parsed settings, or null when the file is missing. Throws SettingsUnreadableError otherwise. */
function readSettingsStrict(filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new SettingsUnreadableError(filePath, err.message)
  }
  if (!stat.isFile()) throw new SettingsUnreadableError(filePath, 'not a regular file')
  if (stat.size > SETTINGS_FILE_MAX_BYTES) throw new SettingsUnreadableError(filePath, 'file too large')
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

/** Apply mutate() to the settings and write atomically (tmp + rename), keeping a one-time .bak of the original. */
function updateSettingsFile(filePath, mutate) {
  const existing = readSettingsStrict(filePath)
  const settings = existing || {}
  const before = JSON.stringify(settings)
  mutate(settings)
  if (existing && JSON.stringify(settings) === before) return false

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (existing) {
    const backupPath = `${filePath}.bak`
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath)
  }
  const tmpPath = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch {}
    throw err
  }
  return true
}

function configureHooks(options = {}) {
  const target = options.settingsPath || settingsPath()
  const hookCommand = options.hookCommand || `"${resolveNodePath()}" "${HOOK_SCRIPT_PATH}"`
  const hookEntry = { hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S }] }

  const events = [
    'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd',
  ]

  updateSettingsFile(target, settings => {
    const existingHooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
    for (const event of events) {
      const existing = Array.isArray(existingHooks[event]) ? existingHooks[event] : []
      const filtered = existing.filter(entry => !isAgentLensHook(entry))
      existingHooks[event] = [...filtered, hookEntry]
    }
    settings.hooks = existingHooks
  })
  console.log('Configured Claude Code hooks in:', target)
}

// ─── Detection ──────────────────────────────────────────────────────────────

function isAlreadySetup() {
  // Check hook script exists
  if (!fs.existsSync(HOOK_SCRIPT_PATH)) return false

  // Check hooks are configured in settings.json
  try {
    const settings = readSettingsStrict(settingsPath())
    if (!settings) return false
    const hooks = settings.hooks
    if (!hooks || typeof hooks !== 'object') return false
    return Object.values(hooks).some(entries => {
      if (!Array.isArray(entries)) return false
      return entries.some(entry => isAgentLensHook(entry))
    })
  } catch {
    return false
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

/** Ensure hooks are configured, skip silently if already set up. */
function ensureSetup() {
  if (isAlreadySetup()) return
  console.log('Setting up agent hooks...')
  try {
    ensureHookScript()
    configureHooks()
  } catch (err) {
    if (!(err instanceof SettingsUnreadableError)) throw err
    // Never block the app on a settings file we refuse to touch; say so on every start.
    console.error(`Agent Lens hooks NOT configured: ${err.message}`)
  }
  console.log('')
}

module.exports = {
  ensureSetup, getHookScriptContent, isAlreadySetup, configureHooks, updateSettingsFile, readSettingsStrict,
  claudeConfigDir, SettingsUnreadableError,
}

// Run directly: node scripts/setup.js [--force]
if (require.main === module) {
  const force = process.argv.includes('--force')

  if (!force && isAlreadySetup()) {
    console.log('Agent Lens is already set up. Run with --force to reconfigure.')
    process.exit(0)
  }

  console.log('Setting up Agent Lens...\n')
  try {
    ensureHookScript()
    configureHooks()
  } catch (err) {
    if (!(err instanceof SettingsUnreadableError)) throw err
    console.error(`\nHooks NOT configured: ${err.message}`)
    process.exit(1)
  }
  console.log('\nDone! New sessions will stream events to Agent Lens.')
}
