// scripts/system-stats.ts
/**
 * Machine health sample for the System panel (#357). Every figure is measured or null: a metric that
 * cannot be read is never replaced by 0 (docs/reading-the-ui.md). Reads are injected (SystemIo) so the
 * logic is testable without a real machine.
 */
import fs from 'node:fs'
import os from 'node:os'

export interface Usage { total: number; used: number }

export interface SystemSample {
  ts: number
  cpu: { total: number | null; perCore: (number | null)[] }
  mem: Usage | null
  swap: Usage | null
  disk: Usage | null
  load: [number, number, number] | null
  uptime: number | null
  platformNote: string | null
}

export interface CpuCounters { idle: number; total: number }

export interface SystemIo {
  now(): number
  cpus(): { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]
  loadavg(): number[]
  uptime(): number
  totalmem(): number
  freemem(): number
  platform: string
  readText(path: string): string | null
  statfs(path: string): { blocks: number; bsize: number; bavail: number } | null
  cwd: string
}

type StatfsResult = { blocks: number; bsize: number; bavail: number }

/** Test seams: the async statfs and the text reader can be replaced. */
export interface NodeIoOverrides {
  statfs?: (path: string) => Promise<StatfsResult>
  readText?: (path: string) => string | null
}

const realStatfs = async (p: string): Promise<StatfsResult> => {
  const s = await fs.promises.statfs(p)
  return { blocks: Number(s.blocks), bsize: Number(s.bsize), bavail: Number(s.bavail) }
}

export function nodeIo(over: NodeIoOverrides = {}): SystemIo {
  const read = over.readText ?? ((p: string) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } })
  const asyncStatfs = over.statfs ?? realStatfs
  // /proc/version never changes while the relay runs: read it once.
  let version: { text: string | null } | undefined
  // The disk is read in the background (a hung network mount must not freeze the relay event loop), one request
  // in flight at most; the sampler gets the last known figure, null before the first result and after a failure.
  let diskCache: StatfsResult | null = null
  let inFlight = false
  return {
    now: () => Date.now(),
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    uptime: () => os.uptime(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    platform: process.platform,
    readText: (p) => {
      if (p !== '/proc/version') return read(p)
      return (version ??= { text: read(p) }).text
    },
    statfs: (p) => {
      if (!inFlight) {
        inFlight = true
        asyncStatfs(p).then(
          (r) => { diskCache = r; inFlight = false },
          () => { diskCache = null; inFlight = false },
        )
      }
      return diskCache
    },
    cwd: process.cwd(),
  }
}

/** Run one read; a failing read yields null for that metric only. */
function safe<T>(read: () => T | null): T | null {
  try { return read() } catch { return null }
}

const toCounters = (t: { user: number; nice: number; sys: number; idle: number; irq: number }): CpuCounters =>
  ({ idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq })

/** Busy share (0..1) between two readings; null when there is no valid delta. */
function busyShare(prev: CpuCounters | undefined, cur: CpuCounters): number | null {
  if (!prev) return null
  const total = cur.total - prev.total
  const idle = cur.idle - prev.idle
  if (!(total > 0) || idle < 0 || idle > total) return null
  return 1 - idle / total
}

function parseMeminfo(text: string | null): Record<string, number> | null {
  if (!text) return null
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line)
    if (m) out[m[1]] = Number(m[2]) * 1024
  }
  return out
}

export function sampleSystem(prev: CpuCounters[] | null, io: SystemIo): { sample: SystemSample; counters: CpuCounters[] } {
  const counters = (safe(() => io.cpus().map(c => toCounters(c.times))) ?? [])
  const perCore = counters.map((c, i) => busyShare(prev?.[i], c))
  const total = (() => {
    if (!prev || counters.length === 0 || prev.length !== counters.length) return null
    const dTotal = counters.reduce((sum, c, i) => sum + (c.total - prev[i].total), 0)
    const dIdle = counters.reduce((sum, c, i) => sum + (c.idle - prev[i].idle), 0)
    return dTotal > 0 && dIdle >= 0 && dIdle <= dTotal ? 1 - dIdle / dTotal : null
  })()

  const linux = io.platform === 'linux'
  const info = linux ? safe(() => parseMeminfo(io.readText('/proc/meminfo'))) : null

  const mem = safe((): Usage | null => {
    if (linux) {
      if (!info || info.MemTotal === undefined || info.MemAvailable === undefined) return null
      return { total: info.MemTotal, used: info.MemTotal - info.MemAvailable }
    }
    // macOS: libuv's free memory excludes inactive/purgeable/cache pages, so "used" would read 90-99 %: not provable.
    if (io.platform === 'darwin') return null
    const t = io.totalmem()
    return { total: t, used: t - io.freemem() }
  })

  const swap = safe((): Usage | null => {
    if (!info || info.SwapTotal === undefined || info.SwapFree === undefined) return null
    return { total: info.SwapTotal, used: info.SwapTotal - info.SwapFree }
  })

  const disk = safe((): Usage | null => {
    const s = io.statfs(io.cwd)
    if (!s) return null
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize }
  })

  const load = safe((): [number, number, number] | null => {
    if (io.platform === 'win32') return null
    const l = io.loadavg()
    return [l[0], l[1], l[2]]
  })

  const platformNote = safe(() => /microsoft/i.test(io.readText('/proc/version') ?? '')
    ? 'WSL2: values of the Linux VM, not of Windows' : null)

  return {
    counters,
    sample: { ts: io.now(), cpu: { total, perCore }, mem, swap, disk, load, uptime: safe(() => io.uptime()), platformNote },
  }
}
