/**
 * Decision channel of the operator control (#240, PR 3): holds the PermissionRequest hooks Claude Code is waiting
 * on and lets the Agent Lens panel answer them. No `vscode` import: the extension wires it to the hook server (which
 * holds the HTTP response) and to the panel (postMessage).
 *
 * Fail closed. A request gets NO decision (Claude Code then shows its own prompt) when control is off, when no panel
 * can decide, when too many requests wait, when the request expires or is abandoned, when anything is malformed or
 * does not match, and when the decision cannot be journalled. There is no default `allow`, no "always allow", no batch.
 *
 * A decision is bound to (session_id, tool_use_id, nonce) and usable once. The PermissionRequest hook input carries
 * no tool_use_id (Claude Code hooks reference): the id is filled in by the caller only when a single open PreToolUse
 * call of that session matches the tool and its exact input, else it is null, and only a decision naming null matches.
 */
import { createHash, randomBytes } from 'crypto'
import {
  PERMISSION_REQUEST_TTL_MS, PERMISSION_MAX_PENDING, PERMISSION_INPUT_PREVIEW_MAX, PERMISSION_MESSAGE_MAX,
  PERMISSION_RECENT_CLOSED_MAX,
} from './constants'
import { CONTROL_TEXT } from './control-chars'
import type { DecisionAction, DecisionOutcome, DecisionRecord } from './decision-journal'
import { createLogger } from './logger'

const log = createLogger('PermissionGate')

/** JSON with object keys sorted at every level: the same input always gives the same text, and the same hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const parts = Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** What Claude Code is told: the shape of the PermissionRequest decision the hook script prints */
export type HookDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }

/** What the panel is shown about a waiting request */
export interface PermissionRequestView {
  sessionId: string
  toolUseId: string | null
  nonce: string
  toolName: string
  /** The tool input as JSON text, cut at PERMISSION_INPUT_PREVIEW_MAX characters */
  inputPreview: string
  inputTruncated: boolean
  /** SHA-256 of the whole input, the value written in the journal */
  inputSha256: string
  requestedAt: number
  expiresAt: number
}

/** How a request ended; 'journal-failed' = the decision could not be recorded, so it was not sent */
export interface GateClosed { nonce: string; sessionId: string; toolUseId: string | null; outcome: DecisionOutcome | 'journal-failed' }

export type DecideFailure = 'unknown' | 'closed' | 'mismatch' | 'message-required' | 'disabled' | 'journal-failed'
export type DecideResult = { ok: true } | { ok: false; reason: DecideFailure }

export interface GateRequestInput {
  sessionId: string
  toolName: string
  toolInput: unknown
  toolUseId: string | null
}

export interface PermissionGateOptions {
  /** Read at each use: the setting can be turned off while requests wait */
  enabled: () => boolean
  /** True when a panel that can show and answer requests is open; otherwise a request is not held */
  canDecide: () => boolean
  journal: { append(record: DecisionRecord): boolean }
  ttlMs?: number
  maxPending?: number
}

interface Pending {
  view: PermissionRequestView
  toolName: string
  resolve: (d: HookDecision | null) => void
  timer: NodeJS.Timeout
}

interface Closed { sessionId: string; toolUseId: string | null; toolName: string; inputSha256: string }

const NONCE_RE = /^[0-9a-f]{32}$/
const ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/

export class PermissionGate {
  private readonly pendingByNonce = new Map<string, Pending>()
  private readonly recentClosed = new Map<string, Closed>()
  private readonly requestListeners = new Set<(v: PermissionRequestView) => void>()
  private readonly closedListeners = new Set<(c: GateClosed) => void>()
  private readonly ttlMs: number
  private readonly maxPending: number

  constructor(private readonly opts: PermissionGateOptions) {
    this.ttlMs = opts.ttlMs ?? PERMISSION_REQUEST_TTL_MS
    this.maxPending = opts.maxPending ?? PERMISSION_MAX_PENDING
  }

