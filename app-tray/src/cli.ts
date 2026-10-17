/**
 * Command line of the tray driver (#335).
 *   node --import tsx app-tray/src/cli.ts --tray-bin <path> [--attach <port>] [--relay-entry <app.js>]
 * Without --attach, the driver starts the relay (`app/dist/app.js --port 0 --no-open`) and owns it.
 * With --attach <port>, it only queries a relay already listening on 127.0.0.1:<port>.
 * Exit codes: 0 quit, 1 failure while running, 2 bad command line.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '../../web/lib/messages'
import { startDriver, type DriverOptions } from './driver'

export type CliArgs =
  | { ok: true; trayBin: string; attach: number | null; relayEntry: string | undefined }
  | { ok: false; error: string }

const USAGE = 'usage: cli.ts --tray-bin <path> [--attach <port>] [--relay-entry <app.js>]   (or AGENT_LENS_TRAY_BIN)'

const value = (next: string | undefined): string | undefined => (next === undefined || next.startsWith('-') ? undefined : next)

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): CliArgs {
  let trayBin = env.AGENT_LENS_TRAY_BIN || undefined
  let attach: number | null = null
  let relayEntry: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const v = value(argv[i + 1])
    if (arg === '--tray-bin' || arg === '--attach' || arg === '--relay-entry') {
      if (v === undefined) return { ok: false, error: `${arg} needs a value` }
      i++
      if (arg === '--tray-bin') trayBin = v
      else if (arg === '--relay-entry') relayEntry = v
      else {
        const n = Number(v)
        if (!/^\d+$/.test(v) || n < 1 || n > 65535) return { ok: false, error: '--attach needs a port between 1 and 65535' }
        attach = n
      }
    } else {
      return { ok: false, error: `unknown option ${arg}` }
    }
  }
  if (!trayBin) return { ok: false, error: '--tray-bin is required' }
  return { ok: true, trayBin, attach, relayEntry }
}

/** The system language decides the labels: French when it says so, English otherwise. */
export function localeFromEnv(env: NodeJS.ProcessEnv): Locale {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  return /^fr/i.test(raw) ? 'fr' : 'en'
}

export function main(argv: string[], env: NodeJS.ProcessEnv): void {
  const args = parseCliArgs(argv, env)
  if (!args.ok) {
    console.error(`${args.error}\n${USAGE}`)
    process.exit(2)
  }
  const relayEntry = path.resolve(args.relayEntry ?? path.join(__dirname, '../../app/dist/app.js'))
  if (args.attach === null && !fs.existsSync(relayEntry)) {
    console.error(`${relayEntry} not found: run "pnpm run build:app" first, or use --attach <port>`)
    process.exit(2)
  }
  const options: DriverOptions = {
    relay: args.attach !== null
      ? { attach: args.attach }
      : { spawn: { file: process.execPath, args: [relayEntry, '--port', '0', '--no-open'] } },
    tray: { file: args.trayBin, args: [] },
    locale: localeFromEnv(env),
    log: message => console.error(`agent-lens-tray: ${message}`),
  }
  const driver = startDriver(options)
  // The same path as the quit item. On Windows SIGTERM cannot be handled by the relay (see docs/tray.md).
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => driver.stop())
  void driver.done.then(code => process.exit(code))
}

if (require.main === module) main(process.argv.slice(2), process.env)
