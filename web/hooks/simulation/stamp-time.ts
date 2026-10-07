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

/** Playback speed that applies: outside review the clock always runs at 1x (speed would distort the live time axis). */
export function effectiveSpeed(speed: number, isReviewing: boolean): number {
  return isReviewing && Number.isFinite(speed) && speed > 0 ? speed : 1
}

/**
 * Seconds to add to each session's event times so sessions share one wall-clock axis in union views.
 * Events carry time relative to their own session start (`startTime`, ms); the oldest session is the origin.
 */
export function computeSessionOffsets(
  sessions: ReadonlyArray<{ id: string; startTime: number }>,
): Map<string, number> {
  const valid = sessions.filter(s => Number.isFinite(s.startTime) && s.startTime > 0)
  const offsets = new Map<string, number>()
  if (valid.length === 0) return offsets
  const origin = Math.min(...valid.map(s => s.startTime))
  for (const s of valid) offsets.set(s.id, (s.startTime - origin) / 1000)
  return offsets
}

/** Shift events onto the common axis; events of unknown sessions (or none) are left as they are. */
export function applySessionOffsets<T extends { time: number; sessionId?: string }>(
  events: readonly T[],
  offsets: ReadonlyMap<string, number> | undefined,
): T[] {
  if (!offsets || offsets.size === 0) return events.slice()
  return events.map(e => {
    const off = e.sessionId ? offsets.get(e.sessionId) : undefined
    // Events without a usable time keep it: stampEventTimes gives them the current time
    return off && Number.isFinite(e.time) && e.time > 0 ? { ...e, time: e.time + off } : e
  })
}
