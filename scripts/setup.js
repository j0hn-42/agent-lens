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
 *   3. Installs the status line wrapper at ~/.claude/agent-lens/statusline.js and points the settings.json
 *      `statusLine` at it, only on request: `--statusline` (shows before/after, asks y/N, `--yes` skips the question)
 *      and `--restore-statusline`. The wrapper runs the user's own status line unchanged (it is kept inside the
 *      wrapper command) and forwards the subscription quota (#467).
 *
 * The hook script and discovery files always live under ~/.claude/agent-lens, whatever the
 * account: every account's settings.json points to that one stable hook.js.
 * A settings.json that cannot be parsed is never modified (see updateSettings in extension/scripts/claude-hooks.js).
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const readline = require('readline')
const { execFileSync } = require('child_process')

// Hook detection, CLAUDE_CONFIG_DIR resolution and the safe settings.json write are shared with the
// extension and its uninstall script (one implementation, #217): only command markers count (#199),
// and legacy agent-flow hooks (LEGACY_HOOK_COMMAND_MARKER) are replaced but are not "set up" (#175).
const {
  HOOK_COMMAND_MARKER, LEGACY_HOOK_COMMAND_MARKER, isAgentLensHook, applyAgentLensHooks,
  settingsHaveAgentLensHooks, SettingsUnreadableError, readSettingsStrict, updateSettings,
  claudeConfigDir, recordSettingsPath, StatusLineOriginalError, isStatusLineWrapper, encodeStatusLineCommand,
  decodeStatusLineOriginal, restoreStatusLineInFile,
} = require('../extension/scripts/claude-hooks.js')

const { getStatuslineScriptContent } = require('./statusline-wrapper.js')

const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-lens')
const HOOK_SCRIPT_PATH = path.join(DISCOVERY_DIR, 'hook.js')
const STATUSLINE_SCRIPT_PATH = path.join(DISCOVERY_DIR, 'statusline.js')

function settingsPath() {
  return path.join(claudeConfigDir(), 'settings.json')
}

const HOOK_TIMEOUT_S = 2
const HOOK_SAFETY_MARGIN_MS = 500
const HOOK_FORWARD_TIMEOUT_MS = 1000

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

function configureHooks(options = {}) {
  const target = options.settingsPath || settingsPath()
  const hookCommand = options.hookCommand || `"${resolveNodePath()}" "${HOOK_SCRIPT_PATH}"`
  const hookEntry = { hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S }] }

  const events = [
    'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd',
  ]

  // Only Agent Lens hooks (current or legacy agent-flow) are replaced; the user's own hooks,
  // including sibling hooks of the same entry and http hooks to 127.0.0.1, are kept (#199).
  updateSettings(target, settings => {
    applyAgentLensHooks(settings, Object.fromEntries(events.map(event => [event, [hookEntry]])))
  })
  // Remember it so uninstalling the extension also cleans this account (#217); never fatal.
  try { recordSettingsPath(DISCOVERY_DIR, target) } catch {}
  console.log('Configured Claude Code hooks in:', target)
}

// ─── Status line wrapper (#467, opt-in: node scripts/setup.js --statusline) ──
// The user's own statusLine travels inside the wrapper command (see claude-hooks.js): no state outside settings.json.

