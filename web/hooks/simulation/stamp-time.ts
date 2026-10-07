/**
 * Stamp a batch of external events with their own time.
 *
 * Events keep their real `time` (relative to the session start) instead of all collapsing onto
 * one frame time. The log must stay sorted (seeking replays it in order), so a time is never
 * lower than the one before it: `floor` is the time of the last logged event. Events without a
 * usable time (missing, zero, non-finite) take `fallback` (the current simulation time).
 */
export function stampEventTimes<T extends { time: number }>(
  events: readonly T[],
  floor: number,
  fallback: number,
): Array<T & { time: number }> {
  let running = Number.isFinite(floor) && floor > 0 ? floor : 0
  return events.map(event => {
    const t = Number.isFinite(event.time) && event.time > 0 ? event.time : fallback
    if (t > running) running = t
    return { ...event, time: running }
  })
}

/** How many events fell off the front of a log capped at `max` after `added` more were appended. */
export function droppedFromLog(currentLength: number, added: number, max: number): number {
  return Math.max(0, currentLength + added - max)
}
