/**
 * SSE client of a relay, for the per-runtime relay tests: collects the `data:` frames and waits for one.
 * No side effect on import (#420), so the fixtures of several runtimes can share it.
 */
import * as http from 'node:http'

export interface Sse { close: () => void; waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any> }

export function openSse(port: number): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const waiters: Array<{ pred: (m: any) => boolean; done: (m: any) => void }> = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => {
        buf += c
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (!frame.startsWith('data: ')) continue
          let m: any
          try { m = JSON.parse(frame.slice(6)) } catch { continue }
          messages.push(m)
          for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.done(m) }
        }
      })
      resolve({
        close: () => req.destroy(),
        waitFor: (pred, ms = 5000) => {
          const seen = messages.find(pred)
          if (seen) return Promise.resolve(seen)
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('timed out waiting for an SSE message')), ms)
            waiters.push({ pred, done: m => { clearTimeout(t); res2(m) } })
          })
        },
      })
    })
    req.on('error', reject)
  })
}
