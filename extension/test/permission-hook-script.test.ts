/**
 * permission-hook.js (#240, PR 3): the command Claude Code runs for the optional PermissionRequest hook. It only prints
 * a decision it received, validated, from an Agent Lens instance that published a token; in every other case it prints
 * nothing and exits 0, which leaves Claude Code's own prompt in charge. It never invents an allow.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { PERMISSION_HOOK_TIMEOUT_S, HOOK_SAFETY_MARGIN_MS } from '../src/constants'

// discovery.ts fixes its folder from the home directory when it is loaded: point it at a throwaway one first
const loadHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-permhook-load-'))
process.env.HOME = loadHome
process.env.USERPROFILE = loadHome
delete process.env.CLAUDE_CONFIG_DIR
let getPermissionHookScriptContent: typeof import('../src/discovery').getPermissionHookScriptContent
let writeDiscoveryFile: typeof import('../src/discovery').writeDiscoveryFile

const TOKEN = 'a'.repeat(64)
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }

let root: string
let home: string
let ws: string
let script: string

interface Seen { headers: http.IncomingHttpHeaders; body: string }

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { const s = { headers: req.headers, body }; seen.push(s); handler(req, res, s) })
    })
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as net.AddressInfo).port, seen,
      close: () => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()) }),
    }))
  })
}

function writeDiscovery(port: number, over: Record<string, unknown> = {}, name = 'a-1.json'): void {
  const dir = path.join(home, '.claude', 'agent-lens')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ port, pid: process.pid, workspace: ws, token: TOKEN, ...over }))
}

function run(input: unknown, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', c => { stdout += c })
    child.on('exit', code => resolve({ code, stdout }))
    child.on('error', reject)
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}

/** The answer proof, computed here from the documented formula (not from src): HMAC-SHA256(token, challenge \n sha256(body) \n decision) */
function proofFor(seen: Seen, decision: { behavior: string; message?: string }, token = TOKEN): string {
  const challenge = String(seen.headers['x-agent-lens-challenge'])
  const bodySha = createHash('sha256').update(seen.body).digest('hex')
  return createHmac('sha256', token).update(`${challenge}\n${bodySha}\n${JSON.stringify(decision)}`).digest('hex')
}

/** Answers like a genuine instance: the decision plus the proof the hook asks for */
function answer(res: http.ServerResponse, seen: Seen, body: unknown): void {
  const d = (body as { hookSpecificOutput?: { decision?: { behavior: string; message?: string } } }).hookSpecificOutput?.decision
  res.writeHead(200, { 'Content-Type': 'application/json', ...(d ? { 'X-Agent-Lens-Proof': proofFor(seen, d) } : {}) })
  res.end(JSON.stringify(body))
}

const payload = () => ({ session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: ws })

