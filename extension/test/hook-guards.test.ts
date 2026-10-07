import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLoopbackAddress, isLoopbackHostHeader, TokenBucket, KeyedRateLimiter,
  isSafeId, validateHookPayload, AsyncLimiter, withTimeout,
} from '../src/hook-guards'

describe('loopback checks', () => {
  it('accepts loopback addresses only', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a)
    for (const a of ['10.0.0.1', '192.168.1.1', '::ffff:10.0.0.1', '', undefined, '127.0.0.1.evil.com']) assert.equal(isLoopbackAddress(a), false, String(a))
  })
  it('validates Host headers against DNS rebinding', () => {
    for (const h of ['127.0.0.1:3000', 'localhost', 'localhost:80', '[::1]:3001']) assert.equal(isLoopbackHostHeader(h), true, h)
    for (const h of ['evil.com', 'evil.com:3000', '127.0.0.1.evil.com', undefined, '', 'localhost@evil.com']) assert.equal(isLoopbackHostHeader(h), false, String(h))
  })
})

describe('token bucket', () => {
  it('allows a burst, then refuses, then refills over time', () => {
    const b = new TokenBucket(3, 1, 0)
    assert.deepEqual([b.tryTake(0), b.tryTake(0), b.tryTake(0), b.tryTake(0)], [true, true, true, false])
    assert.equal(b.tryTake(500), false)
    assert.equal(b.tryTake(1100), true)
  })
  it('never refills above capacity', () => {
    const b = new TokenBucket(2, 100, 0)
    assert.equal(b.tryTake(10_000), true)
    assert.equal(b.tryTake(10_000), true)
    assert.equal(b.tryTake(10_000), false)
  })
  it('keyed limiter isolates keys and bounds tracked keys', () => {
    const l = new KeyedRateLimiter(1, 0.001, 3)
    assert.equal(l.allow('a', 0), true)
    assert.equal(l.allow('a', 0), false)
    assert.equal(l.allow('b', 0), true)
    for (const k of ['c', 'd', 'e']) l.allow(k, 0)
    assert.equal(l.size, 3)
  })
})

describe('validateHookPayload', () => {
  const base = { session_id: 'abc-123', hook_event_name: 'PreToolUse' }
  it('accepts a minimal valid payload', () => assert.equal(validateHookPayload(base).ok, true))
  it('rejects non-objects and arrays', () => {
    for (const v of [null, 1, 'x', [], undefined]) assert.equal(validateHookPayload(v).ok, false)
  })
  it('rejects bad identifiers (type, length, charset)', () => {
    assert.equal(validateHookPayload({ ...base, session_id: 5 }).ok, false)
    assert.equal(validateHookPayload({ ...base, session_id: 'a'.repeat(129) }).ok, false)
    assert.equal(validateHookPayload({ ...base, session_id: '../etc' }).ok, false)
    assert.equal(validateHookPayload({ ...base, session_id: '' }).ok, false)
    assert.equal(validateHookPayload({ ...base, agent_id: 'a'.repeat(65) }).ok, false)
    assert.equal(validateHookPayload({ ...base, agent_type: 'x y' }).ok, false)
    assert.equal(validateHookPayload({ ...base, agent_id: 12 }).ok, false)
    assert.equal(validateHookPayload({ ...base, tool_use_id: '<script>' }).ok, false)
  })
  it('rejects wrongly typed or oversized optional fields', () => {
    assert.equal(validateHookPayload({ ...base, tool_input: 'str' }).ok, false)
    assert.equal(validateHookPayload({ ...base, tool_input: [] }).ok, false)
    assert.equal(validateHookPayload({ ...base, message: 'x'.repeat(5000) }).ok, false)
    assert.equal(validateHookPayload({ ...base, tool_name: 3 }).ok, false)
    assert.equal(validateHookPayload({ ...base, is_error: 'yes' }).ok, false)
    assert.equal(validateHookPayload({ ...base, agent_transcript_path: 'a\0b' }).ok, false)
  })
  it('accepts well-formed optional fields', () => {
    const r = validateHookPayload({ ...base, agent_id: 'a1b2c3', agent_type: 'general-purpose', tool_name: 'Read', tool_input: { file_path: '/x' }, is_error: false })
    assert.equal(r.ok, true)
  })
  it('isSafeId bounds', () => {
    assert.equal(isSafeId('a'.repeat(128)), true)
    assert.equal(isSafeId('a'.repeat(129)), false)
  })
})

describe('AsyncLimiter', () => {
  it('runs one task at a time and returns fallback when the queue is full', async () => {
    const l = new AsyncLimiter(1, 1)
    let running = 0
    let maxRunning = 0
    const task = (v: string) => async () => {
      running++; maxRunning = Math.max(maxRunning, running)
      await new Promise(r => setTimeout(r, 20))
      running--
      return v
    }
    const results = await Promise.all([l.run(task('a'), 'fb'), l.run(task('b'), 'fb'), l.run(task('c'), 'fb')])
    assert.deepEqual(results, ['a', 'b', 'fb'])
    assert.equal(maxRunning, 1)
    assert.equal(await l.run(task('d'), 'fb'), 'd')
  })
  it('releases the slot when a task throws', async () => {
    const l = new AsyncLimiter(1, 2)
    assert.equal(await l.run(async () => { throw new Error('x') }, 'fb'), 'fb')
    assert.equal(await l.run(async () => 'ok', 'fb'), 'ok')
  })
  it('withTimeout resolves the fallback on timeout', async () => {
    assert.equal(await withTimeout(new Promise<string>(() => {}), 10, 'late'), 'late')
    assert.equal(await withTimeout(Promise.resolve('fast'), 1000, 'late'), 'fast')
  })
})
