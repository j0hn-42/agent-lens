/**
 * Webhooks (#236): notify an explicit destination when a live agent completes, asks for a permission or errors.
 *
 * - Destinations are given by the user (flag or variable), never discovered. https, or http towards loopback only;
 *   no credentials in the URL; at most WEBHOOK_MAX_DESTINATIONS. A URL may hold a secret: it is never logged or echoed.
 * - The body is built field by field (type, session id, agent name, time): no message, prompt, tool argument or path.
 * - Bounded: body size, delay, redirects (none), sends in flight and sends per minute. Whatever is dropped or fails
 *   is counted in stats(), never reported as sent.
 */
import * as http from 'http'
import * as https from 'https'
import type { AgentEvent } from '../extension/src/protocol'
import { safeAgentName } from '../extension/src/observations'
import { isValidSessionId } from '../extension/src/relay-guards'

export const WEBHOOK_EVENT_TYPES = ['agent_complete', 'permission_requested', 'error'] as const
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number]

export const WEBHOOK_MAX_DESTINATIONS = 4
export const WEBHOOK_MAX_URL_LENGTH = 2048
export const WEBHOOK_MAX_BODY_BYTES = 1024
export const WEBHOOK_TIMEOUT_MS = 3000
export const WEBHOOK_MAX_IN_FLIGHT = 8
export const WEBHOOK_MAX_PER_MINUTE = 30

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function parseWebhookDestinations(urls: string[]): { destinations: string[]; errors: string[] } {
  const destinations: string[] = []
  const errors: string[] = []
  urls.forEach((raw, i) => {
    const label = `webhook #${i + 1}`
    if (raw.length > WEBHOOK_MAX_URL_LENGTH) return void errors.push(`${label}: URL too long`)
    let u: URL
    try { u = new URL(raw) } catch { return void errors.push(`${label}: not a valid URL`) }
    if (u.username || u.password) return void errors.push(`${label}: credentials in the URL are refused`)
    if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname)) return void errors.push(`${label}: http is only accepted towards loopback, use https`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return void errors.push(`${label}: only http(s) is accepted`)
    if (destinations.includes(u.href)) return void errors.push(`${label}: duplicate destination`)
    if (destinations.length >= WEBHOOK_MAX_DESTINATIONS) return void errors.push(`${label}: at most ${WEBHOOK_MAX_DESTINATIONS} destinations`)
    destinations.push(u.href)
  })
  return { destinations, errors }
}

export function parseWebhookEvents(raw: string | undefined): { events: WebhookEventType[]; error?: string } {
  if (raw === undefined || raw.trim() === '') return { events: [...WEBHOOK_EVENT_TYPES] }
  const events: WebhookEventType[] = []
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(part)) return { events: [...WEBHOOK_EVENT_TYPES], error: `unknown webhook event "${part.slice(0, 40)}" (allowed: ${WEBHOOK_EVENT_TYPES.join(', ')})` }
    if (!events.includes(part as WebhookEventType)) events.push(part as WebhookEventType)
  }
  return { events }
}

/** The JSON body of one notification, or null when the event is not a webhook event. */
export function buildWebhookBody(event: AgentEvent, now: number): string | null {
  if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event.type)) return null
  const p = (event.payload ?? {}) as Record<string, unknown>
  const body: Record<string, unknown> = { schema: 1, source: 'agent-lens', type: event.type }
  if (isValidSessionId(event.sessionId)) body.sessionId = event.sessionId
  const rawAgent = p.agent ?? p.name
  if (typeof rawAgent === 'string') {
    const name = safeAgentName(rawAgent)
    // safeAgentName stands 'agent' in for a path-like or empty name: that stand-in is not a proven name
    if (name !== 'agent' || rawAgent.trim() === 'agent') body.agent = name
  }
  body.sentAt = now
  return JSON.stringify(body)
}

/** POST a JSON body; resolves the HTTP status (redirects are NOT followed). Rejects on timeout or network error. */
export function httpPost(url: string, body: string, timeoutMs: number = WEBHOOK_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, {
      method: 'POST', agent: false, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'agent-lens-webhook' },
    }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
      res.on('error', reject)
    })
    // `timeout` only fires on socket inactivity: a hard deadline covers the whole exchange
    const deadline = setTimeout(() => req.destroy(new Error('webhook timeout')), timeoutMs)
    req.on('timeout', () => req.destroy(new Error('webhook timeout')))
    req.on('error', e => { clearTimeout(deadline); reject(e) })
    req.on('close', () => clearTimeout(deadline))
    req.end(body)
  })
}

export interface WebhookStats { sent: number; failed: number; droppedBusy: number; droppedRate: number }

export interface WebhookDispatcher {
  notify(event: AgentEvent): void
  stats(): WebhookStats
  /** Resolves when no send is in flight (tests, shutdown) */
  idle(): Promise<void>
  dispose(): void
}

export interface WebhookDispatcherOptions {
  destinations: string[]
  events: readonly WebhookEventType[]
  post?: (url: string, body: string) => Promise<number>
  now?: () => number
}

export function createWebhookDispatcher(options: WebhookDispatcherOptions): WebhookDispatcher {
  const post = options.post ?? ((url, body) => httpPost(url, body))
  const now = options.now ?? Date.now
  const stats: WebhookStats = { sent: 0, failed: 0, droppedBusy: 0, droppedRate: 0 }
  const inFlight = new Set<Promise<void>>()
  let windowStart = -Infinity
  let windowCount = 0
  let disposed = false

  function send(url: string, body: string) {
    const t = now()
    if (t - windowStart >= 60_000) { windowStart = t; windowCount = 0 }
    if (windowCount >= WEBHOOK_MAX_PER_MINUTE) { stats.droppedRate++; return }
    if (inFlight.size >= WEBHOOK_MAX_IN_FLIGHT) { stats.droppedBusy++; return }
    windowCount++
    let p: Promise<void>
    try {
      p = Promise.resolve(post(url, body)).then(
        status => { if (status >= 200 && status <= 299) stats.sent++; else stats.failed++ },
        () => { stats.failed++ },
      )
    } catch { stats.failed++; return }
    const tracked = p.finally(() => { inFlight.delete(tracked) })
    inFlight.add(tracked)
  }

  return {
    notify(event) {
      if (disposed || !(options.events as readonly string[]).includes(event.type)) return
      const body = buildWebhookBody(event, now())
      if (body === null) return
      for (const url of options.destinations) send(url, body)
    },
    stats: () => ({ ...stats }),
    idle: async () => { while (inFlight.size > 0) await Promise.all([...inFlight]) },
    dispose() { disposed = true },
  }
}
