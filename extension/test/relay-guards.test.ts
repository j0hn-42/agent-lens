import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'
import {
  isValidSessionId, parseSessionParam, isBackedUp, capReplayBatches, appendBounded,
  isTruthyFlag, listProjectDirs, discoverSessionFiles, trimKeepingLifecycle, isCrossOriginRequest,
} from '../src/relay-guards'

const ev = (n: number, sessionId = 's', type = 'message'): AgentEvent => ({ time: n, type, payload: { n }, sessionId }) as unknown as AgentEvent

describe('session id / query validation', () => {
  it('validates ids', () => {
    assert.equal(isValidSessionId('abc-123_x.y:z'), true)
    for (const v of ['', 'a b', 'a/b', 'x'.repeat(129), 5, null]) assert.equal(isValidSessionId(v), false, String(v))
  })
  it('parses /events with and without session', () => {
    assert.deepEqual(parseSessionParam('/events'), { isEvents: true })
    assert.deepEqual(parseSessionParam('/events?session=abc'), { isEvents: true, session: 'abc' })
    assert.deepEqual(parseSessionParam('/other'), { isEvents: false })
    assert.deepEqual(parseSessionParam(undefined), { isEvents: false })
  })
  it('flags malformed or repeated session parameters', () => {
    assert.equal(parseSessionParam('/events?session=a%20b').invalid, true)
    assert.equal(parseSessionParam('/events?session=' + 'a'.repeat(200)).invalid, true)
    assert.equal(parseSessionParam('/events?session=a&session=b').invalid, true)
    assert.equal(parseSessionParam('/events?session=').invalid, true)
  })
})

describe('backpressure', () => {
  it('flags only backlogs over the limit', () => {
    assert.equal(isBackedUp(10, 100), false)
    assert.equal(isBackedUp(101, 100), true)
  })
})

describe('capReplayBatches', () => {
  const batch = (sid: string, n: number) => ({ type: 'agent-event-batch' as const, events: Array.from({ length: n }, (_, i) => ev(i, sid)) })
  it('keeps the newest events per session', () => {
    const out = capReplayBatches([batch('a', 10)], { perSession: 4, total: 100, batchSize: 100 })
    assert.equal(out.length, 1)
    assert.deepEqual(out[0].events.map(e => e.time), [6, 7, 8, 9])
  })
  it('gives the total budget to the last (primary) sessions first', () => {
    const out = capReplayBatches([batch('old', 5), batch('mid', 5), batch('new', 5)], { perSession: 5, total: 8, batchSize: 100 })
    const flat = out.flatMap(b => b.events)
    assert.equal(flat.length, 8)
    assert.equal(flat.filter(e => e.sessionId === 'new').length, 5)
    assert.equal(flat.filter(e => e.sessionId === 'mid').length, 3)
    assert.equal(flat.filter(e => e.sessionId === 'old').length, 0)
  })
  it('splits into batches of at most batchSize', () => {
    const out = capReplayBatches([batch('a', 25)], { perSession: 100, total: 100, batchSize: 10 })
    assert.deepEqual(out.map(b => b.events.length), [10, 10, 5])
  })
  it('default limits are applied', () => {
    const out = capReplayBatches([batch('a', 6000), batch('b', 6000), batch('c', 6000)])
    const total = out.reduce((n, b) => n + b.events.length, 0)
    assert.ok(total <= 10000)
    assert.ok(out.every(b => b.events.length <= 500))
  })
})

describe('appendBounded', () => {
  it('bounds events per session', () => {
    const m = new Map<string, AgentEvent[]>()
    for (let i = 0; i < 20; i++) appendBounded(m, 's', ev(i), { perSession: 5, sessions: 10, total: 100 })
    assert.deepEqual(m.get('s')!.map(e => e.time), [15, 16, 17, 18, 19])
  })
  it('bounds the number of sessions, evicting least recently written', () => {
    const m = new Map<string, AgentEvent[]>()
    const lim = { perSession: 5, sessions: 2, total: 100 }
    for (const id of ['a', 'b', 'c']) appendBounded(m, id, ev(0, id), lim)
    assert.deepEqual([...m.keys()], ['b', 'c'])
    appendBounded(m, 'b', ev(1, 'b'), lim)
    appendBounded(m, 'd', ev(0, 'd'), lim)
    assert.deepEqual([...m.keys()], ['b', 'd'])
  })
  it('bounds total events', () => {
    const m = new Map<string, AgentEvent[]>()
    for (const id of ['a', 'b', 'c']) for (let i = 0; i < 4; i++) appendBounded(m, id, ev(i, id), { perSession: 10, sessions: 10, total: 6 })
    const total = [...m.values()].reduce((n, b) => n + b.length, 0)
    assert.ok(total <= 6, `total ${total}`)
    assert.ok(m.has('c'))
  })
})