  onRequest(listener: (v: PermissionRequestView) => void): () => void {
    this.requestListeners.add(listener)
    return () => { this.requestListeners.delete(listener) }
  }

  onClosed(listener: (c: GateClosed) => void): () => void {
    this.closedListeners.add(listener)
    return () => { this.closedListeners.delete(listener) }
  }

  /** Whether requests are worth sending to the gate at all */
  get active(): boolean { return this.opts.enabled() }

  pending(): PermissionRequestView[] { return [...this.pendingByNonce.values()].map(p => p.view) }

  /**
   * Holds a request. `decision` resolves with the operator's decision, or with null (no decision) in every other
   * case; it never rejects. `abort` ends the request early (the hook connection closed: the user answered in the terminal).
   */
  request(input: GateRequestInput): { decision: Promise<HookDecision | null>; abort: (outcome: 'answered-elsewhere') => void } {
    const none = { decision: Promise.resolve<HookDecision | null>(null), abort: () => {} }
    if (!this.opts.enabled() || !this.opts.canDecide()) return none
    if (this.pendingByNonce.size >= this.maxPending) {
      log.warn('Too many permission requests waiting: no decision for this one')
      return none
    }
    const nonce = randomBytes(16).toString('hex')
    const inputText = canonicalJson(input.toolInput)
    const requestedAt = Date.now()
    const view: PermissionRequestView = {
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      nonce,
      toolName: input.toolName,
      inputPreview: inputText.slice(0, PERMISSION_INPUT_PREVIEW_MAX),
      inputTruncated: inputText.length > PERMISSION_INPUT_PREVIEW_MAX,
      inputSha256: createHash('sha256').update(inputText).digest('hex'),
      requestedAt,
      expiresAt: requestedAt + this.ttlMs,
    }
    let resolve!: (d: HookDecision | null) => void
    const decision = new Promise<HookDecision | null>(r => { resolve = r })
    const timer = setTimeout(() => this.close(nonce, 'expired'), this.ttlMs)
    timer.unref?.()
    this.pendingByNonce.set(nonce, { view, toolName: input.toolName, resolve, timer })
    for (const l of this.requestListeners) { try { l(view) } catch (err) { log.warn('request listener failed:', err) } }
    return { decision, abort: outcome => this.close(nonce, outcome) }
  }

  /** The operator's answer. The raw message comes from the webview and is validated here. */
  decide(raw: unknown): DecideResult {
    const msg = parseDecision(raw)
    if (!msg) return { ok: false, reason: 'unknown' }
    const pending = this.pendingByNonce.get(msg.nonce)
    if (!pending) {
      const old = this.recentClosed.get(msg.nonce)
      if (!old) return { ok: false, reason: 'unknown' }
      this.journal(old, msg.action, 'rejected-replay')
      return { ok: false, reason: 'closed' }
    }
    const { view } = pending
    if (!this.opts.enabled()) return { ok: false, reason: 'disabled' }
    if (msg.sessionId !== view.sessionId || msg.toolUseId !== view.toolUseId) {
      this.journal({ sessionId: view.sessionId, toolUseId: view.toolUseId, toolName: view.toolName, inputSha256: view.inputSha256 }, msg.action, 'rejected-mismatch')
      return { ok: false, reason: 'mismatch' }
    }
    let hookDecision: HookDecision
    let messageChars: number | undefined
    if (msg.action === 'approve') {
      hookDecision = { behavior: 'allow' }
    } else if (msg.action === 'deny') {
      hookDecision = { behavior: 'deny', message: 'Denied by the operator from Agent Lens.' }
    } else {
      const text = cleanMessage(msg.message)
      if (!text) return { ok: false, reason: 'message-required' }
      hookDecision = { behavior: 'deny', message: text }
      messageChars = text.length
    }
    // Recorded before it is sent: a decision that cannot be recorded is not applied
    const written = this.opts.journal.append(this.record(view, msg.action, 'sent', messageChars))
    if (!written) {
      this.close(view.nonce, null)
      return { ok: false, reason: 'journal-failed' }
    }
    this.finish(view.nonce, 'sent', hookDecision)
    return { ok: true }
  }

