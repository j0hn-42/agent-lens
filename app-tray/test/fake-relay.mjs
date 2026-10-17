// Test double of the relay (#335): prints the same URL line as app/src/server.ts and serves /status.
// Env: FAKE_RELAY_MODE = ok | no-url | status-500 | status-bad-json | status-foreign | status-huge | status-hang | ignore-term
//      FAKE_RELAY_COUNT = sessionCount (default 2), FAKE_RELAY_MARK = file written when SIGTERM is received,
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
  if (mode !== 'no-url') console.log(`Server running at http://127.0.0.1:${port}`)
  console.log('Waiting for agent events...\n')
})

process.on('SIGTERM', () => {
  if (process.env.FAKE_RELAY_MARK) fs.writeFileSync(process.env.FAKE_RELAY_MARK, 'SIGTERM')
  if (mode === 'ignore-term') return
  server.close()
  process.exit(0)
})
if (process.env.FAKE_RELAY_EXIT_AFTER_MS) setTimeout(() => process.exit(4), Number(process.env.FAKE_RELAY_EXIT_AFTER_MS))
