/**
 * Pure helpers that harden the hook server against untrusted local input.
 * No vscode/http dependencies so they are unit-testable.
 */
import {
  HOOK_ID_MAX_LENGTH, HOOK_AGENT_FIELD_MAX_LENGTH, HOOK_TEXT_MAX_LENGTH,
  HOOK_RATE_MAX_BUCKETS,
} from './constants'

/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback (::ffff:127.x.x.x) */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) { return false }
  const a = addr.toLowerCase()
  if (a === '::1') { return true }
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/**
 * Validates a Host header against DNS rebinding: only loopback names are accepted.
 * A missing Host is rejected (HTTP/1.1 requires it).
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) { return false }
  const m = /^(?:\[([0-9a-fA-F:]+)\]|([A-Za-z0-9.-]+))(?::\d{1,5})?$/.exec(host.trim())
  if (!m) { return false }
  const name = (m[1] ?? m[2]).toLowerCase()
  return name === 'localhost' || isLoopbackAddress(name)
}

/** Token bucket with an injectable clock. */
export class TokenBucket {
  private tokens: number
  private last: number
  constructor(private readonly capacity: number, private readonly refillPerS: number, now = Date.now()) {
    this.tokens = capacity
    this.last = now
  }
  /** Take one token; false when the bucket is empty. */
  tryTake(now = Date.now()): boolean {
    const dt = Math.max(0, now - this.last) / 1000
    this.last = now
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerS)
    if (this.tokens >= 1) { this.tokens -= 1; return true }
    return false
  }
}

/** Keyed token buckets; the number of tracked keys is bounded (oldest evicted). */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>()
  constructor(
    private readonly capacity: number,
    private readonly refillPerS: number,
    private readonly maxKeys = HOOK_RATE_MAX_BUCKETS,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key)
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value
        if (oldest !== undefined) { this.buckets.delete(oldest) }
      }
      b = new TokenBucket(this.capacity, this.refillPerS, now)
      this.buckets.set(key, b)
    }
    return b.tryTake(now)
  }
  get size(): number { return this.buckets.size }
}

const ID_RE = /^[A-Za-z0-9._:@-]+$/

/** A bounded identifier: non-empty string, limited length and charset. */
export function isSafeId(value: unknown, maxLen = HOOK_ID_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && ID_RE.test(value)
}

function isBoundedText(value: unknown, maxLen = HOOK_TEXT_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLen && !value.includes('\0')
}

export type HookValidation =
  | { ok: true; payload: Record<string, unknown> & { session_id: string; hook_event_name: string } }
  | { ok: false; reason: string }

/**
 * Validate the shape of a parsed hook payload before any field is used.
 * Identifier fields must be bounded and charset-restricted; optional text fields
 * must be strings of bounded length; tool_input must be a plain object.
 */
export function validateHookPayload(parsed: unknown): HookValidation {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return { ok: false, reason: 'payload is not an object' } }
  const p = parsed as Record<string, unknown>
  if (!isSafeId(p.session_id)) { return { ok: false, reason: 'invalid session_id' } }
  if (!isSafeId(p.hook_event_name, 64)) { return { ok: false, reason: 'invalid hook_event_name' } }
  for (const key of ['agent_id', 'agent_type'] as const) {
    if (p[key] !== undefined && !isSafeId(p[key], HOOK_AGENT_FIELD_MAX_LENGTH)) { return { ok: false, reason: `invalid ${key}` } }
  }
  if (p.tool_use_id !== undefined && !isSafeId(p.tool_use_id)) { return { ok: false, reason: 'invalid tool_use_id' } }
  for (const key of ['tool_name', 'notification_type', 'message', 'title', 'cwd', 'transcript_path', 'agent_transcript_path'] as const) {
    if (p[key] !== undefined && !isBoundedText(p[key])) { return { ok: false, reason: `invalid ${key}` } }
  }
  if (p.tool_input !== undefined && (!p.tool_input || typeof p.tool_input !== 'object' || Array.isArray(p.tool_input))) {
    return { ok: false, reason: 'invalid tool_input' }
  }
  if (p.is_error !== undefined && typeof p.is_error !== 'boolean') { return { ok: false, reason: 'invalid is_error' } }
  return { ok: true, payload: p as Record<string, unknown> & { session_id: string; hook_event_name: string } }
}

/** Runs async tasks with a concurrency limit and a bounded FIFO waiting queue. */
export class AsyncLimiter {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly concurrency: number, private readonly maxQueue: number) {}
  get pending(): number { return this.queue.length }
  /** Resolves with fn's result, or `fallback` right away when the queue is full. */
  async run<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.maxQueue) { return fallback }
      // The releasing task hands its slot over directly (active is not decremented).
      await new Promise<void>(resolve => this.queue.push(resolve))
    } else {
      this.active++
    }
    try {
      return await fn()
    } catch {
      return fallback
    } finally {
      const next = this.queue.shift()
      if (next) { next() } else { this.active-- }
    }
  }
}

/** Race a promise against a timeout; resolves `fallback` on timeout. The timer is always cleared. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([p, timeout]).finally(() => { if (timer) { clearTimeout(timer) } })
}
