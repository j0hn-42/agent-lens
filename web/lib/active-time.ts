/**
 * Real active time of an agent (issue #59): the time spent working, without the pauses between two
 * turns. Pure (no React, no DOM, no clock of its own): every time is passed in.
 *
 *   ActiveTimeTracker  accumulates start/stop events (or periodic samples) into a total
 *   createChrono       a live counter driven by a monotonic clock, immune to wall-clock jumps
 *   activeSinceText    the visible "active for X", or an explicit unknown
 */
import type { Freshness } from '../hooks/simulation/freshness'

/** A sampling tracker never bridges a hole longer than this (ms): the time in between is unknown */
export const SAMPLE_GAP_MAX_MS = 15_000
/** The live chrono stops growing here (ms) so a lost "stop" cannot show days of activity */
export const CHRONO_CAP_MS = 24 * 3_600_000

/** Text shown when the active time is not known (never "0:00"). */
export const ACTIVE_UNKNOWN_TEXT = 'active time unknown'

/** States in which the agent is working (waiting for a permission or idle is a pause). */
export function isActiveState(state: string): boolean {
  return state === 'thinking' || state === 'tool_calling'
}

/** The persisted part of the tracker, stored on the agent. */
export interface ActiveTimeFields {
  /** Closed active spans, ms; absent = nothing observed */
  activeMs?: number
  /** Wall-clock ms when the running span started; absent = not running */
  activeSince?: number
}

export class ActiveTimeTracker {
  private closedMs = 0
  private runStart: number | null = null
  private observed = false
  private lastSample: { at: number; active: boolean } | null = null
  /** Number of sampling holes (longer than SAMPLE_GAP_MAX_MS) that were not bridged */
  gaps = 0

  static from(fields: ActiveTimeFields): ActiveTimeTracker {
    const t = new ActiveTimeTracker()
    if (typeof fields.activeMs === 'number' && Number.isFinite(fields.activeMs)) {
      t.closedMs = Math.max(0, fields.activeMs)
      t.observed = true
    }
    if (typeof fields.activeSince === 'number' && Number.isFinite(fields.activeSince)) {
      t.runStart = fields.activeSince
      t.observed = true
    }
    return t
  }

  /** Start of the running span (ms), null when not running. */
  get activeSince(): number | null { return this.runStart }

  /** Work begins; a start while already running is ignored. */
  start(at: number): void {
    if (this.runStart !== null || !Number.isFinite(at)) return
    this.runStart = at
    this.observed = true
  }

  /** Work ends; a stop without a start is ignored, a stop before the start adds nothing. */
  stop(at: number): void {
    if (this.runStart === null || !Number.isFinite(at)) return
    this.closedMs += Math.max(0, at - this.runStart)
    this.runStart = null
  }

  /**
   * Periodic observation. The time since the previous sample counts when that sample was active and
   * the hole is at most SAMPLE_GAP_MAX_MS; a longer hole is never filled in.
   */
  sample(at: number, active: boolean): void {
    if (!Number.isFinite(at)) return
    const prev = this.lastSample
    if (prev?.active) {
      const gap = at - prev.at
      if (gap < 0) { /* clock went back: nothing to add */ }
      else if (gap <= SAMPLE_GAP_MAX_MS) this.closedMs += gap
      else this.gaps++
    }
    this.observed = true
    this.lastSample = { at, active }
  }

  /** Active ms at `now` (an open span counts up to now); null when nothing was ever observed. */
  totalMs(now: number): number | null {
    if (!this.observed) return null
    return this.closedMs + (this.runStart !== null ? Math.max(0, now - this.runStart) : 0)
  }

  fields(): ActiveTimeFields {
    if (!this.observed) return {}
    return this.runStart !== null ? { activeMs: this.closedMs, activeSince: this.runStart } : { activeMs: this.closedMs }
  }
}

/**
 * New active-time fields of an agent whose state changed at wall-clock `at`. A `before` without
 * fields on an agent that is not working stays unknown (nothing was observed).
 */
export function advanceActiveTime(before: ActiveTimeFields, working: boolean, at: number): ActiveTimeFields {
  const t = ActiveTimeTracker.from(before)
  if (working) t.start(at)
  else t.stop(at)
  return t.fields()
}

export interface Chrono {
  /** Elapsed ms, capped at CHRONO_CAP_MS */
  elapsedMs(): number
  /** True once the cap is reached (the display then reads "+") */
  capped(): boolean
}

/**
 * Live counter. The elapsed time at creation comes from the wall clock once; from then on only the
 * monotonic clock moves it, so a wall-clock change (NTP step, DST, manual change) never shifts it.
 * A start in the future (skewed clock) reads 0.
 */
export function createChrono(opts: { startedAt: number; wallNow: number; monotonic: () => number }): Chrono {
  const base = Number.isFinite(opts.startedAt) && Number.isFinite(opts.wallNow) ? Math.max(0, opts.wallNow - opts.startedAt) : 0
  const mono0 = opts.monotonic()
  const raw = () => base + Math.max(0, opts.monotonic() - mono0)
  return {
    elapsedMs: () => Math.min(CHRONO_CAP_MS, raw()),
    capped: () => raw() >= CHRONO_CAP_MS,
  }
}

/** "1:05", "1:02:05"; a trailing "+" when the value hit the cap. */
export function formatActiveSince(ms: number, capped = false): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const ss = (total % 60).toString().padStart(2, '0')
  const text = h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
  return capped ? `${text}+` : text
}

/**
 * "active for 1:05" - only valid while the source is fresh (a stale, closed or never-observed agent
 * proves nothing) and the start is known; otherwise the explicit unknown text.
 */
export function activeSinceText(agent: Pick<ActiveTimeFields, 'activeSince'>, freshness: Freshness, now: number): string {
  const since = agent.activeSince
  if (freshness !== 'fresh' || typeof since !== 'number' || !Number.isFinite(since)) return ACTIVE_UNKNOWN_TEXT
  const ms = Math.max(0, now - since)
  return `active for ${formatActiveSince(Math.min(ms, CHRONO_CAP_MS), ms >= CHRONO_CAP_MS)}`
}
