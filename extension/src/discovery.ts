/**
 * Discovery-file-based service discovery for hook forwarding.
 *
 * Each VS Code instance writes a discovery file containing its hook server
 * port and PID. The hook forwarding script reads these at invocation time
 * to find live instances — no port numbers in settings.json, no races.
 *
 * Discovery dir: ~/.claude/agent-lens/
 * Discovery file: {workspace-hash}-{pid}.json
 * Hook script:   ~/.claude/agent-lens/hook.js
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execSync } from 'child_process'
import {
  HOOK_TIMEOUT_S, HOOK_SAFETY_MARGIN_MS, HOOK_FORWARD_TIMEOUT_MS, WORKSPACE_HASH_LENGTH,
  PERMISSION_HOOK_TIMEOUT_S, PERMISSION_MESSAGE_MAX, HOOK_CONTROL_TOKEN_HEADER, HOOK_CONTROL_CHALLENGE_HEADER, HOOK_CONTROL_PROOF_HEADER,
} from './constants'
import { discoveryDir } from './claude-config-dir'
import { createLogger } from './logger'

const log = createLogger('Discovery')

const DISCOVERY_DIR = discoveryDir()
const HOOK_SCRIPT_PATH = path.join(DISCOVERY_DIR, 'hook.js')
const PERMISSION_HOOK_SCRIPT_PATH = path.join(DISCOVERY_DIR, 'permission-hook.js')
const WORKSPACES_MANIFEST_PATH = path.join(DISCOVERY_DIR, 'workspaces.json')

/** Command markers of our hooks (agent-lens/hook.js) and of those installed under the project's former
 *  name (agent-flow/hook.js, replaced on activation); defined once in ../scripts/claude-hooks.js. */
export { HOOK_COMMAND_MARKER, LEGACY_HOOK_COMMAND_MARKER } from '../scripts/claude-hooks'

/** Resolve the absolute path to the `node` binary.
 *  VS Code's extension host runs in Electron, so process.execPath is not node.
 *  We shell out to `command -v node` (POSIX) or `where node` (Windows) using
 *  the VS Code environment's PATH which typically has node available. */
let cachedNodePath: string | null = null
function resolveNodePath(): string {
  if (cachedNodePath) return cachedNodePath
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'command -v node'
    const result = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim()
    // `where` on Windows may return multiple lines — use the first
    const firstLine = result.split(/\r?\n/)[0].trim()
    if (firstLine) {
      cachedNodePath = firstLine
      log.info(`Resolved node path: ${cachedNodePath}`)
      return cachedNodePath
    }
  } catch (err) {
    log.debug('Failed to resolve absolute node path, falling back to bare "node":', err)
  }
  cachedNodePath = 'node'
  return cachedNodePath
}

export function getHookCommand(): string {
  const nodePath = resolveNodePath()
  return `"${nodePath}" "${HOOK_SCRIPT_PATH}"`
}

/** Resolve and normalize a path, following symlinks where possible. */
function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch { /* use path.resolve result if realpathSync fails */ }
  return resolved
}

export function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

// ─── Discovery Files ──────────────────────────────────────────────────────────

/** Length of the control token: 32 random bytes, hex encoded */
export const CONTROL_TOKEN_HEX_LENGTH = 64

/**
 * Publishes this instance for the hook scripts. The file is owner-only. `token` is written only while the operator
 * control is on (#240): without it permission-hook.js never connects to this instance.
 */
export function writeDiscoveryFile(port: number, workspace: string, token?: string): void {
  ensureDir()
  const hash = hashWorkspace(workspace)
  const filePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  const content = JSON.stringify({
    port,
    pid: process.pid,
    workspace: normalizePath(workspace),
    ...(token ? { token } : {}),
  }, null, 2) + '\n'
  // A new owner-only file renamed over the old one: the token is never in a file that already existed with wider
  // rights (the create mode only applies to a new file), and a hook reading meanwhile sees the old or the new file, whole.
  const tmpPath = `${filePath}.${process.pid}.tmp`
  try { fs.unlinkSync(tmpPath) } catch { /* nothing left over */ }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(tmpPath, flags, 0o600)
  try {
    fs.writeSync(fd, content)
  } catch (err) {
    fs.closeSync(fd)
    try { fs.unlinkSync(tmpPath) } catch { /* best effort */ }
    throw err
  }
  fs.closeSync(fd)
  try { fs.chmodSync(tmpPath, 0o600) } catch { /* the create mode went through the umask: best effort on exotic file systems */ }
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* best effort */ }
    throw err
  }
  log.info(`Wrote ${filePath}`)
}

export function removeDiscoveryFile(workspace: string): void {
  const hash = hashWorkspace(workspace)
  const filePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  try {
    fs.unlinkSync(filePath)
    log.info(`Removed ${filePath}`)
  } catch { /* expected if file was already removed */ }
}

