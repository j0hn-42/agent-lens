import { WATCH_SCAN_DEBOUNCE_MS } from '../extension/src/constants'

/** Reaction of the relay to a `.jsonl` event of the project dir (#650). fs.watch fires on every line Claude
 *  writes, so: a transcript already tracked never triggers a scan (scanTranscripts skips the ids it follows, so
 *  the scan would find nothing: a session that stops being followed is picked up by the next scan, the tick while
 *  a client is connected, or the connection of the next one); an unknown file is
 *  scanned at once (a new session is found as fast as before), then at most one more scan is armed
 *  WATCH_SCAN_DEBOUNCE_MS later for the events that came in between (no endless postponement).
 *  `request` is the same debounce for a caller that already knows a scan is needed (the wake-up of a cold
 *  transcript, #613): without it a long session over the size cap scanned on every write. */
export function createProjectWatchScan(opts: {
  scan: () => void
  isTracked: (sessionId: string) => boolean
  debounceMs?: number
}): { onEvent: (filename: string | null | undefined) => void; request: () => void; dispose: () => void } {
  const debounceMs = opts.debounceMs ?? WATCH_SCAN_DEBOUNCE_MS
  let timer: NodeJS.Timeout | null = null
  let pending = false

  const open = (): void => {
    timer = setTimeout(() => {
      timer = null
      if (!pending) return
      pending = false
      opts.scan()
      open()
    }, debounceMs)
  }

  const request = (): void => {
    if (timer) { pending = true; return }
    opts.scan()
    open()
  }

  return {
    onEvent(filename) {
      if (!filename?.endsWith('.jsonl')) return
      if (opts.isTracked(filename.slice(0, -'.jsonl'.length))) return
      request()
    },
    request,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = false
    },
  }
}
