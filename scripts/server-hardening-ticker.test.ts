/**
 * SharedTicker and KeyedCoalescer edge paths (issue #68).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SharedTicker, KeyedCoalescer } from './server-hardening'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('SharedTicker.stop', () => {
  it('stops the timer and forgets every client; later releases do not go negative', () => {
    const t = new SharedTicker(() => {}, 1000)
    const r1 = t.acquire()
    const r2 = t.acquire()
    assert.equal(t.clientCount, 2)
    t.stop()
    assert.equal(t.active, false)
    assert.equal(t.clientCount, 0, 'stop() resets the client count')
    r1(); r2()
    assert.equal(t.clientCount, 0, 'releases handed out before stop() are harmless afterwards')
    const fresh = t.acquire()
    const other = t.acquire()
    assert.equal(t.clientCount, 2)
    fresh()
    assert.equal(t.active, true, 'one client is still connected: the timer keeps running')
    other()
    assert.equal(t.active, false)
  })

  it('a release handed out before stop() cannot stop a client acquired after it', () => {
    const t = new SharedTicker(() => {}, 1000)
    const old = t.acquire()
    t.stop()
    const fresh = t.acquire()
    old()
    assert.equal(t.clientCount, 1)
    assert.equal(t.active, true, 'the new client keeps its timer')
    fresh()
    assert.equal(t.active, false)
  })

  it('can be started again after stop(), counting from zero', () => {
    const t = new SharedTicker(() => {}, 1000)
    t.acquire(); t.acquire()
    t.stop()
    const release = t.acquire()
    assert.equal(t.clientCount, 1)
    assert.equal(t.active, true)
    release()
    assert.equal(t.active, false, 'the only client left: the timer is stopped')
  })
})

describe('SharedTicker tick', () => {
  it('a throwing tick does not kill the timer', async () => {
    let calls = 0
    const t = new SharedTicker(() => { calls++; throw new Error('boom') }, 10)
    const release = t.acquire()
    // Attend la condition observable (au moins 2 ticks) plutot qu'une duree fixe :
    // sur un coeur sature, 80 ms ne garantissent pas 2 ticks de 10 ms.
    const deadline = Date.now() + 5000
    while (calls < 2 && Date.now() < deadline) await sleep(5)
    release()
    assert.ok(calls >= 2, `ticked ${calls} times despite throwing`)
  })
})

describe('KeyedCoalescer', () => {
  it('a failing run rejects every sharer and is not cached for the next call', async () => {
    const c = new KeyedCoalescer<number>()
    let attempt = 0
    const work = async () => { attempt++; await sleep(20); if (attempt === 1) throw new Error('first fails'); return attempt }
    const first = [c.run('k', work), c.run('k', work)]
    const settled = await Promise.allSettled(first)
    assert.deepEqual(settled.map(s => s.status), ['rejected', 'rejected'])
    assert.equal(c.runs, 1)
    assert.equal(c.pending, 0)
    assert.equal(await c.run('k', work), 2, 'the next call runs again')
  })

  it('different keys run independently', async () => {
    const c = new KeyedCoalescer<string>()
    const out = await Promise.all([c.run('a', async () => 'A'), c.run('b', async () => 'B'), c.run('a', async () => 'A2')])
    assert.deepEqual(out, ['A', 'B', 'A'])
    assert.equal(c.runs, 2)
  })
})
