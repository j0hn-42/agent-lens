import type { SystemSample, SystemUsage } from './bridge-types'

export const SYSTEM_HISTORY = 60
const MAX_CORES = 256
const MAX_NOTE = 200

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const share = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

function usage(v: unknown): SystemUsage | null {
  if (!isRecord(v)) return null
  const total = num(v.total), used = num(v.used)
  if (total === null || used === null || used > total) return null
  return { total, used }
}

/** An SSE `system-stats` payload is data from the network: anything out of range becomes null, nothing is clamped into a plausible figure. */
export function parseSystemSample(data: unknown): SystemSample | null {
  if (!isRecord(data)) return null
  const ts = num(data.ts)
  if (ts === null) return null
  const cpu = isRecord(data.cpu) ? data.cpu : {}
  const perCore = Array.isArray(cpu.perCore) ? cpu.perCore.slice(0, MAX_CORES).map(share) : []
  const load = Array.isArray(data.load) && data.load.length === 3 && data.load.every(x => num(x) !== null)
    ? [data.load[0], data.load[1], data.load[2]] as [number, number, number] : null
  return {
    ts,
    cpu: { total: share(cpu.total), perCore },
    mem: usage(data.mem), swap: usage(data.swap), disk: usage(data.disk),
    load, uptime: num(data.uptime),
    platformNote: typeof data.platformNote === 'string' ? data.platformNote.slice(0, MAX_NOTE) : null,
  }
}

export function pushSample(buffer: readonly SystemSample[], sample: SystemSample): SystemSample[] {
  const next = [...buffer, sample]
  return next.length > SYSTEM_HISTORY ? next.slice(next.length - SYSTEM_HISTORY) : next
}

export type Severity = 'normal' | 'warm' | 'critical' | 'unknown'
export const WARM_AT = 0.85
export const CRITICAL_AT = 0.95

export function severity(r: number | null): Severity {
  if (r === null) return 'unknown'
  return r >= CRITICAL_AT ? 'critical' : r >= WARM_AT ? 'warm' : 'normal'
}

export function ratio(u: SystemUsage | null): number | null {
  return u && u.total > 0 ? u.used / u.total : null
}

export function summarise(buffer: readonly SystemSample[], pick: (s: SystemSample) => number | null): { current: number | null; max: number | null } {
  let max: number | null = null
  for (const s of buffer) { const v = pick(s); if (v !== null && (max === null || v > max)) max = v }
  return { current: buffer.length ? pick(buffer[buffer.length - 1]) : null, max }
}
