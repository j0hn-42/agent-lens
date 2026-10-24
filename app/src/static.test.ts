import { test, mock } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { HTML_SHELL, serveStatic } from './static'
import { guardRequest } from '../../scripts/server-hardening'
import { CSP_STATIC_APP } from '../../extension/src/constants'

test('standalone shell: the theme script is an external file, in <body>, before the root and the bundle', () => {
  const theme = HTML_SHELL.indexOf('src="/theme.js"')
  assert.ok(theme > 0)
  assert.ok(theme < HTML_SHELL.indexOf('id="root"'))
  assert.ok(theme < HTML_SHELL.indexOf('src="/index.js"'))
  assert.ok(HTML_SHELL.indexOf('<body') < theme, 'after <body> opens so host classes can be read')
})

test('standalone shell under the real CSP: no inline script, every script is same-origin and served', async () => {
  const server = http.createServer((req, res) => { if (!guardRequest(req, res, { kind: 'static' })) serveStatic(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const root = await fetch(`${base}/`)
    const csp = root.headers.get('content-security-policy')!
    assert.equal(csp, CSP_STATIC_APP)
    assert.match(csp, /script-src 'self'(;|$)/, 'no unsafe-inline, nonce or hash: only external same-origin scripts run')
    const html = await root.text()
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    assert.ok(scripts.length >= 2)
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /src="\/[^"/][^"]*"/, 'external same-origin script')
      assert.equal(body.trim(), '', 'no inline body that the CSP would refuse')
    }
    const theme = await fetch(`${base}/theme.js?x=1`)
    assert.equal(theme.status, 200)
    assert.match(theme.headers.get('content-type')!, /javascript/)
    assert.match(await theme.text(), /dataset\.theme/)
  } finally {
    server.close()
  }
})

test('static assets: read once, then served from memory; revalidated with an ETag (#654)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-static-'))
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, 'console.log(1)')
  const reads = mock.method(fs, 'readFileSync')
  syncBuiltinESMExports()
  const server = http.createServer((req, res) => serveStatic(req, res, dir))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const readsOf = () => reads.mock.calls.filter(c => c.arguments[0] === file).length
  try {
    const first = await fetch(`${base}/index.js`)
    assert.equal(await first.text(), 'console.log(1)')
    const etag = first.headers.get('etag')
    assert.ok(etag, 'an ETag lets the browser revalidate')
    assert.match(first.headers.get('cache-control') ?? '', /no-cache|max-age/)
    for (let i = 0; i < 5; i++) assert.equal(await (await fetch(`${base}/index.js`)).text(), 'console.log(1)')
    assert.equal(readsOf(), 1, 'six requests, one read of the disk')
    const again = await fetch(`${base}/index.js`, { headers: { 'If-None-Match': etag! } })
    assert.equal(again.status, 304)
    // A rebuilt file is served anew, never the stale copy
    fs.writeFileSync(file, 'console.log(22)')
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    assert.equal(await (await fetch(`${base}/index.js`)).text(), 'console.log(22)')
    assert.equal(readsOf(), 2)
  } finally {
    reads.mock.restore()
    syncBuiltinESMExports()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
