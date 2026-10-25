/**
 * Shared by the relay tests that start a relay on a transcript and append live lines (#651, #440, #613).
 */
import * as http from 'node:http'

/** What the wait reads of a relay (`createRelay(...)` result): the attach state of `debugState()`. */
export interface AttachState { debugState(): { watchedSessions: number; attaching: boolean } }

/**
 * Resolves once `count` sessions are followed and no attach is in progress, false after `ms`. A transcript is attached
 * over several ticks (#651): a line appended before the attach ends is history and never emitted, so the tests start
 * once it is followed, not after a fixed time. One definition: if the availability condition changes (a queued attach
 * state, say), it changes here only.
 */
export async function waitAttached(relay: AttachState, count: number, ms = 8000): Promise<boolean> {
  const attached = () => { const s = relay.debugState(); return s.watchedSessions >= count && !s.attaching }
  const end = Date.now() + ms
  while (!attached() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
  return attached()
}

/** Opens /events and destroys the request as soon as the headers arrive: handleSSE scans synchronously (scanNow) on connect. */
export function touchEvents(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.resume()
      req.destroy()
      resolve()
    })
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(); else reject(e) })
  })
}
