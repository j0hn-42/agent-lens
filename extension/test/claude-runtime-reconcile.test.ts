/**
 * VS Code path of issue #53, through the REAL entry point startClaudeRuntime: a real HookServer on an
 * ephemeral port, a real SessionWatcher tailing a transcript, a fake panel. A tool call reported by
 * both sources reaches the panel once, whichever source is first; a hook-only call is kept.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-runtime-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const SESSION = '55555555-5555-4555-8555-555555555555'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type AnyEvent = { type: string; payload: Record<string, unknown>; sessionId?: string }
const received: AnyEvent[] = []
let transcript = ''
let hookPort = 0
let runtime: { dispose(): void } | null = null
let VisualizerPanel: { getCurrent: () => unknown }
let originalGetCurrent: () => unknown

function postHook(payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1', port: hookPort, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(body)
  })
}
const toolUse = (id: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
const hook = (id: string) => ({ session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'ls' } })
const starts = (id: string) => received.filter(e => e.type === 'tool_call_start' && e.payload.toolUseId === id)

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(25)
}

describe('startClaudeRuntime: hooks and transcript reconciled', () => {
  before(async () => {
    const cwd = fs.realpathSync(process.cwd())
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    transcript = path.join(projectDir, `${SESSION}.jsonl`)
    fs.writeFileSync(transcript, line({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the build' } }))

    // The shim has no status bar: stub what wireWatcherToPanel calls when a session is detected
    const vscodeShim = require('vscode') as { window: Record<string, unknown> }
    vscodeShim.window.setStatusBarMessage = () => ({ dispose() {} })

    ;({ VisualizerPanel } = await import('../src/webview-provider') as unknown as { VisualizerPanel: { getCurrent: () => unknown } })
    originalGetCurrent = VisualizerPanel.getCurrent
    const panel = {
      isReady: true,
      sendEvent: (e: AnyEvent) => { received.push(e) },
      setConnectionStatus: () => {},
      postMessage: () => {},
    }
    VisualizerPanel.getCurrent = () => panel
    const { startClaudeRuntime } = await import('../src/claude-runtime')
    runtime = await startClaudeRuntime({ subscriptions: [] } as never)
    const discoveryDir = path.join(fakeHome, '.claude', 'agent-lens')
    const file = fs.readdirSync(discoveryDir).find(f => f.endsWith('.json'))!
    hookPort = JSON.parse(fs.readFileSync(path.join(discoveryDir, file), 'utf8')).port
    await waitFor(() => received.some(e => e.type === "agent_spawn"))
    assert.ok(received.some(e => e.type === 'agent_spawn'), 'precondition: the watcher picked the session up')
  })

  after(() => {
    VisualizerPanel.getCurrent = originalGetCurrent
    runtime?.dispose()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('transcript first, then the hook: the call reaches the panel once', async () => {
    fs.appendFileSync(transcript, toolUse('tu-jsonl-first'))
    await waitFor(() => starts('tu-jsonl-first').length > 0)
    assert.equal(starts('tu-jsonl-first').length, 1, 'precondition: the transcript copy arrived')
    assert.equal(await postHook(hook('tu-jsonl-first')), 200)
    // Proving a non-occurrence: a later, distinct hook is processed after the duplicate, so once it has arrived
    // the duplicate has had its chance to reach the panel.
    assert.equal(await postHook(hook('tu-jsonl-first-sentinel')), 200)
    await waitFor(() => starts('tu-jsonl-first-sentinel').length > 0)
    assert.equal(starts('tu-jsonl-first-sentinel').length, 1, 'precondition: the hook pipeline went past the duplicate')
    assert.equal(starts('tu-jsonl-first').length, 1, 'the hook copy was dropped')
  })

  it('hook first, then the transcript: the call reaches the panel once', async () => {
    assert.equal(await postHook(hook('tu-hook-first')), 200)
    await waitFor(() => starts('tu-hook-first').length > 0)
    assert.equal(starts('tu-hook-first').length, 1, 'precondition: the hook copy arrived')
    // The duplicate and a sentinel are appended together: lines are read in order, so the sentinel's arrival
    // means the duplicate was read (no fixed wait on fs.watch / the poll fallback).
    fs.appendFileSync(transcript, toolUse('tu-hook-first') + toolUse('tu-hook-first-sentinel'))
    await waitFor(() => starts('tu-hook-first-sentinel').length > 0)
    assert.equal(starts('tu-hook-first-sentinel').length, 1, 'precondition: the transcript was read past the duplicate')
    assert.equal(starts('tu-hook-first').length, 1, 'the transcript copy was dropped')
  })

  it('a call only reported by a hook is kept', async () => {
    assert.equal(await postHook(hook('tu-hook-only')), 200)
    await waitFor(() => starts('tu-hook-only').length > 0)
    assert.equal(starts('tu-hook-only').length, 1)
  })

  // Same-source repeats are real activity and are kept by design, so a duplicate cannot reveal a bypass:
  // we observe instead that the hook is submitted to the watcher's reconciler (not sent straight to the panel).
  function spySubmit(): { calls: AnyEvent[]; restore: () => void } {
    const { SessionWatcher } = require('../src/session-watcher') as { SessionWatcher: { prototype: { submitHookEvent: (e: AnyEvent) => void } } }
    const original = SessionWatcher.prototype.submitHookEvent
    const calls: AnyEvent[] = []
    SessionWatcher.prototype.submitHookEvent = function (this: unknown, e: AnyEvent) { calls.push(e); return original.call(this, e) }
    return { calls, restore: () => { SessionWatcher.prototype.submitHookEvent = original } }
  }

  it('a subagent tool event (watched session) is submitted to the reconciler, not sent straight to the panel', async () => {
    assert.equal(await postHook({ session_id: SESSION, hook_event_name: 'SubagentStart', agent_id: 'sub-runtime-1', agent_type: 'Explore' }), 200)
    const spy = spySubmit()
    try {
      assert.equal(await postHook({ ...hook('tu-sub-reconciled'), agent_id: 'sub-runtime-1', agent_type: 'Explore' }), 200)
      await waitFor(() => starts('tu-sub-reconciled').length > 0)
      assert.equal(starts('tu-sub-reconciled').length, 1, 'the subagent call reached the panel')
      assert.notEqual(starts('tu-sub-reconciled')[0].payload.agent ?? starts('tu-sub-reconciled')[0].payload.name, 'orchestrator', 'subagent branch, not the orchestrator one')
      assert.equal(spy.calls.filter(e => e.type === 'tool_call_start' && e.payload.toolUseId === 'tu-sub-reconciled').length, 1, 'went through watcher.submitHookEvent')
    } finally { spy.restore() }
  })

  it('a hook for a session the watcher does NOT own is also submitted to the reconciler', async () => {
    const OTHER = '66666666-6666-4666-8666-666666666666'
    const spy = spySubmit()
    try {
      assert.equal(await postHook({ session_id: OTHER, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-unwatched', tool_input: { command: 'ls' } }), 200)
      await waitFor(() => starts('tu-unwatched').length > 0)
      assert.equal(starts('tu-unwatched').length, 1, 'a hook-only session still reaches the panel')
      assert.equal(spy.calls.filter(e => e.sessionId === OTHER && e.type === 'tool_call_start').length, 1, 'went through watcher.submitHookEvent')
    } finally { spy.restore() }
  })
})
