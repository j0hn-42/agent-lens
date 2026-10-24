/**
 * Cursor hook payloads must never become a Claude Code session (#472, PR 1 of the protection).
 *
 * The DOC_EXAMPLES payloads are EXAMPLES FROM THE DOCUMENTATION, NOT REAL CAPTURES (« exemple de la doc, pas une
 * capture réelle »); the few inline payloads are hand-made variants, marked as such. The common fields and the
 * per-event fields are copied from https://cursor.com/docs/hooks ("Common schema" and "Hook events",
 * read on 2026-10-19). What Cursor really sends, from the IDE and from cursor-agent, is still to be
 * recorded on a real machine (step 0 of #472). Real HTTP over 127.0.0.1 on an ephemeral port.
 */
import './helpers/alias-vscode'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isCursorHookPayload } from '../src/hook-guards'
import { HOOK_RATE_IP_BURST } from '../src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cursor-hook-home-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

/** Common fields of every Cursor hook input (doc example, not a real capture). */
const COMMON = {
  conversation_id: 'conv-456',
  generation_id: 'gen-1',
  model: 'claude-opus-4-7-thinking-max',
  cursor_version: '1.7.2',
  workspace_roots: ['/project'],
  user_email: null,
  transcript_path: null,
}

/** Doc examples, not real captures. */
const DOC_EXAMPLES: Record<string, Record<string, unknown>> = {
  preToolUse: {
    ...COMMON, hook_event_name: 'preToolUse',
    tool_name: 'Shell', tool_input: { command: 'npm install', working_directory: '/project' }, tool_use_id: 'abc123', cwd: '/project',
  },
  postToolUse: {
    ...COMMON, hook_event_name: 'postToolUse',
    tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_output: '{"exitCode":0,"stdout":"All tests passed"}',
    tool_use_id: 'abc123', cwd: '/project', duration: 5432,
  },
  subagentStart: {
    ...COMMON, hook_event_name: 'subagentStart',
    subagent_id: 'abc-123', subagent_type: 'generalPurpose', task: 'Explore the authentication flow',
    parent_conversation_id: 'conv-456', tool_call_id: 'tc-789', subagent_model: 'claude-sonnet-4-20250514', is_parallel_worker: false,
  },
  // sessionStart is the one documented event that carries a session_id: it passes the Claude Code validator today.
  sessionStart: { ...COMMON, hook_event_name: 'sessionStart', session_id: 'conv-456', is_background_agent: false, composer_mode: 'agent' },
  // App lifecycle hook: no conversation_id, only hook_event_name, cursor_version, workspace_roots, user_email.
  workspaceOpen: { hook_event_name: 'workspaceOpen', cursor_version: '1.7.2', workspace_roots: ['/project'], user_email: null },
}

