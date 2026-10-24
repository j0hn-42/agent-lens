/**
 * VS Code Bridge — enables the visualizer to communicate with the VS Code extension host.
 *
 * When running standalone (npm run dev), this is a no-op.
 * When running inside a VS Code webview iframe, it forwards messages
 * between the React app and the extension host.
 */

export type { AgentEvent, SessionInfo, ConnectionStatus, BridgeNotice } from './bridge-types'
import { parseEventLoss, acceptEventLoss, type EventLoss } from './event-loss'
export { ALL_SESSIONS_ID } from './bridge-types'
export type { PermissionRequestMessage, PermissionDecision } from './bridge-types'
import type { AgentEvent, SessionInfo, ConnectionStatus, PermissionRequestMessage, PermissionDecision } from './bridge-types'
import {
  isAgentEvent, isSessionInfo, isConnectionStatus, sanitizeSessionInfo,
  parsePermissionRequest, parsePermissionClosed, parsePermissionResult,
} from './bridge-types'

/** Operator decisions (#240): what the extension says about waiting PermissionRequests, validated */
export type PermissionBridgeMessage =
  | { kind: 'request'; request: PermissionRequestMessage }
  | { kind: 'closed'; nonce: string; sessionId: string; toolUseId: string | null; outcome: string }
  | { kind: 'result'; nonce: string | null; ok: boolean; reason?: string }
type PermissionCallback = (message: PermissionBridgeMessage) => void

type InitCallback = () => void
type EventCallback = (event: AgentEvent) => void
type StatusCallback = (status: ConnectionStatus, source: string) => void
type ConfigCallback = (config: Partial<{ mode: string; autoPlay: boolean; showMockData: boolean; disable1MContext: boolean; hooksConfigured: boolean }>) => void
/** The relay changed what it scans (#291): `allWorkspaces` is its new scope, to be confirmed with GET /status */
type RelayScopeCallback = (allWorkspaces: boolean) => void
/** What the extension says the page lacks (#592), validated; null after a reset */
type EventLossCallback = (loss: EventLoss | null) => void
type SessionCallback = (type: 'list' | 'started' | 'ended' | 'updated' | 'reset', data: SessionInfo[] | SessionInfo | string | { sessionId: string; label: string }) => void

class VSCodeBridge {
  private _isVSCode = false
  private _status: ConnectionStatus = 'connecting'
  private _source = ''

