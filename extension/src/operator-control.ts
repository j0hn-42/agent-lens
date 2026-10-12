/**
 * Operator control of the VS Code extension (#240, PR 3): ties the permission gate to the Agent Lens panel.
 * The only channel to the panel is postMessage; there is no HTTP route a web page could call. No `vscode` import:
 * the caller passes the setting, the panel and the journal location.
 *
 * Off by default (`agentVisualizer.allowControl`). Even when on, a request is held only while a panel that declared
 * a decision surface (`permission-surface`) is open: with nothing able to answer, Claude Code is not kept waiting.
 */
import { DecisionJournal } from './decision-journal'
import { PermissionGate, type PermissionRequestView, type GateClosed } from './permission-gate'
import { DECISION_JOURNAL_MAX_BYTES } from './constants'
import { randomBytes } from 'crypto'
import type { ExtensionToWebviewMessage } from './protocol'

/** What the control needs from the panel */
export interface ControlPanel {
  readonly isReady: boolean
  /** Set by the control when the page says it can show and answer requests */
  controlSurface: boolean
  postMessage(message: ExtensionToWebviewMessage): void
}

export interface OperatorControlOptions {
  /** The `agentVisualizer.allowControl` setting, read at each use */
  allowed: () => boolean
  getPanel: () => ControlPanel | undefined
  journalFile: string
  ttlMs?: number
}

const NONCE_RE = /^[0-9a-f]{32}$/

let current: OperatorControl | undefined
/** The control of this extension host, set by the Claude runtime; undefined when the runtime did not start it */
export function getOperatorControl(): OperatorControl | undefined { return current }
export function setOperatorControl(control: OperatorControl | undefined): void { current = control }

export class OperatorControl {
  readonly gate: PermissionGate
  /** Per start. It goes to the 0600 discovery file only while the control is on; the hook presents it to the hook server. */
  readonly token = randomBytes(32).toString('hex')

  constructor(private readonly opts: OperatorControlOptions) {
    this.gate = new PermissionGate({
      enabled: opts.allowed,
      canDecide: () => { const p = opts.getPanel(); return !!p && p.isReady && p.controlSurface },
      journal: new DecisionJournal(opts.journalFile, DECISION_JOURNAL_MAX_BYTES),
      ttlMs: opts.ttlMs,
    })
    this.gate.onRequest(v => this.toSurface(p => p.postMessage({ type: 'permission-request', request: toMessage(v) })))
    this.gate.onClosed(c => this.toSurface(p => p.postMessage(closedMessage(c))))
  }

  /** The token to publish in the discovery file: none while the setting is off, so the hook script never connects */
  discoveryToken(): string | undefined {
    return this.opts.allowed() ? this.token : undefined
  }

  /** Handles `permission-surface` and `permission-decision` from a panel; other messages are not its business. */
  handlePanelMessage(panel: ControlPanel, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const msg = raw as Record<string, unknown>
    if (msg.type === 'permission-surface') {
      const ready = msg.ready === true
      panel.controlSurface = ready
      if (ready) {
        for (const v of this.gate.pending()) panel.postMessage({ type: 'permission-request', request: toMessage(v) })
      } else {
        this.gate.cancelAll('surface-closed')
      }
      return
    }
    if (msg.type === 'permission-decision') {
      const nonce = typeof msg.nonce === 'string' && NONCE_RE.test(msg.nonce) ? msg.nonce : null
      if (!panel.controlSurface) {
        panel.postMessage({ type: 'permission-result', nonce, ok: false, reason: 'no-surface' })
        return
      }
      const result = this.gate.decide(msg)
      panel.postMessage(result.ok
        ? { type: 'permission-result', nonce, ok: true }
        : { type: 'permission-result', nonce, ok: false, reason: result.reason })
    }
  }

  /** The panel was closed: nobody can answer, so what waits ends with no decision */
  panelDisposed(): void {
    const p = this.opts.getPanel()
    if (p) p.controlSurface = false
    this.gate.cancelAll('surface-closed')
  }

  dispose(): void {
    this.gate.dispose()
  }

  private toSurface(send: (p: ControlPanel) => void): void {
    const p = this.opts.getPanel()
    if (p && p.isReady && p.controlSurface) send(p)
  }
}

function toMessage(v: PermissionRequestView) {
  return {
    sessionId: v.sessionId, toolUseId: v.toolUseId, nonce: v.nonce, toolName: v.toolName,
    inputPreview: v.inputPreview, inputTruncated: v.inputTruncated, inputSha256: v.inputSha256,
    requestedAt: v.requestedAt, expiresAt: v.expiresAt,
  }
}

function closedMessage(c: GateClosed): ExtensionToWebviewMessage {
  return { type: 'permission-closed', nonce: c.nonce, sessionId: c.sessionId, toolUseId: c.toolUseId, outcome: c.outcome }
}
