import type { AgentEvent, ExtensionToWebviewMessage } from './protocol'

/** How long the panel holds an event before sending it (#656): one frame, so a burst goes in a few messages */
export const PANEL_EVENT_FLUSH_MS = 16
/** At most this many events per `agent-event-batch` of the panel: a fuller buffer is sent at once (#656) */
export const PANEL_EVENT_BATCH_MAX = 500

export interface EventCoalescerOptions {
  /** Sends one message to the page */
  post: (message: ExtensionToWebviewMessage) => void
  maxBatch?: number
  /** Timer, injectable for tests (default setTimeout / clearTimeout) */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

/**
 * The events of the VS Code panel, coalesced (#656). An attach burst was one postMessage per event, each one
 * serialized by the extension host, parsed by the renderer and cloned again into the webview. Events pushed within
 * one window of PANEL_EVENT_FLUSH_MS go as one `agent-event-batch` marked `live` (the page keeps each event's own
 * `replayed` flag, see web/lib/vscode-bridge.ts), a lone event as the `agent-event` it always was.
 * Order: every other message goes through `post`, which flushes the buffer first.
 */
export class EventCoalescer {
  private buffer: AgentEvent[] = []
  private timer: unknown = null
  private disposed = false
  private readonly maxBatch: number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void

  constructor(private readonly opts: EventCoalescerOptions) {
    this.maxBatch = Math.max(1, opts.maxBatch ?? PANEL_EVENT_BATCH_MAX)
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  push(event: AgentEvent): void {
    if (this.disposed) return
    this.buffer.push(event)
    if (this.buffer.length >= this.maxBatch) { this.flush(); return }
    if (this.timer === null) this.timer = this.schedule(() => { this.timer = null; this.flush() }, PANEL_EVENT_FLUSH_MS)
  }

  /** Sends what is buffered now, in order */
  flush(): void {
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null }
    const events = this.buffer
    if (events.length === 0) return
    this.buffer = []
    if (events.length === 1) { this.opts.post({ type: 'agent-event', event: events[0] }); return }
    for (let i = 0; i < events.length; i += this.maxBatch) {
      this.opts.post({ type: 'agent-event-batch', events: events.slice(i, i + this.maxBatch), live: true })
    }
  }

  /** Any message other than an event: after the events pushed before it */
  post(message: ExtensionToWebviewMessage): void {
    if (this.disposed) return
    this.flush()
    this.opts.post(message)
  }

  /** The panel is closed: what is buffered is dropped, nothing more is sent */
  dispose(): void {
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null }
    this.buffer = []
    this.disposed = true
  }
}
