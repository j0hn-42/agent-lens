/**
 * GET /status of a relay, for the per-runtime relay tests. No side effect on import (no fake home, no
 * environment change): a fixture of one runtime can share it without the setup of another (#420).
 */
import * as http from 'node:http'
import { isStatusPath } from '../extension/src/relay-guards'

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>

/** GET /status of a relay, served on a loopback port for the call. */
export async function statusOf(relay: Relay): Promise<{ runtimes: string[]; sessionCount: number }> {
  const server = http.createServer((req, res) => {
    if (isStatusPath(req.url)) return relay.handleStatus(req, res)
    res.writeHead(404); res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/status', agent: false }, res => {
        let b = ''
        res.on('data', c => { b += c })
        res.on('end', () => resolve(b))
      }).on('error', reject)
    })
    return JSON.parse(body)
  } finally { server.close() }
}
