/**
 * PermissionRequest over the hook server (#240, PR 3). Real HTTP on 127.0.0.1, ephemeral port.
 * The response of Claude Code's hook is held until the gate decides; every other case answers 200 with no body,
 * which Claude Code reads as "no decision" (its own prompt is shown).
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-perm-home-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

import type { PermissionRequestView } from '../src/permission-gate'
import type { DecisionRecord } from '../src/decision-journal'

type HookServerCtor = typeof import('../src/hook-server').HookServer
type GateCtor = typeof import('../src/permission-gate').PermissionGate
let HookServer: HookServerCtor
let PermissionGate: GateCtor
let sha256Json: typeof import('../src/permission-gate').sha256Json

const TOKEN = 't'.repeat(64)
const HEADER = 'x-agent-lens-token'

interface Reply { status: number; body: string }
function post(port: number, payload: unknown, headers: http.OutgoingHttpHeaders = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 5))
}

async function setup(over: { enabled?: boolean; surface?: boolean; ttlMs?: number; token?: string | null } = {}) {
  const records: DecisionRecord[] = []
  const shown: PermissionRequestView[] = []
  const gate = new PermissionGate({
    enabled: () => over.enabled ?? true,
    canDecide: () => over.surface ?? true,
    journal: { append: r => { records.push(r); return true } },
    ttlMs: over.ttlMs ?? 5000,
  })
  gate.onRequest(v => shown.push(v))
  const server = new HookServer(undefined, undefined, over.token === null ? undefined : { gate, token: over.token ?? TOKEN })
  const port = await server.start()
  return { server, port, gate, records, shown }
}

const permReq = (over: Record<string, unknown> = {}) => ({
  session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/tmp', ...over,
})
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

describe('HookServer PermissionRequest', () => {
  before(async () => {
    ({ HookServer } = await import('../src/hook-server'))
    ;({ PermissionGate, sha256Json } = await import('../src/permission-gate'))
  })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('without the operator control configured: an empty 200 at once, nothing held', async () => {
    const { server, port } = await setup({ token: null })
    try {
      const r = await post(port, permReq(), { [HEADER]: TOKEN })
      assert.deepEqual(r, { status: 200, body: '' })
    } finally { server.dispose() }
  })

  it('control switched off: an empty 200 at once', async () => {
    const { server, port, shown } = await setup({ enabled: false })
    try {
      assert.deepEqual(await post(port, permReq(), { [HEADER]: TOKEN }), { status: 200, body: '' })
      assert.equal(shown.length, 0)
    } finally { server.dispose() }
  })

  it('a missing or wrong token is refused (403) and nothing reaches the panel', async () => {
    const { server, port, shown } = await setup()
    try {
      for (const headers of [{}, { [HEADER]: 'nope' }, { [HEADER]: TOKEN.slice(1) }, { [HEADER]: `${TOKEN}x` }]) {
        const r = await post(port, permReq(), headers)
        assert.equal(r.status, 403, JSON.stringify(headers))
        assert.equal(r.body.includes('behavior'), false)
      }
      assert.equal(shown.length, 0)
    } finally { server.dispose() }
  })

  it('a browser request (Origin header) is refused even with the token', async () => {
    const { server, port, shown } = await setup()
    try {
      const r = await post(port, permReq(), { [HEADER]: TOKEN, Origin: 'https://evil.example' })
      assert.equal(r.status, 403)
      assert.equal(shown.length, 0)
    } finally { server.dispose() }
  })

  it('holds the response until the panel decides, then answers with the PermissionRequest decision schema', async () => {
    const { server, port, gate, shown, records } = await setup()
    try {
      const reply = post(port, permReq(), { [HEADER]: TOKEN })
      await waitFor(() => shown.length === 1)
      assert.equal(shown[0].toolName, 'Bash')
      assert.equal(shown[0].inputSha256, sha256Json({ command: 'npm test' }))
      assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: null, nonce: shown[0].nonce, action: 'approve' }), { ok: true })
      assert.deepEqual(await reply, { status: 200, body: ALLOW })
      assert.equal(records.at(-1)?.outcome, 'sent')
    } finally { server.dispose() }
  })

  it('a redirect or a denial is a deny with its message', async () => {
    const { server, port, gate, shown } = await setup()
    try {
      const reply = post(port, permReq(), { [HEADER]: TOKEN })
      await waitFor(() => shown.length === 1)
      gate.decide({ sessionId: 's1', toolUseId: null, nonce: shown[0].nonce, action: 'redirect', message: 'use pnpm' })
      const r = await reply
      assert.equal(r.status, 200)
      assert.deepEqual(JSON.parse(r.body), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'use pnpm' } } })
    } finally { server.dispose() }
  })

  it('no decision before the expiry: an empty 200, so Claude Code asks as usual', async () => {
    const { server, port, records } = await setup({ ttlMs: 30 })
    try {
      assert.deepEqual(await post(port, permReq(), { [HEADER]: TOKEN }), { status: 200, body: '' })
      assert.equal(records.at(-1)?.outcome, 'expired')
    } finally { server.dispose() }
  })

  it('no panel able to decide: an empty 200 at once instead of keeping Claude Code waiting', async () => {
    const { server, port, shown } = await setup({ surface: false })
    try {
      assert.deepEqual(await post(port, permReq(), { [HEADER]: TOKEN }), { status: 200, body: '' })
      assert.equal(shown.length, 0)
    } finally { server.dispose() }
  })

  it('the hook gives up (answered in the terminal): the request is closed and journalled', async () => {
    const { server, port, gate, shown, records } = await setup()
    try {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false, headers: { 'Content-Type': 'application/json', [HEADER]: TOKEN } })
      req.on('error', () => {})
      req.end(JSON.stringify(permReq()))
      await waitFor(() => shown.length === 1)
      req.destroy()
      await waitFor(() => gate.pending().length === 0)
      assert.equal(records.at(-1)?.outcome, 'answered-elsewhere')
      assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: null, nonce: shown[0].nonce, action: 'approve' }), { ok: false, reason: 'closed' })
    } finally { server.dispose() }
  })

  it('a malformed request (no tool name or input) gets no decision', async () => {
    const { server, port, shown } = await setup()
    try {
      assert.deepEqual(await post(port, permReq({ tool_name: undefined }), { [HEADER]: TOKEN }), { status: 200, body: '' })
      assert.deepEqual(await post(port, permReq({ tool_input: undefined }), { [HEADER]: TOKEN }), { status: 200, body: '' })
      assert.equal(shown.length, 0)
    } finally { server.dispose() }
  })

  it('does not feed the observation stream: no event is emitted for a permission request', async () => {
    const { server, port, shown } = await setup({ ttlMs: 20 })
    const events: unknown[] = []
    server.onEvent(e => events.push(e))
    try {
      await post(port, permReq(), { [HEADER]: TOKEN })
      assert.equal(shown.length, 1)
      assert.equal(events.length, 0)
    } finally { server.dispose() }
  })

  describe('tool_use_id (the PermissionRequest input has none)', () => {
    const pre = (id: string, over: Record<string, unknown> = {}) =>
      ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: id, ...over })

    async function viewFor(prior: unknown[]): Promise<PermissionRequestView> {
      const { server, port, shown } = await setup({ ttlMs: 30 })
      try {
        for (const p of prior) await post(port, p)
        await post(port, permReq(), { [HEADER]: TOKEN })
        return shown[0]
      } finally { server.dispose() }
    }

    it('is taken from the one open call of that session with the same tool and the same input', async () => {
      assert.equal((await viewFor([pre('toolu_A'), pre('toolu_B', { tool_input: { command: 'ls' } })])).toolUseId, 'toolu_A')
    })
    it('is null when two open calls match, when none does, or when the call already ended', async () => {
      assert.equal((await viewFor([pre('toolu_A'), pre('toolu_B')])).toolUseId, null)
      assert.equal((await viewFor([])).toolUseId, null)
      assert.equal((await viewFor([pre('toolu_A', { session_id: 'other' })])).toolUseId, null)
      assert.equal((await viewFor([pre('toolu_A', { tool_name: 'Edit' })])).toolUseId, null)
      const post1 = { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_A', tool_response: 'ok' }
      assert.equal((await viewFor([pre('toolu_A'), post1])).toolUseId, null)
    })
  })
})