  /** The panel went away: nobody can answer, so the waiting requests end without a decision */
  cancelAll(outcome: 'surface-closed' | 'shutdown'): void {
    for (const nonce of [...this.pendingByNonce.keys()]) this.close(nonce, outcome)
  }

  dispose(): void {
    this.cancelAll('shutdown')
    this.requestListeners.clear()
    this.closedListeners.clear()
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Ends a request with no decision; `null` = the journal itself failed, so nothing more is written. */
  private close(nonce: string, outcome: Exclude<DecisionOutcome, 'sent' | 'rejected-replay' | 'rejected-mismatch'> | null): void {
    const p = this.pendingByNonce.get(nonce)
    if (!p) return
    if (outcome) this.opts.journal.append(this.record(p.view, 'none', outcome))
    this.finish(nonce, outcome ?? 'journal-failed', null)
  }

  private finish(nonce: string, outcome: GateClosed['outcome'], decision: HookDecision | null): void {
    const p = this.pendingByNonce.get(nonce)
    if (!p) return
    clearTimeout(p.timer)
    this.pendingByNonce.delete(nonce)
    if (this.recentClosed.size >= PERMISSION_RECENT_CLOSED_MAX) {
      const oldest = this.recentClosed.keys().next().value
      if (oldest !== undefined) this.recentClosed.delete(oldest)
    }
    const { view } = p
    this.recentClosed.set(nonce, { sessionId: view.sessionId, toolUseId: view.toolUseId, toolName: view.toolName, inputSha256: view.inputSha256 })
    p.resolve(decision)
    for (const l of this.closedListeners) {
      try { l({ nonce, sessionId: view.sessionId, toolUseId: view.toolUseId, outcome }) } catch (err) { log.warn('closed listener failed:', err) }
    }
  }

  private record(view: PermissionRequestView, decision: DecisionAction | 'none', outcome: DecisionOutcome, messageChars?: number): DecisionRecord {
    return {
      ts: new Date().toISOString(),
      sessionId: view.sessionId,
      toolUseId: view.toolUseId,
      tool: view.toolName,
      decision,
      channel: 'vscode',
      inputSha256: view.inputSha256,
      outcome,
      ...(messageChars !== undefined ? { messageChars } : {}),
    }
  }

  private journal(c: Closed, action: DecisionAction, outcome: DecisionOutcome): void {
    this.opts.journal.append({
      ts: new Date().toISOString(), sessionId: c.sessionId, toolUseId: c.toolUseId, tool: c.toolName,
      decision: action, channel: 'vscode', inputSha256: c.inputSha256, outcome,
    })
  }
}

interface ParsedDecision { sessionId: string; toolUseId: string | null; nonce: string; action: DecisionAction; message?: string }

function parseDecision(raw: unknown): ParsedDecision | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.nonce !== 'string' || !NONCE_RE.test(o.nonce)) return null
  if (typeof o.sessionId !== 'string' || !ID_RE.test(o.sessionId)) return null
  if (o.toolUseId !== null && (typeof o.toolUseId !== 'string' || !ID_RE.test(o.toolUseId))) return null
  if (o.action !== 'approve' && o.action !== 'deny' && o.action !== 'redirect') return null
  if (o.message !== undefined && typeof o.message !== 'string') return null
  return { sessionId: o.sessionId, toolUseId: o.toolUseId as string | null, nonce: o.nonce, action: o.action, message: o.message as string | undefined }
}

/** Free text for Claude: control characters (newlines kept) and invisible/bidi marks removed, trimmed, capped. */
function cleanMessage(value: string | undefined): string {
  if (!value) return ''
  return value.replace(CONTROL_TEXT, '').trim().slice(0, PERMISSION_MESSAGE_MAX)
}