describe('isCursorHookPayload (documented markers)', () => {
  it('recognises every doc example', () => {
    for (const [name, p] of Object.entries(DOC_EXAMPLES)) assert.equal(isCursorHookPayload(p), true, name)
  })

  // Hand-made: the input of third-party hooks (~/.claude/settings.json run by Cursor) is not documented.
  it('recognises cursor_version on a Claude-shaped payload (third-party hooks: payload shape not documented)', () => {
    assert.equal(isCursorHookPayload({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', cursor_version: '1.7.2' }), true)
  })

  it('recognises a documented camelCase Cursor event name even without cursor_version', () => {
    assert.equal(isCursorHookPayload({ conversation_id: 'c', hook_event_name: 'beforeShellExecution' }), true)
    assert.equal(isCursorHookPayload({ conversation_id: 'c', hook_event_name: 'afterFileEdit' }), true)
  })

  it('leaves Claude Code payloads alone', () => {
    for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd', 'PermissionRequest']) {
      assert.equal(isCursorHookPayload({ session_id: 's1', hook_event_name: name }), false, name)
    }
  })

  it('needs a string cursor_version and an exact event name', () => {
    assert.equal(isCursorHookPayload({ session_id: 's1', hook_event_name: 'PreToolUse', cursor_version: 1 }), false)
    assert.equal(isCursorHookPayload({ session_id: 's1', hook_event_name: 'PreToolUse', cursor_version: '' }), false)
    assert.equal(isCursorHookPayload({ session_id: 's1', hook_event_name: 'pretooluse' }), false)
    for (const v of [null, undefined, 'x', 1, [], [{ cursor_version: '1' }]]) assert.equal(isCursorHookPayload(v), false, String(v))
  })
})

function post(port: number, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

describe('HookServer ignores Cursor payloads', () => {
  let HookServer: typeof import('../src/hook-server').HookServer
  before(async () => { ({ HookServer } = await import('../src/hook-server')) })

  async function start() {
    const server = new HookServer()
    const port = await server.start()
    const events: Array<{ type: string; sessionId?: string }> = []
    server.onEvent(e => events.push(e as never))
    return { server, port, events }
  }

  it('answers 200 with no body, emits nothing, counts each payload as Cursor, not as malformed', async () => {
    const { server, port, events } = await start()
    try {
      const examples = Object.values(DOC_EXAMPLES)
      for (const p of examples) {
        const r = await post(port, p)
        assert.equal(r.status, 200)
        assert.equal(r.body, '')
      }
      // A Claude-shaped payload that carries cursor_version (third-party hooks) is ignored too.
      const r = await post(port, { session_id: 'cursor-sess', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1', cwd: '/project', cursor_version: '1.7.2' })
      assert.equal(r.status, 200)
      await new Promise(res => setTimeout(res, 50))
      assert.deepEqual(events, [], 'no agent, no tool call, no session from Cursor')
      assert.deepEqual(server.getForeignHookStats(), { cursor: examples.length + 1 })
      assert.equal(server.getNormalizationStats().malformed, 0)
      assert.equal(server.getNormalizationStats('conv-456').malformed, 0)
      assert.equal(server.getNormalizationStats('cursor-sess').malformed, 0)
      const state = (server as unknown as { sessionState: Map<string, unknown> }).sessionState
      assert.equal(state.size, 0, 'no session state created')
    } finally { server.dispose() }
  })

  it('logs one line per server instance, with no field of the payload (#613)', async () => {
    const lines: string[] = []
    const saved = { log: console.log, warn: console.warn, error: console.error }
    const capture = (...args: unknown[]) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) }
    console.log = capture; console.warn = capture; console.error = capture
    // Hand-made variant of the doc example: an e-mail and values that must not reach the log
    const secret = { ...DOC_EXAMPLES.preToolUse, user_email: 'someone@example.invalid', conversation_id: 'conv-secret-id', tool_input: { command: 'cat secret-file' } }
    try {
      for (let round = 0; round < 2; round++) {
        const { server, port } = await start()
        try {
          for (let i = 0; i < 3; i++) assert.equal((await post(port, secret)).status, 200)
        } finally { server.dispose() }
      }
    } finally { Object.assign(console, saved) }
    const cursorLines = lines.filter(l => /Cursor/.test(l))
    assert.equal(cursorLines.length, 2, `one line per instance (got ${JSON.stringify(cursorLines)})`)
    for (const l of lines) {
      for (const value of ['someone@example.invalid', 'conv-secret-id', 'cat secret-file', 'gen-1', '/project']) {
        assert.ok(!l.includes(value), `the log holds a payload field (${value}): ${l}`)
      }
    }
  })

  it('a Cursor flood is still held by the per-IP limiter (before the body is read); never by the malformed counters (#613)', async () => {
    const { server, port } = await start()
    // The limiter refills from Date.now(): on a loaded machine the 800 requests could take longer than the refill of
    // 600 tokens (6 s) and none would be refused (proven by advancing the clock 1 s per call: no 429). The clock is
    // frozen during the flood, so exactly the burst gets through, whatever the load (#613)
    const frozen = Date.now()
    const clock = mock.method(Date, 'now', () => frozen)
    try {
      // In batches of 25 connections, past the burst (200)
      const statuses: number[] = []
      for (let batch = 0; batch < 32; batch++) {
        statuses.push(...await Promise.all(Array.from({ length: 25 }, () => post(port, DOC_EXAMPLES.preToolUse).then(r => r.status))))
      }
      const ok = statuses.filter(st => st === 200).length
      const limited = statuses.filter(st => st === 429).length
      assert.equal(ok + limited, statuses.length, `only 200 and 429 (got ${[...new Set(statuses)].join(', ')})`)
      assert.equal(ok, HOOK_RATE_IP_BURST, 'exactly the burst gets through')
      assert.equal(limited, statuses.length - HOOK_RATE_IP_BURST, 'the per-IP limiter answers 429 past its burst')
      assert.deepEqual(server.getForeignHookStats(), { cursor: ok }, 'only the payloads that got through are counted')
      assert.equal(server.getNormalizationStats().malformed, 0)
    } finally { clock.mock.restore(); server.dispose() }
  })

  it('still handles Claude Code payloads after Cursor ones', async () => {
    const { server, port, events } = await start()
    try {
      await post(port, DOC_EXAMPLES.preToolUse)
      await post(port, { session_id: 'claude-1', hook_event_name: 'SessionStart' })
      await new Promise(res => setTimeout(res, 50))
      assert.equal(events.length, 1)
      assert.equal(events[0].type, 'agent_spawn')
      assert.equal(events[0].sessionId, 'claude-1')
      assert.deepEqual(server.getForeignHookStats(), { cursor: 1 })
    } finally { server.dispose() }
  })
})
