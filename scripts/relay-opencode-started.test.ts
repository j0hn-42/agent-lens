/**
 * Relay + OpenCode runtime (#420): a session that starts while a page is connected is announced with
 * its runtime and its directory, so the page shows the OpenCode badge without waiting for a reconnect.
 * Own file: createRelay() runs once per process.
 */
import { fakeHome, makeWorkspace } from './relay-opencode-fixture'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { OpenCodeFixture, sqliteAvailable } from '../extension/test/helpers/opencode-fixture'
import { openSse } from './relay-sse-of'


describe("relay runtime: 'opencode', session started while a page is connected", { skip: !sqliteAvailable() && 'node:sqlite unavailable' }, () => {
  let workspace = ''
  let fx: OpenCodeFixture
  before(() => {
    delete process.env.AGENT_LENS_RUNTIME
    workspace = makeWorkspace()
    fx = new OpenCodeFixture(path.join(fakeHome, 'opencode-started.db'))
    process.env.OPENCODE_DB = fx.file
  })
  after(() => {
    fx.close()
    delete process.env.OPENCODE_DB
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('announces session-started with runtime opencode and the session directory as cwd', async () => {
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace, runtime: 'opencode' })
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const sse = await openSse(port)
    try {
      await new Promise(r => setTimeout(r, 300)) // the page is connected before the session starts
      const now = Date.now()
      fx.session('ses_late', { dir: workspace, created: now - 500, updated: now - 100 })
      const started = await sse.waitFor(m => m.type === 'session-started' && m.session?.id === 'ses_late')
      assert.equal(started.session.runtime, 'opencode')
      assert.equal(started.session.cwd, workspace)
    } finally {
      sse.close()
      relay.dispose()
      server.close()
    }
  })
})
