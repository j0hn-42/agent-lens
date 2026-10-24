/**
 * Bounded append-only buffers trimmed in batches (#659).
 *
 * `splice(0, 1)` on a full buffer moves every remaining element, at every append (206 us for 50 000 events,
 * measured). Letting the buffer overshoot its cap by a fraction and trimming back to the cap in one go makes
 * the cost amortized O(1) per append: one move of `cap` elements every `cap * slack` appends.
 */

/** Fraction of the cap the buffer may overshoot before it is trimmed back to the cap. */
const ALL_BUFFER_SLACK = 0.1

/**
 * Drops the oldest elements of `buf` once it exceeds `cap` by more than `cap * slack`, bringing it back to `cap`.
 * Returns how many were dropped (0 when nothing was done); the caller adds it to its base offset.
 */
export function trimOldest<T>(buf: T[], cap: number, slack: number = ALL_BUFFER_SLACK): number {
  if (buf.length <= cap + Math.floor(cap * slack)) return 0
  const over = buf.length - cap
  buf.splice(0, over)
  return over
}
