/**
 * Contenu du script de barre d'état installé en ~/.claude/agent-lens/statusline.js (#467).
 *
 * Claude Code l'exécute comme commande `statusLine`. Il enveloppe la commande d'origine de l'utilisateur (enregistrée
 * dans statusline-original.json) sans rien changer à son affichage, et transmet en parallèle le seul `rate_limits`
 * au relais. La barre de l'utilisateur prime : l'envoi est secondaire, borné à 300 ms, et toute erreur est avalée.
 */
'use strict'

const STATUSLINE_SEND_TIMEOUT_MS = 300

function getStatuslineScriptContent() {
  return `#!/usr/bin/env node
// Agent Lens status line wrapper v1 — installed by the Agent Lens setup script.
// Claude Code runs this as its statusLine command. It runs the user's original command with the same stdin and
// the same output, and forwards only rate_limits to the live Agent Lens instance (same discovery as hook.js).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(os.homedir(), '.claude', 'agent-lens');
const IS_WIN = process.platform === 'win32';
const SEND_TIMEOUT_MS = ${STATUSLINE_SEND_TIMEOUT_MS};
const WINDOWS = ['five_hour', 'seven_day'];

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

function isAlive(pid) {
  if (IS_WIN) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Only the two windows and their two numeric fields leave this machine's loopback: never session_id, cwd, model.
function quotaBody(data) {
  const rl = data && data.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const out = {};
  for (const name of WINDOWS) {
    const w = rl[name];
    if (!w || typeof w !== 'object') continue;
    const entry = {};
    if (typeof w.used_percentage === 'number') entry.used_percentage = w.used_percentage;
    if (typeof w.resets_at === 'number') entry.resets_at = w.resets_at;
    if (Object.keys(entry).length) out[name] = entry;
  }
  return Object.keys(out).length ? JSON.stringify({ rate_limits: out }) : null;
}

// Same instance files, PID checks and workspace tiers as hook.js. The quota belongs to the account, not to a
// workspace: when no workspace matches the cwd, every live instance is one tier.
function targetTiers(cwd) {
  let files;
  try {
    files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json' && f !== 'statusline-original.json');
  } catch { return []; }
  const live = [];
  for (const file of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d.workspace || !d.pid || !d.port) continue;
    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }
    live.push({ d, file, ws: normPath(d.workspace) });
  }
  if (!live.length) return [];
  const resolvedCwd = typeof cwd === 'string' && cwd ? normPath(cwd) : null;
  const matches = resolvedCwd ? live.filter(m => resolvedCwd === m.ws || resolvedCwd.startsWith(m.ws + path.sep)) : [];
  if (!matches.length) return [live];
  matches.sort((a, b) => b.ws.length - a.ws.length);
  const tiers = [];
  for (const m of matches) {
    const last = tiers[tiers.length - 1];
    if (last && last[0].ws.length === m.ws.length) last.push(m); else tiers.push([m]);
  }
  return tiers;
}

// Hard deadline for the whole forward: whatever happens, done() is called within SEND_TIMEOUT_MS.
function sendQuota(body, cwd, done) {
  let over = false;
  const finish = () => { if (!over) { over = true; done(); } };
  setTimeout(finish, SEND_TIMEOUT_MS);
  const tiers = targetTiers(cwd);
  function sendTier(i) {
    if (over) return;
    if (i >= tiers.length) return finish();
    let pending = tiers[i].length;
    let reached = false;
    for (const { d, file } of tiers[i]) {
      let settled = false;
      const end = (ok, refused) => {
        if (settled) return; settled = true;
        if (ok) reached = true;
        if (refused) { try { fs.unlinkSync(path.join(DIR, file)); } catch {} }
        if (--pending <= 0) { if (reached) finish(); else sendTier(i + 1); }
      };
      try {
        const req = http.request({
          hostname: '127.0.0.1', port: d.port, path: '/quota', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: SEND_TIMEOUT_MS,
        }, res => { res.resume(); res.on('end', () => end(true, false)); res.on('error', () => end(true, false)); });
        req.on('error', e => end(!(e && e.code === 'ECONNREFUSED'), !!(e && e.code === 'ECONNREFUSED')));
        req.on('timeout', () => req.destroy());
        req.end(body);
      } catch { end(false, false); }
    }
  }
  sendTier(0);
}

// The original statusLine travels in the command itself: the one argument is base64url JSON of the whole object
// (or null when the user had none). Returns { command } (null = nothing to run) or { bad: true }.
function originalCommand() {
  try {
    const arg = process.argv[2];
    if (typeof arg !== 'string' || !/^[A-Za-z0-9_-]+$/.test(arg)) return { bad: true };
    const o = JSON.parse(Buffer.from(arg, 'base64url').toString('utf8'));
    if (o === null) return { command: null };
    if (typeof o !== 'object' || Array.isArray(o)) return { bad: true };
    return { command: typeof o.command === 'string' && o.command.trim() ? o.command : null };
  } catch { return { bad: true }; }
}

// Same shell as Claude Code: Git Bash when installed, else PowerShell on Windows (documented); on Unix the
// docs only say "a shell", so the user's $SHELL when it is bash or zsh, else bash, else /bin/sh.
function shellInvocation(command) {
  if (IS_WIN) {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
    for (const base of bases) {
      if (!base) continue;
      const bash = path.join(base, 'Git', 'bin', 'bash.exe');
      if (fs.existsSync(bash)) return { file: bash, args: ['-c', command] };
    }
    return { file: 'powershell', args: ['-NoProfile', '-Command', command] };
  }
  // Only bash and zsh are followed: other shells (fish, tcsh, nu) break valid POSIX commands under -c.
  const candidates = [];
  const sh = process.env.SHELL;
  if (sh && path.isAbsolute(sh) && /^(bash|zsh)$/.test(path.basename(sh))) candidates.push(sh);
  candidates.push('/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash');
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); return { file, args: ['-c', command] }; } catch {}
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

function warn(message) {
  try { process.stderr.write('Agent Lens: ' + message + '\\n'); } catch {}
}

const chunks = [];
let started = false;
process.stdin.on('data', c => { chunks.push(c); });
process.stdin.on('end', run);
process.stdin.on('error', run);

function run() {
  if (started) return; started = true;
  // Recursion guard: the original command (or something it runs) led back here. Run nothing.
  if (process.env.AGENT_LENS_STATUSLINE) { warn('statusLine d\\'Agent Lens appelée en boucle, commande d\\'origine non lancée'); process.exit(0); }
  const input = Buffer.concat(chunks);
  let childDone = false;
  let sendDone = false;
  let exitCode = 0;
  const maybeExit = () => { if (childDone && sendDone) process.exit(exitCode); };

  let data = null;
  try { data = JSON.parse(input.toString('utf8')); } catch {}
  const body = quotaBody(data);
  if (body) {
    const cwd = data.cwd || (data.workspace && data.workspace.current_dir);
    try { sendQuota(body, cwd, () => { sendDone = true; maybeExit(); }); } catch { sendDone = true; }
  } else sendDone = true;

  const original = originalCommand();
  if (original.bad) warn('the original statusLine could not be read; edit the "statusLine" entry of your Claude settings.json by hand');
  const command = original.command;
  if (!command) { childDone = true; return maybeExit(); }
  let child;
  try {
    const sh = shellInvocation(command);
    child = spawn(sh.file, sh.args, { stdio: ['pipe', 'inherit', 'inherit'], env: Object.assign({}, process.env, { AGENT_LENS_STATUSLINE: '1' }) });
  } catch { childDone = true; exitCode = 127; return maybeExit(); }
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
  child.on('error', () => { childDone = true; exitCode = 127; maybeExit(); });
  child.on('close', (code, signal) => {
    exitCode = signal ? 128 + (os.constants.signals[signal] || 0) : (code == null ? 0 : code);
    childDone = true;
    maybeExit();
  });
}
`
}

module.exports = { getStatuslineScriptContent, STATUSLINE_SEND_TIMEOUT_MS }
