/**
 * Headless CLI (#236): `agent-lens ps | tail | statusline`.
 * Each command is a client of the local relay's HTTP data (GET /observations, GET /events, GET /statusline):
 * it adds no field of its own and never turns an unreachable relay into an empty, successful answer.
 */
import * as http from 'http'
import { DEFAULT_RELAY_PORT } from '../extension/src/constants'
import { isValidSessionId } from '../extension/src/relay-guards'

export type CliCommand = 'ps' | 'tail' | 'statusline'
const COMMANDS: readonly string[] = ['ps', 'tail', 'statusline']
export function isCliCommand(value: string | undefined): value is CliCommand { return value !== undefined && COMMANDS.includes(value) }

/** A `tail` line past this size is dropped (and counted), never cut: a truncated JSON line would be a false line. */
export const CLI_MAX_LINE_BYTES = 64 * 1024
/** An SSE message that never ends past this size is a broken stream. */
const CLI_MAX_PENDING_BYTES = 4 * 1024 * 1024
/** Request timeout for the one-shot commands (ps, statusline). */
const CLI_REQUEST_TIMEOUT_MS = 5000

export interface CliIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

export interface CliOptions {
  port: number
  session?: string
  count?: number
  timeoutMs?: number
  replay: boolean
}

export function parseCliArgs(argv: string[], env: Record<string, string | undefined>): CliOptions | { error: string } {
  const opts: CliOptions = { port: DEFAULT_RELAY_PORT, replay: false }
  const envPort = env.AGENT_LENS_PORT
  if (envPort) {
    const n = Number(envPort)
    if (Number.isInteger(n) && n > 0 && n < 65536) opts.port = n
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    const int = (min: number, max: number): number | undefined => {
      const n = next !== undefined && /^\d+$/.test(next) ? Number(next) : NaN
      return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined
    }
    if (arg === '--port' || arg === '-p') {
      const n = int(1, 65535); if (n === undefined) return { error: `invalid ${arg}: expected 1-65535` }
      opts.port = n; i++
    } else if (arg === '--count' || arg === '-n') {
      const n = int(1, 1_000_000); if (n === undefined) return { error: `invalid ${arg}: expected a positive integer` }
      opts.count = n; i++
    } else if (arg === '--timeout') {
      const n = int(1, 86_400_000); if (n === undefined) return { error: 'invalid --timeout: expected milliseconds' }
      opts.timeoutMs = n; i++
    } else if (arg === '--session') {
      if (!isValidSessionId(next)) return { error: 'invalid --session: expected a session id' }
      opts.session = next; i++
    } else if (arg === '--replay') {
      opts.replay = true
    } else {
      return { error: `unknown option: ${arg}` }
    }
  }
  return opts
}

/** GET one document from the relay. Resolves the body on 2xx; rejects with a short, user-facing reason otherwise. */
function fetchText(port: number, path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false, timeout: timeoutMs }, res => {
      if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode > 299) {
        res.resume()
        return void reject(new Error(`relay answered HTTP ${res.statusCode}`))
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > CLI_MAX_PENDING_BYTES) { req.destroy(); reject(new Error('relay answer too large')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', e => reject(e))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('relay did not answer in time')) })
    req.on('error', () => reject(new Error(`relay unreachable on 127.0.0.1:${port} (is Agent Lens running?)`)))
  })
}

/** Stream /events and print live `agent-event` messages as NDJSON. Resolves the exit code. */
function tail(opts: CliOptions, io: CliIo): Promise<number> {
  return new Promise(resolve => {
    const path = opts.session ? `/events?session=${encodeURIComponent(opts.session)}` : '/events'
    let printed = 0
    let dropped = 0
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const req = http.get({ host: '127.0.0.1', port: opts.port, path, agent: false, headers: { Accept: 'text/event-stream' } })
    const finish = (code: number, message?: string) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      req.destroy()
      if (dropped > 0) io.stderr.write(`agent-lens: dropped ${dropped} event(s) larger than ${CLI_MAX_LINE_BYTES} bytes\n`)
      if (message) io.stderr.write(`agent-lens: ${message}\n`)
      resolve(code)
    }
    const emit = (event: unknown) => {
      const line = JSON.stringify(event)
      if (Buffer.byteLength(line) > CLI_MAX_LINE_BYTES) { dropped++; return }
      io.stdout.write(line + '\n')
      printed++
      if (opts.count !== undefined && printed >= opts.count) finish(0)
    }
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => finish(0), opts.timeoutMs)
    req.on('response', res => {
      if (res.statusCode !== 200) { res.resume(); return finish(1, `relay answered HTTP ${res.statusCode}`) }
      res.setEncoding('utf8')
      let pending = ''
      res.on('data', (chunk: string) => {
        pending += chunk
        let sep: number
        while (!done && (sep = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, sep)
          pending = pending.slice(sep + 2)
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
          if (!data) continue // keep-alive comment
          let msg: { type?: unknown; event?: unknown; events?: unknown }
          try { msg = JSON.parse(data) } catch { continue }
          if (msg.type === 'agent-event' && msg.event) emit(msg.event)
          else if (opts.replay && msg.type === 'agent-event-batch' && Array.isArray(msg.events)) for (const e of msg.events) { if (done) break; emit(e) }
        }
        if (!done && pending.length > CLI_MAX_PENDING_BYTES) finish(1, 'event stream message too large')
      })
      res.on('end', () => finish(1, 'relay closed the stream'))
      res.on('error', () => finish(1, 'event stream error'))
    })
    req.on('error', () => finish(1, `relay unreachable on 127.0.0.1:${opts.port} (is Agent Lens running?)`))
  })
}

/** Run one command; resolves the process exit code (0 ok, 1 relay problem, 2 usage). */
export async function runCli(command: CliCommand, argv: string[], io: CliIo, env: Record<string, string | undefined>): Promise<number> {
  const opts = parseCliArgs(argv, env)
  if ('error' in opts) { io.stderr.write(`agent-lens ${command}: ${opts.error}\n`); return 2 }
  if (command === 'tail') return tail(opts, io)
  const timeout = opts.timeoutMs ?? CLI_REQUEST_TIMEOUT_MS
  try {
    if (command === 'ps') {
      const body = await fetchText(opts.port, '/observations?agents=1', timeout)
      // Re-serialized so that the output is exactly one JSON document, or an error
      io.stdout.write(JSON.stringify(JSON.parse(body)) + '\n')
    } else {
      io.stdout.write(await fetchText(opts.port, '/statusline', timeout))
    }
    return 0
  } catch (e) {
    io.stderr.write(`agent-lens ${command}: ${e instanceof SyntaxError ? 'relay answered something that is not JSON' : (e as Error).message}\n`)
    return 1
  }
}
