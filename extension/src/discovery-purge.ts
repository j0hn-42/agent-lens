/**
 * Removal of stale discovery files ({hash}-{pid}.json) left behind by crashed instances (#144).
 * hook.js cannot trust process.kill(pid, 0) on Windows, so liveness is decided here: a dead pid
 * (POSIX) or a port that refuses the connection (every platform) means the file is stale.
 * vscode-free: shared by the extension and the standalone relay. Never throws.
 */
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { discoveryDir } from './claude-config-dir'
import { createLogger } from './logger'

const log = createLogger('Discovery')

/** 'refused' is the only definitive "nobody listens"; 'unknown' (timeout, other errors) keeps the file. */
export type PortProbe = 'open' | 'refused' | 'unknown'

export function probePort(port: number, timeoutMs = 500): Promise<PortProbe> {
  return new Promise(resolve => {
    let settled = false
    const done = (result: PortProbe) => {
      if (settled) { return }
      settled = true
      socket.destroy()
      resolve(result)
    }
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs, () => done('unknown'))
    socket.once('connect', () => done('open'))
    socket.once('error', err => done((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'unknown'))
  })
}

/** False only when the pid certainly does not exist. EPERM means it exists but is not ours. */
export function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export interface PurgeOptions {
  dir?: string
  selfPid?: number
  platform?: NodeJS.Platform
  probe?: (port: number) => Promise<PortProbe>
  pidGone?: (pid: number) => boolean
}

/** Delete discovery files whose instance is gone. Returns the removed file names. */
export async function purgeStaleDiscoveryFiles(opts: PurgeOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? discoveryDir()
  const selfPid = opts.selfPid ?? process.pid
  const platform = opts.platform ?? process.platform
  const probe = opts.probe ?? probePort
  const pidGone = opts.pidGone ?? isPidGone
  const removed: string[] = []

  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'workspaces.json')
  } catch {
    return removed
  }

  for (const file of files) {
    try {
      const filePath = path.join(dir, file)
      const d = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { pid?: unknown; port?: unknown }
      if (typeof d.pid !== 'number' || typeof d.port !== 'number') { continue }
      if (d.pid === selfPid) { continue }

      // Windows: pid checks are unreliable, rely on the port alone.
      const stale = (platform !== 'win32' && pidGone(d.pid)) || (await probe(d.port)) === 'refused'
      if (!stale) { continue }
      fs.unlinkSync(filePath)
      removed.push(file)
    } catch { /* unreadable or already removed by a concurrent purge: leave it */ }
  }
  if (removed.length) { log.info(`Purged ${removed.length} stale discovery file(s): ${removed.join(', ')}`) }
  return removed
}
