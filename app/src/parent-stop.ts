/**
 * Stop channel of the relay for the tray driver (#513), without SIGTERM and without any network surface.
 *
 * On Windows `process.kill(pid, 'SIGTERM')` ends a Node process without running its handlers, so the relay's
 * clean-up (session_end, telemetry, discovery file) never ran when the tray driver stopped it. With the internal
 * flag --ipc-stop, and only when the parent opened a Node IPC channel when it started the relay (the
 * `'ipc'` stdio slot of child_process.spawn/fork), the relay runs the same clean-up as SIGTERM when:
 *   - the parent sends exactly `{ v: 1, type: 'stop' }` over that channel, or
 *   - the channel closes (the parent exited or was killed): the relay does not outlive the driver that owns it.
 * Anything else on the channel is ignored. Nothing here listens on a port or reads stdin: only the process that
 * created the channel can write on it. Without the flag nothing is installed and SIGINT/SIGTERM/SIGHUP behave
 * as before.
 */

/** The internal flag. Never on by default, never read from an environment variable (it would reach child processes). */
export const IPC_STOP_FLAG = '--ipc-stop'

/** The only message accepted on the channel */
export const STOP_MESSAGE = Object.freeze({ v: 1, type: 'stop' } as const)

/** Fixed diagnostic lines for ignored messages; never their content */
const MAX_IGNORED_LOGS = 3

/** True only for a plain object with exactly the two keys of STOP_MESSAGE and their exact values. */
export function isStopMessage(m: unknown): boolean {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return false
  if (Object.getPrototypeOf(m) !== Object.prototype) return false
  const keys = Object.keys(m)
  if (keys.length !== 2) return false
  const r = m as Record<string, unknown>
  return Object.hasOwn(r, 'v') && Object.hasOwn(r, 'type') && r.v === 1 && r.type === 'stop'
}

/** The part of `process` this needs (a fake one in tests) */
export interface ParentChannelProcess {
  send?: unknown
  connected?: boolean
  on(event: 'message', listener: (message: unknown, handle?: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
}

export type ParentStop =
  | { ok: true; /** The clean-up to run once; run at once if a stop already came */ onStop(cleanup: () => void): void }
  | { ok: false; error: string }

function closeHandle(handle: unknown) {
  const h = handle as { destroy?: () => void; close?: () => void } | null
  try {
    if (typeof h?.destroy === 'function') h.destroy()
    else if (typeof h?.close === 'function') h.close()
  } catch { /* already closed */ }
}

/**
 * Watch the IPC channel of the parent. Fails closed when there is no channel: --ipc-stop given by hand, from a
 * terminal or by a parent that did not open one, refuses to start rather than run without a stop channel.
 */
export function watchParentStop(proc: ParentChannelProcess, log: (message: string) => void = () => {}): ParentStop {
  if (typeof proc.send !== 'function' || proc.connected !== true) {
    return { ok: false, error: `${IPC_STOP_FLAG} is internal to the tray driver: it needs the IPC channel of the process that started the relay, and there is none.` }
  }
  let requested = false
  let cleanup: (() => void) | null = null
  let ignored = 0
  const request = () => {
    if (requested) return
    requested = true
    cleanup?.()
  }
  proc.on('message', (message, handle) => {
    // A handle (socket, server) is never part of the stop message: close it so it does not stay open here
    if (handle !== undefined && handle !== null) { closeHandle(handle); return ignore() }
    if (isStopMessage(message)) request()
    else ignore()
  })
  // The channel closes when the parent exits, is killed or disconnects: same clean-up, no orphan relay
  proc.on('disconnect', request)
  function ignore() {
    ignored++
    if (ignored <= MAX_IGNORED_LOGS) log(ignored === MAX_IGNORED_LOGS ? 'ignored a message on the stop channel (further ones are not logged)' : 'ignored a message on the stop channel')
  }
  return {
    ok: true,
    onStop(fn) {
      cleanup = fn
      if (requested) fn()
    },
  }
}
