/** Webhooks (#236): explicit destinations, whitelisted body, bounded size, delay and rate, nothing unproven. */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import type { AgentEvent } from '../extension/src/protocol'
import {
  parseWebhookDestinations, parseWebhookEvents, buildWebhookBody, createWebhookDispatcher, httpPost,
  WEBHOOK_MAX_DESTINATIONS, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_IN_FLIGHT, WEBHOOK_MAX_PER_MINUTE, WEBHOOK_TIMEOUT_MS,
} from './webhooks'

const ev = (type: AgentEvent['type'], payload: Record<string, unknown> = {}, sessionId: string | undefined = 's1'): AgentEvent => ({ time: 3, type, payload, ...(sessionId ? { sessionId } : {}) })

describe('parseWebhookDestinations', () => {
  it('accepts https URLs and http only towards loopback', () => {
    const r = parseWebhookDestinations(['https://hooks.example.com/a?x=1', 'http://127.0.0.1:9000/h', 'http://localhost/h'])
    assert.equal(r.destinations.length, 3)
    assert.deepEqual(r.errors, [])
  })
  it('refuses plain http to a remote host, credentials, other schemes and garbage', () => {
    const r = parseWebhookDestinations(['http://example.com/h', 'https://user:pw@example.com/h', 'file:///etc/passwd', 'ftp://x/y', 'not a url', 'https://example.com/' + 'a'.repeat(3000)])
    assert.deepEqual(r.destinations, [])
    assert.equal(r.errors.length, 6)
  })
  it('never echoes a URL (it may hold a secret) in its errors', () => {
    const r = parseWebhookDestinations(['https://user:SECRETPW@example.com/h?token=SECRET'])
    assert.ok(!r.errors.join(' ').includes('SECRET'))
  })
  it('caps the number of destinations and drops duplicates', () => {
    const urls = Array.from({ length: WEBHOOK_MAX_DESTINATIONS + 2 }, (_, i) => `https://h${i}.example.com/x`)
    const r = parseWebhookDestinations([...urls, urls[0]])
    assert.equal(r.destinations.length, WEBHOOK_MAX_DESTINATIONS)
    assert.ok(r.errors.length >= 2)
  })
})

describe('parseWebhookEvents', () => {
  it('defaults to the three lifecycle events', () => {
    assert.deepEqual(parseWebhookEvents(undefined).events, ['agent_complete', 'permission_requested', 'error'])
  })
  it('accepts a subset and refuses what it does not know', () => {
    assert.deepEqual(parseWebhookEvents('error').events, ['error'])
    assert.ok(parseWebhookEvents('error,message').error)
    assert.ok(parseWebhookEvents('').error === undefined)
  })
})

describe('buildWebhookBody', () => {
  it('builds the body field by field', () => {
    const body = JSON.parse(buildWebhookBody(ev('agent_complete', { agent: 'main', secret: 'x', prompt: 'do the thing' }), 99)!)
    assert.deepEqual(body, { schema: 1, source: 'agent-lens', type: 'agent_complete', sessionId: 's1', agent: 'main', sentAt: 99 })
  })
  it('leaves out an error message, a prompt, a tool argument and a path', () => {
    const raw = buildWebhookBody(ev('error', { agent: 'main', message: 'failed at /home/me/secret.txt with sk-ant-abc', file: '/home/me/x' }), 1)!
    assert.ok(!raw.includes('/home') && !raw.includes('sk-ant'))
  })
  it('omits an agent name that looks like a path or an invalid session id instead of guessing', () => {
    const b = JSON.parse(buildWebhookBody(ev('error', { agent: '/home/me/x' }, 'bad id!'), 1)!)
    assert.equal('agent' in b, false)
    assert.equal('sessionId' in b, false)
  })
  it('answers null for an event type that is not a webhook event', () => {
    assert.equal(buildWebhookBody(ev('message', { agent: 'a' }), 1), null)
  })
  it('stays under the body cap', () => {
    assert.ok(Buffer.byteLength(buildWebhookBody(ev('agent_complete', { agent: 'x'.repeat(5000) }), 1)!) <= WEBHOOK_MAX_BODY_BYTES)
  })
})