describe('lifecycle events survive replay-buffer overflow', () => {
  it('appendBounded evicts chatter before agent_spawn / team_info', () => {
    const m = new Map<string, AgentEvent[]>()
    const lim = { perSession: 6, sessions: 10, total: 100 }
    appendBounded(m, 's', ev(0, 's', 'agent_spawn'), lim)
    appendBounded(m, 's', ev(1, 's', 'team_info'), lim)
    for (let i = 2; i < 40; i++) appendBounded(m, 's', ev(i, 's', 'message_sent'), lim)
    const buf = m.get('s')!
    assert.equal(buf.length, 6)
    assert.deepEqual(buf.slice(0, 2).map(e => e.type), ['agent_spawn', 'team_info'])
    assert.deepEqual(buf.slice(2).map(e => e.time), [36, 37, 38, 39])
  })
  it('trimKeepingLifecycle falls back to the oldest event when only lifecycle events remain', () => {
    const buf = Array.from({ length: 5 }, (_, i) => ev(i, 's', 'agent_spawn'))
    trimKeepingLifecycle(buf, 3)
    assert.deepEqual(buf.map(e => e.time), [2, 3, 4])
  })
  it('capReplayBatches re-adds the lifecycle events cut off by the per-session cap', () => {
    const events = [ev(0, 'a', 'agent_spawn'), ...Array.from({ length: 20 }, (_, i) => ev(i + 1, 'a', 'message_sent'))]
    const out = capReplayBatches([{ type: 'agent-event-batch', events }], { perSession: 4, total: 100, batchSize: 100 })
    const flat = out.flatMap(b => b.events)
    assert.equal(flat[0].type, 'agent_spawn')
    assert.equal(flat.length, 5)
  })
})

describe('isTruthyFlag', () => {
  it('parses env-style flags', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(isTruthyFlag(v), true)
    for (const v of ['0', 'false', '', undefined, 'no']) assert.equal(isTruthyFlag(v), false)
  })
})

describe('safe discovery', () => {
  let root: string
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-disc-'))
    fs.mkdirSync(path.join(root, 'proj-a'))
    fs.mkdirSync(path.join(root, 'proj-b'))
    fs.mkdirSync(path.join(root, 'outside'))
    fs.writeFileSync(path.join(root, 'outside', 'secret.jsonl'), '{}\n')
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'linked-dir'))
    fs.writeFileSync(path.join(root, 'proj-a', 'good-1.jsonl'), '{}\n')
    fs.writeFileSync(path.join(root, 'proj-a', 'notes.txt'), 'x')
    fs.writeFileSync(path.join(root, 'proj-a', 'bad name.jsonl'), '{}\n')
    fs.writeFileSync(path.join(root, 'proj-a', 'big.jsonl'), 'x'.repeat(2000))
    fs.symlinkSync(path.join(root, 'outside', 'secret.jsonl'), path.join(root, 'proj-a', 'link.jsonl'))
    fs.writeFileSync(path.join(root, 'proj-b', 'good-2.jsonl'), '{}\n')
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it('lists real project dirs only (symlinked dirs skipped), honours match and cap', () => {
    const all = listProjectDirs(root, null).map(d => path.basename(d)).sort()
    assert.deepEqual(all, ['outside', 'proj-a', 'proj-b'])
    assert.deepEqual(listProjectDirs(root, n => n === 'proj-b').map(d => path.basename(d)), ['proj-b'])
    assert.equal(listProjectDirs(root, null, 1).length, 1)
    assert.deepEqual(listProjectDirs(path.join(root, 'nope'), null), [])
  })

  it('returns only regular .jsonl files with safe ids within the size cap', () => {
    const found = discoverSessionFiles({ dirs: [path.join(root, 'proj-a'), path.join(root, 'proj-b')], maxFileBytes: 1000 })
    assert.deepEqual(found.map(f => f.sessionId).sort(), ['good-1', 'good-2'])
  })

  it('caps files per directory', () => {
    const found = discoverSessionFiles({ dirs: [path.join(root, 'proj-a')], maxFilesPerDir: 1, maxFileBytes: 1_000_000 })
    assert.ok(found.length <= 1)
  })
})

describe('isCrossOriginRequest (#102)', () => {
  const host = '127.0.0.1:3001'
  it('refuses Sec-Fetch-Site cross-site', () => {
    assert.equal(isCrossOriginRequest({ 'sec-fetch-site': 'cross-site' }, host), true)
    assert.equal(isCrossOriginRequest({ 'sec-fetch-site': 'cross-site', origin: 'http://localhost:3000' }, host), true)
  })
  it('accepts requests without browser fetch metadata (curl, MCP clients, server-side callers)', () => {
    assert.equal(isCrossOriginRequest({}, host), false)
    assert.equal(isCrossOriginRequest({ 'sec-fetch-site': 'none' }, host), false)
  })
  it('accepts the relay\'s own origin and the dev web origins, nothing else', () => {
    assert.equal(isCrossOriginRequest({ origin: 'http://127.0.0.1:3001' }, host), false)
    assert.equal(isCrossOriginRequest({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }, host), false)
    for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example', 'http://127.0.0.1:3001.evil.io', 'file://']) {
      assert.equal(isCrossOriginRequest({ origin }, host), true, origin)
    }
  })
  it('treats a repeated Origin header (array) as foreign', () => {
    assert.equal(isCrossOriginRequest({ origin: ['http://localhost:3000', 'https://evil.example'] }, host), true)
  })
})