  private initListeners: InitCallback[] = []
  private eventListeners: EventCallback[] = []
  private statusListeners: StatusCallback[] = []
  private configListeners: ConfigCallback[] = []
  private sessionListeners: SessionCallback[] = []
  private relayScopeListeners: RelayScopeCallback[] = []
  private permissionListeners: PermissionCallback[] = []
  private eventLossListeners: EventLossCallback[] = []
  /** Last `event-loss` of the extension for the current page (#592): kept, so a view that mounts later still reads it */
  private _eventLoss: EventLoss | null = null

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.handleMessage)
    }
  }

  private handleMessage = (e: MessageEvent) => {
    // Only the embedding frame may drive the bridge. A top-level page (standalone app)
    // or any other window (window.open opener, sibling frame) must not be able to
    // switch it to VS Code mode or inject events.
    if (window.parent === window || e.source !== window.parent) { return }
    this.dispatch(e.data)
  }

  /**
   * Feeds one bridge message to the listeners. The window 'message' handler calls it after
   * checking the sender; the relay client (standalone app, dev:web) calls it directly, since
   * its payloads come from an EventSource and not from a window.
   */
  dispatch(data: any): void {
    if (!data || typeof data.type !== 'string') { return }

    switch (data.type) {
      case '__vscode-bridge-init':
        this._isVSCode = true
        this.postToExtension({ type: 'ready' })
        for (const cb of this.initListeners) cb()
        this.initListeners = [] // one-shot: no need to keep listeners after init
        break

      case 'agent-event':
        if (!isAgentEvent(data.event)) break
        for (const cb of this.eventListeners) {
          cb(data.event)
        }
        break

      case 'agent-event-batch':
        for (const event of Array.isArray(data.events) ? data.events : []) {
          if (!isAgentEvent(event)) continue
          // A batch is only ever the history the relay replays on (re)connect, never live traffic
          const replayed = { ...event, replayed: true }
          for (const cb of this.eventListeners) {
            cb(replayed)
          }
        }
        break

      case 'connection-status':
        if (!isConnectionStatus(data.status)) break
        this._status = data.status
        this._source = typeof data.source === 'string' ? data.source : ''
        for (const cb of this.statusListeners) {
          cb(this._status, this._source)
        }
        break

      case 'config':
        if (typeof data.config !== 'object' || data.config === null) break
        for (const cb of this.configListeners) {
          cb(data.config)
        }
        break

      case 'event-loss': {
        // Sent by the extension after the reset (#592): what that page will never receive; sent
        // again, lower, when a session's history read again reaches the page (panel-loss.ts). It replaces the last
        // one. In relay mode the stream's own figure is read by the hook before it reaches the bridge, and a figure
        // kept here is not read (see onEventLoss).
        const next = acceptEventLoss(1, this._eventLoss, parseEventLoss(data))
        if (next === this._eventLoss) break
        this._eventLoss = next
        for (const cb of this.eventLossListeners) cb(next)
        break
      }

      case 'reset':
        // A new graph: the figure of the old one no longer describes it
        if (this._eventLoss !== null) {
          this._eventLoss = null
          for (const cb of this.eventLossListeners) cb(null)
        }
        for (const cb of this.sessionListeners) {
          cb('reset', typeof data.reason === 'string' && data.reason ? data.reason : 'panel-reopened')
        }
        break

      case 'session-list': {
        const sessions: SessionInfo[] = Array.isArray(data.sessions) ? data.sessions.filter(isSessionInfo).map(sanitizeSessionInfo) : []
        for (const cb of this.sessionListeners) {
          cb('list', sessions)
        }
        break
      }

      case 'session-started':
        if (!isSessionInfo(data.session)) break
        for (const cb of this.sessionListeners) {
          cb('started', sanitizeSessionInfo(data.session))
        }
        break

      case 'session-ended':
        if (typeof data.sessionId !== 'string') break
        for (const cb of this.sessionListeners) {
          cb('ended', data.sessionId)
        }
        break

      case 'relay-scope':
        if (typeof data.allWorkspaces !== 'boolean') break
        for (const cb of this.relayScopeListeners) cb(data.allWorkspaces)
        break

      case 'session-updated':
        if (typeof data.sessionId !== 'string' || typeof data.label !== 'string') break
        for (const cb of this.sessionListeners) {
          cb('updated', { sessionId: data.sessionId, label: data.label })
        }
        break

      // Operator decisions (#240): only the extension sends these, never the relay (VS Code only)
      case 'permission-request': {
        if (!this._isVSCode) break
        const request = parsePermissionRequest(data.request)
        if (request) this.emitPermission({ kind: 'request', request })
        break
      }

      case 'permission-closed': {
        if (!this._isVSCode) break
        const closed = parsePermissionClosed(data)
        if (closed) this.emitPermission({ kind: 'closed', ...closed })
        break
      }

      case 'permission-result': {
        if (!this._isVSCode) break
        const result = parsePermissionResult(data)
        if (result) this.emitPermission({ kind: 'result', ...result })
        break
      }
    }
  }

  private emitPermission(message: PermissionBridgeMessage): void {
    for (const cb of [...this.permissionListeners]) cb(message)
  }

  get isVSCode(): boolean {
    return this._isVSCode
  }

  // ─── Subscribe to events ─────────────────────────────────────────────────

  private subscribe<T>(listeners: T[], callback: T): () => void {
    listeners.push(callback)
    return () => {
      const idx = listeners.indexOf(callback)
      if (idx >= 0) listeners.splice(idx, 1)
    }
  }

  /** Subscribe to bridge init. If already initialized, fires synchronously. */
  onInit(callback: InitCallback): () => void {
    if (this._isVSCode) {
      callback()
      return () => {} // already fired, nothing to unsubscribe
    }
    return this.subscribe(this.initListeners, callback)
  }

  onEvent(callback: EventCallback): () => void {
    return this.subscribe(this.eventListeners, callback)
  }

  onStatus(callback: StatusCallback): () => void {
    return this.subscribe(this.statusListeners, callback)
  }

  onConfig(callback: ConfigCallback): () => void {
    return this.subscribe(this.configListeners, callback)
  }

  onSession(callback: SessionCallback): () => void {
    return this.subscribe(this.sessionListeners, callback)
  }

  onRelayScope(callback: RelayScopeCallback): () => void {
    return this.subscribe(this.relayScopeListeners, callback)
  }

  onPermission(callback: PermissionCallback): () => void {
    return this.subscribe(this.permissionListeners, callback)
  }

  /**
   * The extension's figure of what the page lacks (#592); `eventLoss` holds the last one. Contract: it describes the
   * page only WITHOUT a relay stream. The bridge keeps whatever `event-loss` reaches it (a frame can send one in relay
   * mode too), so a reader must check that no relay stream is in use first, as useVSCodeBridge does; with a relay, the
   * relay's figure is the only one (read from the stream by the hook, never from here).
   */
  onEventLoss(callback: EventLossCallback): () => void {
    return this.subscribe(this.eventLossListeners, callback)
  }

  /** See onEventLoss: meaningful only without a relay stream */
  get eventLoss(): EventLoss | null { return this._eventLoss }

  // ─── Send commands to extension ──────────────────────────────────────────

  openFile(filePath: string, line?: number): void {
    this.postToExtension({ type: 'open-file', filePath, line })
  }

  /** Asks the extension to open a terminal in the directory it recorded for this session (#240); the webview sends no path. */
  openTerminal(sessionId: string): void {
    this.postToExtension({ type: 'open-terminal', sessionId })
  }

  /** Tells the extension whether this page can show and answer permission requests (#240) */
  sendPermissionSurface(ready: boolean): void {
    this.postToExtension({ type: 'permission-surface', ready })
  }

  /** The operator's answer to one waiting request (#240): exactly the fields the extension checks; only a redirect has a message (#387) */
  sendPermissionDecision(d: PermissionDecision): void {
    const base = { type: 'permission-decision', sessionId: d.sessionId, toolUseId: d.toolUseId, nonce: d.nonce, action: d.action }
    this.postToExtension(d.action === 'redirect' ? { ...base, message: d.message } : base)
  }

  /**
   * Declares the decision surface (#240): ready now, not ready when the returned function is called or the page
   * unloads, whichever comes first. The extension holds a request only while a surface is ready, so a page that
   * goes away must say so: otherwise Claude Code would wait for an answer nobody can give until the deadline.
   * Outside VS Code it does nothing.
   */
  attachPermissionSurface(): () => void {
    if (!this._isVSCode || typeof window === 'undefined') return () => {}
    let ready = true
    const withdraw = () => {
      if (!ready) return
      ready = false
      window.removeEventListener('pagehide', withdraw)
      window.removeEventListener('beforeunload', withdraw)
      this.sendPermissionSurface(false)
    }
    window.addEventListener('pagehide', withdraw)
    window.addEventListener('beforeunload', withdraw)
    this.sendPermissionSurface(true)
    return withdraw
  }

  /** Asks the extension for a native VS Code notification (#225); the extension validates and throttles it. */
  notify(item: { trigger: string; title: string; body: string }): void {
    this.postToExtension({ type: 'notify', trigger: item.trigger, title: item.title, body: item.body })
  }

  private postToExtension(message: Record<string, unknown>): void {
    if (this._isVSCode && typeof window !== 'undefined') {
      // When inside VS Code iframe, post to parent (the webview frame)
      window.parent.postMessage(message, '*')
    }
  }

  /** Configure the bridge for direct VS Code webview API (production build). */
  configureWebviewApi(postMessage: (msg: Record<string, unknown>) => void): void {
    this._isVSCode = true
    this.postToExtension = (msg: Record<string, unknown>) => {
      postMessage(msg)
    }
    for (const cb of this.initListeners) cb()
    this.initListeners = []
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleMessage)
    }
    this.initListeners = []
    this.eventListeners = []
    this.statusListeners = []
    this.configListeners = []
    this.sessionListeners = []
    this.relayScopeListeners = []
    this.permissionListeners = []
    this.eventLossListeners = []
  }
}

// Singleton — safe to import from anywhere
export const vscodeBridge = typeof window !== 'undefined' ? new VSCodeBridge() : null
