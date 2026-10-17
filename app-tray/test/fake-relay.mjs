// Test double of the relay (#335): prints the same URL line as app/src/server.ts and serves /status.
// Env: FAKE_RELAY_MODE = ok | no-url | foreign-url | status-500 | status-bad-json | status-foreign | status-huge | status-hang | ignore-term | ignore-ipc | disconnect-ipc
//      (disconnect-ipc: closes its end of the IPC channel once listening, and keeps running)
//      FAKE_RELAY_COUNT = sessionCount (default 2), FAKE_RELAY_MARK = file written when SIGTERM ("SIGTERM") or, started
//      with an IPC channel and --ipc-stop, the exact stop message of the driver ("IPC") is received (#513),
//      FAKE_RELAY_EXIT_AFTER_MS = exit with code 4 after this delay.
import http from 'node:http'
import fs from 'node:fs'

const mode = process.env.FAKE_RELAY_MODE ?? 'ok'
const count = Number(process.env.FAKE_RELAY_COUNT ?? 2)

const server = http.createServer((req, res) => {
  if (req.url !== '/status') { res.writeHead(404).end(); return }
  if (mode === 'status-500') { res.writeHead(500).end('boom'); return }
  if (mode === 'status-hang') return
  res.writeHead(200, { 'content-type': 'application/json' })
  if (mode === 'status-bad-json') res.end('{nope')
  else if (mode === 'status-huge') res.end(JSON.stringify({ relayVersion: '0.10.0', sessionCount: count, pad: 'x'.repeat(200_000) }))
  else if (mode === 'status-foreign') res.end(JSON.stringify({ sessionCount: count }))
  else res.end(JSON.stringify({ relayVersion: '0.10.0', sessionCount: count, skippedSessions: { watchLimit: 1, sizeLimit: 0, fileLimit: 0 } }))
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  if (mode === 'foreign-url') {
    // Lines close to the real one, none of which may be trusted
    for (const l of [`http://0.0.0.0:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}/x`, `https://127.0.0.1:${port}`]) console.log(`Server running at ${l}`)
    console.log(` Server running at http://127.0.0.1:${port}`)
  } else if (mode !== 'no-url') console.log(`Server running at http://127.0.0.1:${port}`)
  console.log('Waiting for agent events...\n')
  if (mode === 'disconnect-ipc' && typeof process.send === 'function') setTimeout(() => process.disconnect(), 50)
})

process.on('SIGTERM', () => {
  if (process.env.FAKE_RELAY_MARK) fs.writeFileSync(process.env.FAKE_RELAY_MARK, 'SIGTERM')
  if (mode === 'ignore-term') return
  server.close()
  process.exit(0)
})
if (process.env.FAKE_RELAY_EXIT_AFTER_MS) setTimeout(() => process.exit(4), Number(process.env.FAKE_RELAY_EXIT_AFTER_MS))

// Stop channel of #513: like app/src/parent-stop.ts, only with --ipc-stop and an IPC channel from the parent
if (process.argv.includes('--ipc-stop') && typeof process.send === 'function') {
  process.on('message', m => {
    if (mode === 'ignore-ipc') return
    if (!m || typeof m !== 'object' || Object.keys(m).length !== 2 || m.v !== 1 || m.type !== 'stop') return
    if (process.env.FAKE_RELAY_MARK) fs.writeFileSync(process.env.FAKE_RELAY_MARK, 'IPC')
    server.close()
    process.exit(0)
  })
}
