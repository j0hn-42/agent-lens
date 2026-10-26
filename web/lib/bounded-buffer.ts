/**
 * Bounded append-only buffers trimmed in batches (#659).
 *
 * `splice(0, 1)` on a full buffer moves every remaining element, at every append (206 us for 50 000 events,
 * measured). Letting the buffer overshoot its cap by a fraction and trimming back to the cap in one go makes
 * the cost amortized O(1) per append: one move of `cap` elements every `cap * slack` appends.
 */

/** Fraction of the cap the buffer may overshoot before it is trimmed back to the cap. */
const ALL_BUFFER_SLACK = 0.1

// ─── Byte caps (#659) ─────────────────────────────────────────────────────────────────────────────────────────
//
// A count cap alone does not bound memory: measured in a real browser (tests-a11y/e2e/heap-measure.ts), the 50
// session buffers full at 5000 events plus the 'All' buffer retained 314 MB with the payload caps of the
// extension's parser (about 1.3 KB of heap per event). The byte caps below bound the estimated size instead.

/** Estimated sizes, computed once per event object (the 'All' and session buffers share the same objects). */
const sizes = new WeakMap<object, number>()
/** Running estimated size of each buffer fed through pushBounded (a new array starts at 0). */
const tallies = new WeakMap<object, number>()

/** Fallback when an event cannot be serialized (never seen from the bridge: its events are structured clones). */
const UNSERIALIZABLE_EVENT_BYTES = 1024

/**
 * Estimated heap size of an event: the length of its JSON. Strings of the bridge are one byte per character in
 * V8 (Latin-1) or two; the measurement gives 1319 heap bytes for 1239 JSON characters on average, so the length
 * is a close, slightly low estimate. Cached per object.
 */
export function estimateEventBytes(ev: object): number {
  const known = sizes.get(ev)
  if (known !== undefined) return known
  let n: number
  try { n = JSON.stringify(ev)?.length ?? 0 } catch { n = UNSERIALIZABLE_EVENT_BYTES }
  sizes.set(ev, n)
  return n
}

/**
 * Appends `item`, then trims the oldest elements in one batch once the buffer passes `cap` elements or `capBytes`
 * estimated bytes by more than the slack, back under both. The newest element is always kept. Returns how many were
 * dropped; the caller adds it to its base offset, so every drop is counted. `onDrop` receives the dropped elements, oldest
 * first (the bridge counts them per session, #613).
 */
export function pushBounded<T extends object>(
  buf: T[], item: T, cap: number, capBytes: number, slack: number = ALL_BUFFER_SLACK, onDrop?: (dropped: readonly T[]) => void,
): number {
  buf.push(item)
  let bytes = (tallies.get(buf) ?? 0) + estimateEventBytes(item)
  let over = 0
  if (buf.length > cap + Math.floor(cap * slack) || bytes > capBytes + Math.floor(capBytes * slack)) {
    while (over < buf.length - 1 && (buf.length - over > cap || bytes > capBytes)) {
      bytes -= estimateEventBytes(buf[over])
      over++
    }
    if (over > 0) {
      const dropped = buf.splice(0, over)
      onDrop?.(dropped)
    }
  }
  tallies.set(buf, bytes)
  return over
}
