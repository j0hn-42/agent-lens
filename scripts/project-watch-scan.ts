import { WATCH_SCAN_DEBOUNCE_MS } from '../extension/src/constants'

/** Reaction of the relay to a `.jsonl` event of the project dir (#650). fs.watch fires on every line Claude
 *  writes, so: a transcript already tracked never triggers a scan (the tick covers it); an unknown file is
 *  scanned at once (a new session is found as fast as before), then at most one more scan is armed
 *  WATCH_SCAN_DEBOUNCE_MS later for the events that came in between (no endless postponement). */
export function createProjectWatchScan(opts: {
  scan: () => void
  isTracked: (sessionId: string) => boolean
  debounceMs?: number
}): { onEvent: (filename: string | null | undefined) => void; dispose: () => void } {
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

  return {
    onEvent(filename) {
      if (!filename?.endsWith('.jsonl')) return
      if (opts.isTracked(filename.slice(0, -'.jsonl'.length))) return
      if (timer) { pending = true; return }
      opts.scan()
      open()
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = false
    },
  }
}