describe('createWebhookDispatcher', () => {
  function setup(over: { post?: (url: string, body: string) => Promise<number>; now?: () => number; events?: string[]; destinations?: string[] } = {}) {
    const calls: Array<{ url: string; body: string }> = []
    let t = 1_000_000
    const d = createWebhookDispatcher({
      destinations: over.destinations ?? ['https://a.example.com/h', 'https://b.example.com/h'],
      events: (over.events ?? ['agent_complete', 'permission_requested', 'error']) as never,
      post: over.post ?? (async (url, body) => { calls.push({ url, body }); return 204 }),
      now: over.now ?? (() => t),
    })
    return { d, calls, tick: (ms: number) => { t += ms } }
  }

  it('posts a selected event to every destination and counts it as sent', async () => {
    const { d, calls } = setup()
    d.notify(ev('agent_complete', { agent: 'main' }))
    await d.idle()
    assert.deepEqual(calls.map(c => c.url).sort(), ['https://a.example.com/h', 'https://b.example.com/h'])
    assert.equal(d.stats().sent, 2)
  })
  it('does nothing for events outside the selection', async () => {
    const { d, calls } = setup({ events: ['error'] })
    d.notify(ev('agent_complete')); d.notify(ev('message')); d.notify({ time: 1, type: 'error', payload: {} })
    await d.idle()
    assert.equal(calls.length, 2) // the session-less error only, to both destinations
  })
  it('counts a failure (non-2xx or rejection) as failed, never as sent', async () => {
    let n = 0
    const { d } = setup({ post: async () => { n++; if (n === 1) return 500; throw new Error('boom') } })
    d.notify(ev('error')); await d.idle()
    assert.deepEqual({ sent: d.stats().sent, failed: d.stats().failed }, { sent: 0, failed: 2 })
  })
  it('bounds the sends in flight and counts what it drops', async () => {
    const release: Array<() => void> = []
    const { d } = setup({ destinations: ['https://a.example.com/h'], post: () => new Promise<number>(r => { release.push(() => r(200)) }) })
    for (let i = 0; i < WEBHOOK_MAX_IN_FLIGHT + 5; i++) d.notify(ev('error'))
    assert.equal(release.length, WEBHOOK_MAX_IN_FLIGHT)
    assert.equal(d.stats().droppedBusy, 5)
    release.forEach(r => r()); await d.idle()
    assert.equal(d.stats().sent, WEBHOOK_MAX_IN_FLIGHT)
  })
  it('bounds the sends per minute, and starts again the minute after', async () => {
    const { d, calls, tick } = setup({ destinations: ['https://a.example.com/h'] })
    for (let i = 0; i < WEBHOOK_MAX_PER_MINUTE + 4; i++) { d.notify(ev('error')); await d.idle() }
    assert.equal(calls.length, WEBHOOK_MAX_PER_MINUTE)
    assert.equal(d.stats().droppedRate, 4)
    tick(60_001)
    d.notify(ev('error')); await d.idle()
    assert.equal(calls.length, WEBHOOK_MAX_PER_MINUTE + 1)
  })
  it('does not throw into the relay when post throws synchronously', () => {
    const { d } = setup({ post: () => { throw new Error('sync') } })
    assert.doesNotThrow(() => d.notify(ev('error')))
  })
  it('stops sending after dispose', async () => {
    const { d, calls } = setup()
    d.dispose(); d.notify(ev('error')); await d.idle()
    assert.equal(calls.length, 0)
  })
})

describe('httpPost', () => {
  let server: http.Server
  let port = 0
  let received: { method?: string; ct?: string; body: string }[] = []
  let mode: 'ok' | 'redirect' | 'hang' = 'ok'
  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        received.push({ method: req.method, ct: String(req.headers['content-type']), body })
        if (mode === 'hang') return
        if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); return void res.end() }
        res.writeHead(204); res.end()
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  after(() => { server.closeAllConnections(); server.close() })

  it('POSTs JSON and returns the status', async () => {
    received = []
    assert.equal(await httpPost(`http://127.0.0.1:${port}/h`, '{"a":1}', 1000), 204)
    assert.deepEqual(received, [{ method: 'POST', ct: 'application/json', body: '{"a":1}' }])
  })
  it('does not follow a redirect (the status is returned as is)', async () => {
    mode = 'redirect'
    try { assert.equal(await httpPost(`http://127.0.0.1:${port}/h`, '{}', 1000), 302) } finally { mode = 'ok' }
  })
  it('gives up after the timeout', async () => {
    mode = 'hang'
    try { await assert.rejects(httpPost(`http://127.0.0.1:${port}/h`, '{}', 150), /timeout/i) } finally { mode = 'ok' }
  })
  it('has a bounded default timeout', () => { assert.ok(WEBHOOK_TIMEOUT_MS > 0 && WEBHOOK_TIMEOUT_MS <= 5000) })
})