function ensureStatuslineScript() {
  const script = getStatuslineScriptContent()
  try {
    if (fs.existsSync(STATUSLINE_SCRIPT_PATH) && fs.readFileSync(STATUSLINE_SCRIPT_PATH, 'utf8') === script) {
      console.log('Status line script already up to date:', STATUSLINE_SCRIPT_PATH)
      return
    }
  } catch {}
  if (!fs.existsSync(DISCOVERY_DIR)) fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  const tmpPath = STATUSLINE_SCRIPT_PATH + `.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, script, { mode: 0o755 })
  fs.renameSync(tmpPath, STATUSLINE_SCRIPT_PATH)
  console.log('Installed status line script:', STATUSLINE_SCRIPT_PATH)
}

function defaultStatuslineCommand() {
  return `"${resolveNodePath()}" "${STATUSLINE_SCRIPT_PATH}"`
}

/**
 * The statusLine to write for `current`, or null to leave it alone (not a command). An existing wrapper keeps the
 * original it already carries (never wrapped twice, the wrapper is never taken for the user's own bar).
 */
function planStatusLine(current, baseCommand) {
  if (isStatusLineWrapper(current)) {
    return { ...current, type: 'command', command: encodeStatusLineCommand(baseCommand, decodeStatusLineOriginal(current)) }
  }
  if (current === undefined || current === null) return { type: 'command', command: encodeStatusLineCommand(baseCommand, null) }
  if (typeof current !== 'object' || Array.isArray(current) || current.type !== 'command' || typeof current.command !== 'string') return null
  return { ...current, type: 'command', command: encodeStatusLineCommand(baseCommand, current) }
}

/** Points `statusLine` at the wrapper, keeping the user's own statusLine whole inside its command. */
function configureStatusLine(options = {}) {
  const target = options.settingsPath || settingsPath()
  const baseCommand = options.statuslineCommand || defaultStatuslineCommand()
  let skipped = false
  const changed = updateSettings(target, settings => {
    const next = planStatusLine(settings.statusLine, baseCommand)
    if (next) settings.statusLine = next
    else skipped = true
  })
  if (skipped) return console.log('Left the status line unchanged (not a command):', target)
  // Remember it so uninstalling the extension also restores this account; never fatal.
  try { recordSettingsPath(DISCOVERY_DIR, target) } catch {}
  console.log(changed ? 'Configured the Claude Code status line wrapper in:' : 'Status line wrapper already configured in:', target)
}

/**
 * Puts back exactly the original statusLine carried by the wrapper (or removes the key if there was none).
 * Throws on an unreadable settings.json or a corrupted argument, the file left untouched.
 */
function restoreStatusLine(options = {}) {
  const target = options.settingsPath || settingsPath()
  const restored = restoreStatusLineInFile(target)
  if (restored !== undefined) console.log('Restored the original status line in:', target)
}

const YES_ANSWER = /^(y|yes|o|oui)$/i

function askLine(stdin) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: stdin })
    let answered = false
    rl.once('line', line => { answered = true; rl.close(); resolve(line.trim()) })
    rl.once('close', () => { if (!answered) resolve('') })
  })
}

/** `--statusline` (before/after, confirmation, install) and `--restore-statusline`. Returns the exit code. */
async function runStatuslineCli({ argv, stdin, stdout, isTTY, settingsPath: forced }) {
  const out = text => stdout.write(text + '\n')
  const target = forced || settingsPath()
  try {
    if (argv.includes('--restore-statusline')) {
      const restored = restoreStatusLineInFile(target)
      if (restored === undefined) out(`Nothing to restore: the statusLine of ${target} is not the Agent Lens wrapper.`)
      else out(`Restored the original statusLine in ${target}: ${restored ? JSON.stringify(restored) : '(none, the key was removed)'}`)
      return 0
    }
    const settings = readSettingsStrict(target)
    const current = settings ? settings.statusLine : undefined
    const baseCommand = defaultStatuslineCommand()
    const next = planStatusLine(current, baseCommand)
    if (!next) { out(`The statusLine of ${target} is not a command: left unchanged.`); return 0 }
    out(`Settings file: ${target}`)
    out(`Current statusLine: ${current === undefined ? '(none)' : JSON.stringify(current)}`)
    out(`New statusLine:     ${JSON.stringify(next)}`)
    out('Your own status line keeps running unchanged inside it; undo with: node scripts/setup.js --restore-statusline')
    if (!argv.includes('--yes')) {
      if (!isTTY) { out('No terminal to confirm on: nothing changed. Run again with --yes to apply.'); return 1 }
      stdout.write('Apply? [y/N] ')
      if (!YES_ANSWER.test(await askLine(stdin))) { out('Nothing changed.'); return 0 }
    }
    ensureStatuslineScript()
    configureStatusLine({ settingsPath: target })
    return 0
  } catch (err) {
    if (!(err instanceof SettingsUnreadableError || err instanceof StatusLineOriginalError)) throw err
    out(`Status line NOT changed: ${err.message}`)
    return 1
  }
}


// ─── Detection ──────────────────────────────────────────────────────────────

function isAlreadySetup() {
  // Check hook script exists
  if (!fs.existsSync(HOOK_SCRIPT_PATH)) return false
  // An outdated hook.js (older release) must be redeployed: not "set up" until its content is current
  try {
    if (fs.readFileSync(HOOK_SCRIPT_PATH, 'utf8') !== getHookScriptContent()) return false
  } catch { return false }

  // Check current hooks are configured in settings.json (legacy agent-flow hooks do not count, #175)
  try {
    return settingsHaveAgentLensHooks(readSettingsStrict(settingsPath()))
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
  ensureSetup, getHookScriptContent, getStatuslineScriptContent, isAlreadySetup, configureHooks, configureStatusLine, restoreStatusLine, runStatuslineCli, updateSettingsFile: updateSettings, readSettingsStrict,
  claudeConfigDir, SettingsUnreadableError, isAgentLensHook, HOOK_COMMAND_MARKER, LEGACY_HOOK_COMMAND_MARKER,
}

// Run directly: node scripts/setup.js [--force] | --statusline [--yes] | --restore-statusline
if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.includes('--statusline') || args.includes('--restore-statusline')) {
    runStatuslineCli({ argv: args, stdin: process.stdin, stdout: process.stdout, isTTY: !!process.stdin.isTTY })
      .then(code => process.exit(code))
  } else main()
}

function main() {
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
  console.log('Optional: show your subscription quota. Run with --statusline (undo with --restore-statusline).')
}
