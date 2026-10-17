/**
 * Relay + Gemini CLI runtime (#420): a session that starts while a page is connected is announced with
 * its runtime and its directory (the workspace whose project hash it carries), so the page shows the
 * Gemini badge without waiting for a reconnect. Own file: createRelay() runs once per process.
 */
import { fakeHome, makeWorkspace, writeGeminiSession } from './relay-gemini-fixture'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { openSse } from './relay-sse-of'

describe("relay runtime: 'gemini', session started while a page is connected", () => {
  let workspace = ''
  before(() => {
    delete process.env.AGENT_LENS_RUNTIME
    workspace = makeWorkspace()
  })
  after(() => { fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('announces session-started with runtime gemini and the workspace as cwd', async () => {
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace, runtime: 'gemini' })
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    try {
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const sse = await openSse(port)
      try {
        await new Promise(r => setTimeout(r, 300)) // the page is connected before the session starts
        const id = writeGeminiSession(workspace)
        const started = await sse.waitFor(m => m.type === 'session-started' && m.session?.id === id)
        assert.equal(started.session.runtime, 'gemini')
        assert.equal(started.session.cwd, workspace)
      } finally { sse.close() }
    } finally {
      relay.dispose()
      server.close()
    }
  })
})
