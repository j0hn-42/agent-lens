import { test } from 'node:test'
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