describe('permission-hook.js', () => {
  before(async () => {
    ;({ getPermissionHookScriptContent, writeDiscoveryFile } = await import('../src/discovery'))
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-permhook-'))
    ws = path.join(root, 'proj')
    fs.mkdirSync(ws)
    script = path.join(root, 'permission-hook.js')
    fs.writeFileSync(script, getPermissionHookScriptContent())
  })
  after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(loadHome, { recursive: true, force: true }) })
  const fresh = () => { home = fs.mkdtempSync(path.join(root, 'home-')) }

  it('its own deadline is before the one Claude Code enforces', () => {
    const content = getPermissionHookScriptContent()
    assert.ok(content.includes(String(PERMISSION_HOOK_TIMEOUT_S * 1000 - HOOK_SAFETY_MARGIN_MS)))
  })

  it('forwards the event with the token and prints the decision it gets back', async () => {
    fresh()
    const srv = await startServer((_q, res, seen) => answer(res, seen, ALLOW))
    try {
      writeDiscovery(srv.port)
      const out = await run(payload())
      assert.equal(out.code, 0)
      assert.deepEqual(JSON.parse(out.stdout), ALLOW)
      assert.equal(srv.seen[0].headers['x-agent-lens-token'], TOKEN)
      assert.equal(srv.seen[0].headers['content-type'], 'application/json')
      assert.equal(JSON.parse(srv.seen[0].body).tool_name, 'Bash')
    } finally { await srv.close() }
  })

  it('prints a deny with its message, and nothing else from the answer', async () => {
    fresh()
    const extra = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'use pnpm', updatedInput: { command: 'rm -rf /' }, interrupt: true } }, continue: false }
    const srv = await startServer((_q, res, seen) => {
      res.writeHead(200, { 'X-Agent-Lens-Proof': proofFor(seen, { behavior: 'deny', message: 'use pnpm' }) })
      res.end(JSON.stringify(extra))
    })
    try {
      writeDiscovery(srv.port)
      const out = await run(payload())
      assert.deepEqual(JSON.parse(out.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'use pnpm' } } })
    } finally { await srv.close() }
  })

  it('sends a fresh random challenge with each request', async () => {
    fresh()
    const srv = await startServer((_q, res, seen) => answer(res, seen, ALLOW))
    try {
      writeDiscovery(srv.port)
      await run(payload())
      await run(payload())
      const [a, b] = srv.seen.map(s => String(s.headers['x-agent-lens-challenge']))
      assert.match(a, /^[0-9a-f]{32}$/)
      assert.match(b, /^[0-9a-f]{32}$/)
      assert.notEqual(a, b)
    } finally { await srv.close() }
  })

  // The hook proves itself to the server with the token; the server must prove itself to the hook, or whoever listens
  // on the port of a stale discovery file (VS Code crashed, pid reused) could approve any tool call.
  it('prints nothing when an allow comes without a valid proof that the answering process knows the token', async () => {
    const denyMsg = { behavior: 'deny', message: 'use pnpm' }
    const cases: Array<[string, (seen: Seen) => Record<string, string>, unknown]> = [
      ['no proof', () => ({}), ALLOW],
      ['empty proof', () => ({ 'X-Agent-Lens-Proof': '' }), ALLOW],
      ['garbage proof', () => ({ 'X-Agent-Lens-Proof': 'zz' }), ALLOW],
      ['wrong length proof', () => ({ 'X-Agent-Lens-Proof': '00' }), ALLOW],
      ['proof made with another token', s => ({ 'X-Agent-Lens-Proof': proofFor(s, { behavior: 'allow' }, 'b'.repeat(64)) }), ALLOW],
      ['proof of another decision', s => ({ 'X-Agent-Lens-Proof': proofFor(s, denyMsg) }), ALLOW],
      ['proof of a replayed challenge', s => ({ 'X-Agent-Lens-Proof': proofFor({ ...s, headers: { ...s.headers, 'x-agent-lens-challenge': 'c'.repeat(32) } }, { behavior: 'allow' }) }), ALLOW],
      ['proof of another request body', s => ({ 'X-Agent-Lens-Proof': proofFor({ ...s, body: s.body + ' ' }, { behavior: 'allow' }) }), ALLOW],
      ['proof of the allow, message changed', s => ({ 'X-Agent-Lens-Proof': proofFor(s, denyMsg) }),
        { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'other' } } }],
    ]
    for (const [name, headers, body] of cases) {
      fresh()
      const srv = await startServer((_q, res, seen) => { res.writeHead(200, headers(seen)); res.end(JSON.stringify(body)) })
      try {
        writeDiscovery(srv.port)
        const out = await run(payload())
        assert.deepEqual({ code: out.code, stdout: out.stdout }, { code: 0, stdout: '' }, name)
        assert.equal(srv.seen.length, 1, `${name}: the hook did contact it`)
      } finally { await srv.close() }
    }
  })

  it('prints nothing for a fake server that was never given the token and answers allow to anything', async () => {
    fresh()
    const srv = await startServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ALLOW)) })
    try {
      writeDiscovery(srv.port)
      const out = await run(payload())
      assert.deepEqual({ code: out.code, stdout: out.stdout }, { code: 0, stdout: '' })
    } finally { await srv.close() }
  })

  it('prints nothing when the instance has no decision (empty 200), refuses (403) or answers anything odd', async () => {
    const answers: Array<[number, string]> = [
      [200, ''], [403, 'Forbidden'], [500, JSON.stringify(ALLOW)], [200, 'not json'], [200, '{}'], [200, '[]'],
      [200, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })],
      [200, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'ask' } } })],
      [200, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow ' } } })],
      [200, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 7 } } })],
      [200, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest' } })],
      [200, JSON.stringify({ decision: { behavior: 'allow' } })],
    ]
    for (const [status, body] of answers) {
      fresh()
      const srv = await startServer((_q, res) => { res.writeHead(status); res.end(body) })
      try {
        writeDiscovery(srv.port)
        const out = await run(payload())
        assert.deepEqual({ code: out.code, stdout: out.stdout }, { code: 0, stdout: '' }, `${status} ${body}`)
      } finally { await srv.close() }
    }
  })

  it('does not even connect to an instance that published no token (control off)', async () => {
    fresh()
    const srv = await startServer((_q, res) => { res.writeHead(200); res.end(JSON.stringify(ALLOW)) })
    try {
      writeDiscovery(srv.port, { token: undefined })
      const out = await run(payload())
      assert.deepEqual({ code: out.code, stdout: out.stdout }, { code: 0, stdout: '' })
      assert.equal(srv.seen.length, 0)
      writeDiscovery(srv.port, { token: 'short' })
      assert.equal((await run(payload())).stdout, '')
      assert.equal(srv.seen.length, 0, 'a token that is not 64 hex-like characters is not used')
    } finally { await srv.close() }
  })

  it('prints nothing outside any known workspace, on bad input, and when the instance is gone', async () => {
    fresh()
    const srv = await startServer((_q, res) => { res.writeHead(200); res.end(JSON.stringify(ALLOW)) })
    try {
      writeDiscovery(srv.port)
      assert.equal((await run({ ...payload(), cwd: path.join(root, 'elsewhere') })).stdout, '')
      assert.equal((await run('not json')).stdout, '')
      assert.equal((await run({ session_id: 's' })).stdout, '')
      assert.equal(srv.seen.length, 0)
    } finally { await srv.close() }
    const closed = await startServer(() => {})
    const gonePort = closed.port
    await closed.close()
    writeDiscovery(gonePort)
    const out = await run(payload())
    assert.deepEqual({ code: out.code, stdout: out.stdout }, { code: 0, stdout: '' })
  })

  it('falls back to the next instance when the best one is stale, and stops at the first that answers', async () => {
    fresh()
    const live = await startServer((_q, res, seen) => answer(res, seen, ALLOW))
    const dead = await startServer(() => {})
    const deadPort = dead.port
    await dead.close()
    const sub = path.join(ws, 'sub')
    fs.mkdirSync(sub)
    try {
      writeDiscovery(deadPort, { workspace: sub }, 'b-2.json')
      writeDiscovery(live.port, { workspace: ws }, 'a-1.json')
      const out = await run({ ...payload(), cwd: sub })
      assert.deepEqual(JSON.parse(out.stdout), ALLOW)
      assert.equal(live.seen.length, 1)
    } finally { await live.close() }
  })

  it('gives up with no output at its own deadline when the instance never answers', async () => {
    fresh()
    const srv = await startServer(() => { /* never answers */ })
    try {
      writeDiscovery(srv.port)
      const t0 = Date.now()
      const out = await run(payload(), { AGENT_LENS_PERMISSION_DEADLINE_MS: '300' })
      assert.deepEqual({ code: out.code, stdout: out.stdout }, { code: 0, stdout: '' })
      assert.ok(Date.now() - t0 < 5000)
    } finally { await srv.close() }
  })

  it('the deadline override can only shorten the wait', () => {
    assert.match(getPermissionHookScriptContent(), /Math\.min\(/)
  })
})

describe('writeDiscoveryFile with a token', () => {
  it('stores the token in a file only its owner can read, and none when control is off', { skip: process.platform === 'win32' }, () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-permhook-ws-'))
    const dir = path.join(loadHome, '.claude', 'agent-lens')
    try {
      writeDiscoveryFile(4242, wsDir)
      const [plain] = fs.readdirSync(dir)
      assert.equal('token' in JSON.parse(fs.readFileSync(path.join(dir, plain), 'utf8')), false)
      writeDiscoveryFile(4242, wsDir, TOKEN)
      const file = path.join(dir, plain)
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, TOKEN)
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    } finally { fs.rmSync(wsDir, { recursive: true, force: true }) }
  })
})
