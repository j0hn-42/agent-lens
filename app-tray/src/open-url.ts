/**
 * Open the UI in the browser and copy the local URL, from the driver (#335).
 * Safety: the command is started with an argument array (never a shell) and only for the exact URL of
 * the relay, `http://127.0.0.1:<port>` or `http://localhost:<port>`. The driver builds that URL from a
 * validated port; nothing received from the native binary or from the network ever reaches a command.
 * Both functions answer true or false and never throw: a missing opener or clipboard tool is a
 * best-effort miss (Linux), not a crash.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export type SpawnLike = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface OpenDeps {
  platform?: NodeJS.Platform
  spawn?: SpawnLike
  /** An opener still running after this delay counts as started (xdg-open may stay) */
  settleMs?: number
}

const DEFAULT_SETTLE_MS = 2000

const isPort = (p: number): boolean => Number.isInteger(p) && p >= 1 && p <= 65535

/** The URL of the local relay, built from a validated port, or null. */
export function localRelayUrl(port: number): string | null {
  return isPort(port) ? `http://127.0.0.1:${port}` : null
}

/** True only for the exact loopback URL of the relay (optional trailing slash): no credential, path, query or other host. */
export function isLocalRelayUrl(raw: string, port: number): boolean {
  if (!isPort(port)) return false
  for (const host of ['127.0.0.1', 'localhost']) {
    const base = `http://${host}:${port}`
    if (raw === base || raw === `${base}/`) return true
  }
  return false
}

interface RunOptions {
  spawn: SpawnLike
  input?: string
  waitMs: number
  /** What a command still running after `waitMs` means: started (opener) or failed (clipboard) */
  runningIsOk: boolean
}

function run(file: string, args: readonly string[], opts: RunOptions): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (!ok || opts.input === undefined) child?.unref?.()
      resolve(ok)
    }
    try {
      child = opts.spawn(file, args, {
        shell: false,
        windowsHide: true,
        detached: opts.input === undefined,
        stdio: opts.input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
      })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => finish(false))
    child.on('exit', code => finish(code === 0))
    timer = setTimeout(() => {
      if (!opts.runningIsOk) child?.kill?.()
      finish(opts.runningIsOk)
    }, opts.waitMs)
    timer.unref?.()
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => finish(false))
      child.stdin.end(opts.input)
    }
  })
}

/** Open the relay URL in the default browser. */
export async function openLocalUrl(url: string, port: number, deps: OpenDeps = {}): Promise<boolean> {
  if (!isLocalRelayUrl(url, port)) return false
  const platform = deps.platform ?? process.platform
  const [file, args]: [string, string[]] =
    platform === 'darwin' ? ['open', [url]]
    // rundll32 instead of `cmd /c start`: no shell on Windows either
    : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]]
  return run(file, args, { spawn: deps.spawn ?? nodeSpawn, waitMs: deps.settleMs ?? DEFAULT_SETTLE_MS, runningIsOk: true })
}

/** Copy the relay URL to the clipboard. On Linux, wl-copy, xclip then xsel are tried: best effort. */
export async function copyLocalUrl(url: string, port: number, deps: OpenDeps = {}): Promise<boolean> {
  if (!isLocalRelayUrl(url, port)) return false
  const platform = deps.platform ?? process.platform
  const candidates: Array<[string, string[]]> =
    platform === 'darwin' ? [['pbcopy', []]]
    : platform === 'win32' ? [['clip', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
  for (const [file, args] of candidates) {
    if (await run(file, args, { spawn: deps.spawn ?? nodeSpawn, input: url, waitMs: deps.settleMs ?? DEFAULT_SETTLE_MS, runningIsOk: false })) return true
  }
  return false
}