// ─── Workspace Manifest ──────────────────────────────────────────────────────
// Tracks every workspace where hooks have been written to settings.local.json.
// Survives crashes and discovery-file cleanup — the uninstall script reads this
// to find all project-level settings files that need cleaning.

export function addWorkspaceToManifest(workspace: string): void {
  ensureDir()
  const resolved = normalizePath(workspace)
  const workspaces = readManifest()
  if (workspaces.includes(resolved)) { return }
  workspaces.push(resolved)
  fs.writeFileSync(WORKSPACES_MANIFEST_PATH, JSON.stringify(workspaces, null, 2) + '\n')
}

function readManifest(): string[] {
  try {
    if (!fs.existsSync(WORKSPACES_MANIFEST_PATH)) { return [] }
    const data = JSON.parse(fs.readFileSync(WORKSPACES_MANIFEST_PATH, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch (err) {
    log.debug('Failed to read workspaces manifest:', err)
    return []
  }
}

// ─── Hook Script ──────────────────────────────────────────────────────────────

export function ensureHookScript(): void {
  ensureDir()
  const script = getHookScriptContent()
  try {
    if (fs.existsSync(HOOK_SCRIPT_PATH) && fs.readFileSync(HOOK_SCRIPT_PATH, 'utf8') === script) {
      return // already up to date
    }
  } catch { /* failed to read existing script — rewrite it */ }
  // Atomic write: write to temp file then rename, so a concurrent
  // `node hook.js` never reads a truncated/empty file during updates.
  const tmpPath = HOOK_SCRIPT_PATH + `.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, script, { mode: 0o755 })
  fs.renameSync(tmpPath, HOOK_SCRIPT_PATH)
  log.info(`Installed hook script → ${HOOK_SCRIPT_PATH}`)
}

export function ensurePermissionHookScript(): void {
  ensureDir()
  const script = getPermissionHookScriptContent()
  try {
    if (fs.existsSync(PERMISSION_HOOK_SCRIPT_PATH) && fs.readFileSync(PERMISSION_HOOK_SCRIPT_PATH, 'utf8') === script) { return }
  } catch { /* failed to read existing script: rewrite it */ }
  const tmpPath = PERMISSION_HOOK_SCRIPT_PATH + `.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, script, { mode: 0o755 })
  fs.renameSync(tmpPath, PERMISSION_HOOK_SCRIPT_PATH)
  log.info(`Installed permission hook script → ${PERMISSION_HOOK_SCRIPT_PATH}`)
}

export function getPermissionHookCommand(): string {
  return `"${resolveNodePath()}" "${PERMISSION_HOOK_SCRIPT_PATH}"`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(DISCOVERY_DIR)) {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  }
}

export function getHookScriptContent(): string {
  return `#!/usr/bin/env node
// Agent Lens hook forwarder v3 — installed by the Agent Lens VS Code extension.
// Claude Code invokes this as a command hook. It reads a discovery directory to
// find live extension instances, checks their PIDs, and forwards the event via
// HTTP POST. Dead instances are cleaned up automatically.
//
// v4: falls back to the next workspace match when the best one refuses the connection.
// v3: containment-based workspace matching (supports subdirectory CWD),
//     realpathSync normalization (handles symlinks), Windows-safe PID checks.
//
// Discovery dir: ~/.claude/agent-lens/
// Discovery file: {workspace-hash}-{pid}.json  →  { port, pid, workspace }
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// Hard safety deadline — guarantees exit well before Claude Code's
// ${HOOK_TIMEOUT_S}s kill timeout (500ms margin). Prevents ANY hanging scenario
// (stdin stall, HTTP hang, unexpected blocking) from blocking Claude Code.
setTimeout(() => process.exit(0), ${HOOK_TIMEOUT_S * 1000 - HOOK_SAFETY_MARGIN_MS});

const DIR = path.join(os.homedir(), '.claude', 'agent-lens');
const IS_WIN = process.platform === 'win32';

/** Normalize a path: resolve and follow symlinks where possible */
function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

/** Check if a process is alive. On Windows, process.kill(pid, 0) is unreliable
 *  (can throw even for live processes), so we skip the check: stale files are purged
 *  by the extension/relay at startup, and a refused connection below falls back to the
 *  next-best workspace match. */
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

  // Read all discovery files
  let allFiles;
  try {
    allFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json');
  } catch { process.exit(0); }
  if (!allFiles.length) process.exit(0);

  // Parse discovery files and find workspaces that contain this cwd.
  // Use longest-match-wins so /project/sub matches before /project.
  const matches = [];
  for (const file of allFiles) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d.workspace || !d.pid || !d.port) continue;

    // Clean up dead instances (skip on Windows where PID check is unreliable)
    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }

    // Containment check: is cwd equal to or under this workspace?
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

/**
 * The command of the optional PermissionRequest hook (#240). Unlike hook.js it waits: it forwards the request to the
 * Agent Lens instance of the session's workspace and prints the decision it gets back. It prints something only for an
 * answer of the exact shape `{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"|"deny"}}}`,
 * re-built field by field; every other outcome (no instance, no token, refusal, odd answer, timeout) prints nothing and
 * exits 0, so Claude Code shows its own prompt. It never produces an allow by itself.
 */
export function getPermissionHookScriptContent(): string {
  const deadlineMs = PERMISSION_HOOK_TIMEOUT_S * 1000 - HOOK_SAFETY_MARGIN_MS
  return `#!/usr/bin/env node
// Agent Lens permission hook (operator control) — installed by the Agent Lens VS Code extension.
// Claude Code runs it for PermissionRequest events when the operator control is installed. It forwards the request to the
// Agent Lens instance that owns the session's workspace and prints the decision it receives. Anything else prints nothing
// and exits 0: Claude Code then asks as usual. It never decides by itself.
//
// Discovery dir: ~/.claude/agent-lens/  (only instances that published a token are used)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// Hard deadline before the kill timeout of ${PERMISSION_HOOK_TIMEOUT_S}s. The environment can only shorten it (tests).
const DEADLINE_MS = Math.min(${deadlineMs}, Number(process.env.AGENT_LENS_PERMISSION_DEADLINE_MS) || ${deadlineMs});
setTimeout(() => process.exit(0), DEADLINE_MS);

const DIR = path.join(os.homedir(), '.claude', 'agent-lens');
const IS_WIN = process.platform === 'win32';
const TOKEN_RE = /^[0-9a-f]{${CONTROL_TOKEN_HEX_LENGTH}}$/;
const MAX_ANSWER_BYTES = 65536;

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

function isAlive(pid) {
  if (IS_WIN) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * True when the answer carries the proof that its sender knows the token: HMAC-SHA256(token, challenge, sha256(body),
 * decision), compared in constant time. A process that only listens on the port of a stale discovery file cannot make it.
 */
function proven(token, challenge, body, decision, header) {
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header)) return false;
  const bodySha = crypto.createHash('sha256').update(body).digest('hex');
  const expected = crypto.createHmac('sha256', token).update(challenge + '\\n' + bodySha + '\\n' + JSON.stringify(decision)).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

/** The decision to print, rebuilt from the answer, or null when the answer is not exactly a decision. */
function decisionOf(text) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  const out = o && typeof o === 'object' ? o.hookSpecificOutput : null;
  if (!out || typeof out !== 'object' || out.hookEventName !== 'PermissionRequest') return null;
  const d = out.decision;
  if (!d || typeof d !== 'object') return null;
  if (d.behavior === 'allow') return { behavior: 'allow' };
  if (d.behavior === 'deny' && typeof d.message === 'string') return { behavior: 'deny', message: d.message.slice(0, ${PERMISSION_MESSAGE_MAX}) };
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let cwd;
  try { cwd = JSON.parse(input).cwd; } catch { process.exit(0); }
  if (typeof cwd !== 'string' || !cwd) process.exit(0);
  const resolvedCwd = normPath(cwd);

  let files;
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json'); } catch { process.exit(0); }

  const candidates = [];
  for (const file of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d || !d.workspace || !d.pid || !d.port) continue;
    if (typeof d.token !== 'string' || !TOKEN_RE.test(d.token)) continue; // control off for that instance
    if (!isAlive(d.pid)) { try { fs.unlinkSync(path.join(DIR, file)); } catch {} continue; }
    const ws = normPath(d.workspace);
    if (resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep)) candidates.push({ d, file, wsLen: ws.length });
  }
  candidates.sort((a, b) => b.wsLen - a.wsLen);

  // The most specific workspace first. Only a refused connection (a stale file) moves on to the next instance:
  // the first instance that answers, with a decision or not, is the one that owns the session.
  function tryNext(i) {
    if (i >= candidates.length) process.exit(0);
    const { d, file } = candidates[i];
    const body = Buffer.from(input);
    const challenge = crypto.randomBytes(16).toString('hex');
    const req = http.request({
      hostname: '127.0.0.1', port: d.port, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, '${HOOK_CONTROL_TOKEN_HEADER}': d.token, '${HOOK_CONTROL_CHALLENGE_HEADER}': challenge },
    }, res => {
      let text = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', c => { size += c.length; if (size <= MAX_ANSWER_BYTES) text += c; });
      res.on('end', () => {
        const decision = res.statusCode === 200 && size <= MAX_ANSWER_BYTES ? decisionOf(text) : null;
        if (decision && proven(d.token, challenge, body, decision, res.headers['${HOOK_CONTROL_PROOF_HEADER}'])) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }), () => process.exit(0));
        else process.exit(0);
      });
    });
    req.on('error', e => {
      if (e && e.code === 'ECONNREFUSED') { try { fs.unlinkSync(path.join(DIR, file)); } catch {} tryNext(i + 1); }
      else process.exit(0);
    });
    req.end(body);
  }
  tryNext(0);
});
`
}
