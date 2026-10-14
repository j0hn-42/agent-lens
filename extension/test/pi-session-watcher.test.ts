/**
 * PiSessionWatcher (#238) : découverte des sessions Pi sous ~/.pi/agent/sessions (racine surchargée
 * par PI_CODING_AGENT_DIR ou PI_CODING_AGENT_SESSION_DIR), filtre sur le cwd de l'en-tête, lecture
 * des entrées et reprise à chaud.
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PiSessionWatcher, piSessionsRoot, readPiSessionHeader, piSessionIdFromFile } from '../src/pi-session-watcher'
import type { AgentEvent } from '../src/protocol'
import { INACTIVITY_TIMEOUT_MS } from '../src/constants'
import type { SessionLifecycleEvent } from '../src/session-runtime'

const uuid = (n: number) => `0192f0a1-7c2e-7000-8000-${String(n).padStart(12, '0')}`
const fileName = (n: number) => `2026-10-12T09-00-00-000Z_${uuid(n)}.jsonl`
const header = (cwd: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: '2026-01-05T09:00:00.000Z', cwd, ...over }) + '\n'
const user = (id: string, content: string) =>
  JSON.stringify({ type: 'message', id, parentId: null, timestamp: '2026-10-12T09:00:01.000Z', message: { role: 'user', content, timestamp: 1 } }) + '\n'

const ENV_KEYS = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'] as const

describe('piSessionsRoot', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  it('defaults to ~/.pi/agent/sessions', () => {
    assert.equal(piSessionsRoot(), path.join(os.homedir(), '.pi', 'agent', 'sessions'))
  })

  it('follows PI_CODING_AGENT_DIR, then PI_CODING_AGENT_SESSION_DIR, expanding ~', () => {
    process.env.PI_CODING_AGENT_DIR = '/opt/pi'
    assert.equal(piSessionsRoot(), path.join('/opt/pi', 'sessions'))
    process.env.PI_CODING_AGENT_SESSION_DIR = '~/pi-sessions'
    assert.equal(piSessionsRoot(), path.join(os.homedir(), 'pi-sessions'))
  })
})

describe('piSessionIdFromFile', () => {
  it('takes the id after the timestamp, and refuses an unsafe one', () => {
    assert.equal(piSessionIdFromFile(fileName(1)), uuid(1))
    assert.equal(piSessionIdFromFile('2026-10-12T09-00-00-000Z_my-custom_id.jsonl'), 'my-custom_id')
    assert.equal(piSessionIdFromFile('2026_my.dotted.jsonl'), null, 'the observations id pattern refuses dots')
    assert.equal(piSessionIdFromFile('notes.txt'), null)
    assert.equal(piSessionIdFromFile('2026_-bad-.jsonl'), null)
    assert.equal(piSessionIdFromFile(`2026_${'a'.repeat(200)}.jsonl`), null)
  })
})

describe('readPiSessionHeader', () => {
  let dir = ''
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pi-hdr-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('reads the cwd of a session header', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, header('/w/app') + user('u1', 'hi'))
    assert.deepEqual(readPiSessionHeader(f), { cwd: '/w/app', final: true, startMs: Date.parse('2026-01-05T09:00:00.000Z') })
  })

  it('refuses a relative cwd, or one with control or bidi characters', () => {
    const f = path.join(dir, 'a.jsonl')
    for (const cwd of ['relative/dir', '/w/a\u0007b', '/w/\u202eevil']) {
      fs.writeFileSync(f, header(cwd))
      assert.equal(readPiSessionHeader(f).cwd, null, cwd)
    }
  })

  it('returns no cwd when the first line is not a session header', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, user('u1', 'hi'))
    assert.equal(readPiSessionHeader(f).cwd, null)
  })

  it('gives up on a first line larger than the cap', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, JSON.stringify({ type: 'session', version: 3, cwd: '/w', pad: 'x'.repeat(80 * 1024) }) + '\n')
    assert.deepEqual(readPiSessionHeader(f), { cwd: null, final: true })
  })

  it('refuses a header whose version is unknown', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, header('/w', { version: 4 }))
    assert.deepEqual(readPiSessionHeader(f), { cwd: null, final: true, unsupported: true })
  })

  it('is not final while the header line is still being written', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, '{"type":"session","ver')
    assert.deepEqual(readPiSessionHeader(f), { cwd: null, final: false })
  })
})

describe('PiSessionWatcher', () => {
  let agentDir = ''
  let ws = ''
  const saved: Record<string, string | undefined> = {}
  let watcher: PiSessionWatcher | null = null

  const sessionsDir = () => path.join(agentDir, 'sessions')
  const addSession = (n: number, cwd: string, body = '', sub = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`) => {
    const dir = path.join(sessionsDir(), sub)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, fileName(n))
    fs.writeFileSync(file, header(cwd) + body)
    return file
  }

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pi-home-'))
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-pi-proj-')))
    fs.mkdirSync(sessionsDir(), { recursive: true })
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
    process.env.PI_CODING_AGENT_DIR = agentDir
  })
  afterEach(() => {
    watcher?.dispose()
    watcher = null
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    fs.rmSync(agentDir, { recursive: true, force: true })
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('attaches the sessions whose header cwd is the workspace (or inside it), not the others', () => {
    addSession(1, ws)
    addSession(2, path.join(ws, 'sub'))
    addSession(3, '/nowhere/else')
    // The directory name is not trusted: only the header cwd decides
    addSession(4, '/nowhere/else', '', `--${ws.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
    watcher = new PiSessionWatcher(ws)
    watcher.start()
    assert.deepEqual(watcher.getActiveSessions().map(s => s.id).sort(), [uuid(1), uuid(2)])
  })

  // #360: a silence is not an end. No agent_complete, no 'ended': the session stays active, in its last known state
  it('a silent session stays active: no agent_complete, no ended', () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() })
    try {
      addSession(1, ws)
      watcher = new PiSessionWatcher(ws)
      const types: string[] = []
      const lifecycle: string[] = []
      watcher.onEvent(e => { types.push(e.type) })
      watcher.onSessionLifecycle(e => { lifecycle.push(e.type) })
      watcher.start()
      mock.timers.tick(INACTIVITY_TIMEOUT_MS + 60_000)
      assert.ok(!types.includes('agent_complete'), types.join(','))
      assert.ok(!lifecycle.includes('ended'), lifecycle.join(','))
      assert.deepEqual(watcher.getActiveSessions().map(s => s.status), ['active'])
    } finally { mock.timers.reset() }
  })

  it('attaches every session when no workspace is given', () => {
    addSession(1, '/a')
    addSession(2, '/b')
    watcher = new PiSessionWatcher(null)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 2)
  })

  it('skips a stale file, a file without a session header, an unsafe name and other files', () => {
    const stale = addSession(1, ws)
    const old = new Date(Date.now() - 3600_000)
    fs.utimesSync(stale, old, old)
    const dir = path.dirname(stale)
    fs.writeFileSync(path.join(dir, fileName(2)), user('u1', 'no header'))
    fs.writeFileSync(path.join(dir, '2026_-bad-.jsonl'), header(ws))
    fs.writeFileSync(path.join(dir, 'notes.txt'), header(ws))
    watcher = new PiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
  })

  it('does nothing when the Pi directory does not exist', () => {
    fs.rmSync(sessionsDir(), { recursive: true })
    watcher = new PiSessionWatcher(ws)
    assert.doesNotThrow(() => watcher!.start())
    assert.equal(watcher.isActive(), false)
  })

  it('reads a flat PI_CODING_AGENT_SESSION_DIR (files directly in it)', () => {
    const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pi-flat-'))
    try {
      fs.writeFileSync(path.join(flat, fileName(7)), header(ws))
      process.env.PI_CODING_AGENT_SESSION_DIR = flat
      watcher = new PiSessionWatcher(ws)
      watcher.start()
      assert.deepEqual(watcher.getActiveSessions().map(s => s.id), [uuid(7)])
    } finally { fs.rmSync(flat, { recursive: true, force: true }) }
  })

  it('tags sessions and lifecycle events as pi, with the cwd', () => {
    addSession(1, ws)
    watcher = new PiSessionWatcher(ws)
    const lifecycle: SessionLifecycleEvent[] = []
    watcher.onSessionLifecycle(l => lifecycle.push(l))
    watcher.start()
    const [info] = watcher.getActiveSessions()
    assert.equal(info.runtime, 'pi')
    assert.equal(info.cwd, ws)
    assert.equal(info.label, `Pi ${uuid(1).slice(0, 8)}`)
    assert.equal(lifecycle.length, 1, 'attaching announces the session once')
    watcher.replaySessionStart()
    assert.equal(lifecycle.length, 2, 'a replay announces it again')
    for (const l of lifecycle) {
      assert.equal(l.type, 'started')
      assert.equal(l.runtime, 'pi')
      assert.equal(l.cwd, ws)
    }
  })

  it('shows nothing for a session whose header version is unknown', () => {
    const dir = path.join(sessionsDir(), '--x--')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, fileName(1)), header(ws, { version: 99 }) + user('u1', 'hello'))
    watcher = new PiSessionWatcher(ws)
    const events: AgentEvent[] = []
    watcher.onEvent(e => events.push(e))
    watcher.start()
    assert.equal(events.filter(e => e.type === 'message').length, 0)
    assert.equal(events.filter(e => e.type === 'agent_spawn').length, 0)
    assert.equal(watcher.getActiveSessions().length, 0, 'not even listed')
  })

  it('reads the history at attach time and follows new lines, reassembling a split line', async () => {
    const file = addSession(1, ws, user('u1', 'Fix the bug'))
    watcher = new PiSessionWatcher(ws)
    const events: AgentEvent[] = []
    const relabels: string[] = []
    watcher.onEvent(e => events.push(e))
    watcher.onSessionLifecycle(l => { if (l.type === 'updated') relabels.push(l.label) })
    watcher.start()

    assert.ok(events.some(e => e.type === 'agent_spawn' && e.sessionId === uuid(1)))
    assert.ok(events.some(e => e.type === 'message' && e.payload.content === 'Fix the bug'))
    assert.deepEqual(relabels, ['Fix the bug'])

    const next = JSON.stringify({ type: 'message', id: 'a2', parentId: 'u1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }], model: 'm', timestamp: 2 } }) + '\n'
    fs.appendFileSync(file, next.slice(0, 20))
    fs.appendFileSync(file, next.slice(20))
    const deadline = Date.now() + 5000
    while (!events.some(e => e.payload.content === 'On it.') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(events.some(e => e.type === 'message' && e.payload.content === 'On it.'), 'the appended line is delivered once complete')
  })

  it('starts the session at the header timestamp', () => {
    addSession(1, ws)
    watcher = new PiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions()[0].startTime, Date.parse('2026-01-05T09:00:00.000Z'))
  })

  it('does not follow a symbolic link to a session file', () => {
    const real = addSession(1, ws)
    const dir = path.dirname(real)
    fs.renameSync(real, path.join(agentDir, 'outside.jsonl'))
    fs.symlinkSync(path.join(agentDir, 'outside.jsonl'), path.join(dir, fileName(2)))
    watcher = new PiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
  })

  it('watches at most 25 sessions', () => {
    for (let n = 1; n <= 30; n++) addSession(n, ws)
    watcher = new PiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 25)
  })

  it('survives a listener that throws: no uncaught exception, the session stays watched', async () => {
    const file = addSession(1, ws)
    watcher = new PiSessionWatcher(ws)
    watcher.start()
    let calls = 0
    watcher.onEvent(() => { calls++; throw new Error('listener boom') })
    fs.appendFileSync(file, user('u9', 'trigger'))
    const deadline = Date.now() + 5000
    while (calls === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    assert.ok(calls > 0, 'the listener was called')
    assert.equal(watcher.isSessionActive(uuid(1)), true)
  })

  it('picks up a session file created after start', async () => {
    watcher = new PiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
    addSession(1, ws)
    const deadline = Date.now() + 8000
    while (watcher.getActiveSessions().length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.equal(watcher.getActiveSessions().length, 1)
  })
})
