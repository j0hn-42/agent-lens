/**
 * The JSONL event log to the panel, counted once (#592, #605 review).
 *
 * Each connection reads the file from its first byte (event-source.ts), so connecting the same file again, or going
 * back to it (agentVisualizer.eventLogPath A -> B -> A), emits the lines counted before once more. The sessions a
 * connection emitted are released when it is disconnected, and the first read of the next connection counts as a
 * history read again: a session then counts max(before, read again) + the lines after (panel-loss.ts), never the sum.
 * Lines appended while no source was connected are part of that first read: the max takes them in.
 *
 * At most JSONL_COUNTED_SESSIONS_MAX sessions per connection are counted (and released); the events of the sessions
 * beyond are left out of the figure, which stays a lower bound.
 */
import type { AgentEvent } from './protocol'
import { forwardToPanel } from './session-runtime'
import { panelLoss } from './panel-loss'

export const JSONL_COUNTED_SESSIONS_MAX = 10_000

export interface JsonlLikeSource {
  readonly onEvent: (listener: (event: AgentEvent) => void) => { dispose(): void }
  /** True while the lines already in the file at start() are emitted */
  readonly readingExisting: boolean
}

/** Forward the source's events to the panel (also before its page is ready: the file is not read again when a page
 *  opens) and count them. Dispose it when the source is disconnected. */
export function wireJsonlSourceToPanel(source: JsonlLikeSource): { dispose(): void } {
  const counted = new Set<string>()
  const sub = source.onEvent((event) => {
    const sid = event.sessionId
    let countLoss = true
    if (typeof sid === 'string' && sid.length > 0 && !counted.has(sid)) {
      if (counted.size < JSONL_COUNTED_SESSIONS_MAX) counted.add(sid)
      else countLoss = false
    }
    forwardToPanel(event, { requireReady: false, countLoss, reread: source.readingExisting })
  })
  return {
    dispose: () => {
      sub.dispose()
      // The next connection reads these sessions from the start again: what was counted stays as a floor
      for (const sid of counted) panelLoss.release(sid)
      counted.clear()
    },
  }
}
