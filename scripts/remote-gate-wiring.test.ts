/**
 * The pairing of a loopback Host while remote access is on (#517) is enforced by ONE gate: gateRemoteRequest, the first
 * thing the app's request handler does. relay.handleSSE and guardedRoute only ask a tunnel Host for the cookie (#535,
 * point 2). These tests prove that every caller of createRelay that can pass allowedHosts serves through that gate:
 * - the production callers of createRelay are known, and a new one fails here until it is reviewed;
 * - the only one that passes allowedHosts (app/src/server.ts) hands every request to createAppRequestHandler, which
 *   calls gateRemoteRequest before any relay handler;
 * - at run time, an unpaired loopback request never reaches a relay handler through createAppRequestHandler.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { listenLoopback } from './server-hardening'
import { bindRemoteAuth } from './remote-access'

const ROOT = path.resolve(__dirname, '..')
/** Production code that can create the relay (tests and their fixtures create it with their own guards). */
const SOURCE_DIRS = ['scripts', 'app/src', 'app-tray/src', 'extension/src']
/** Every production caller of createRelay, reviewed: only app/src/server.ts passes allowedHosts. */
const KNOWN_CALLERS = ['app/src/server.ts', 'scripts/dev-relay.ts']

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...sourceFiles(rel)); continue }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/-fixture\.ts$/.test(entry.name)) out.push(rel)
  }
  return out
}

/** Code without its comments (a comment that names createRelay is not a call). */
function code(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('loopback pairing (#517): every createRelay caller with allowedHosts serves through gateRemoteRequest (#535)', () => {
  it('the production callers of createRelay are the known ones: a new caller must be reviewed here', () => {
    // scripts/relay.ts defines it (and names it in an error message)
    const callers = SOURCE_DIRS.flatMap(sourceFiles).filter(f => f !== 'scripts/relay.ts' && /\bcreateRelay\s*\(/.test(code(f))).sort()
    assert.deepEqual(callers, [...KNOWN_CALLERS].sort(),
      'a new createRelay caller: if it passes allowedHosts, its handler must call gateRemoteRequest first; then add it to KNOWN_CALLERS')
  })

  it('scripts/dev-relay.ts never passes allowedHosts nor remotePairing (no remote access, no loopback pairing)', () => {
    const src = code('scripts/dev-relay.ts')
    assert.doesNotMatch(src, /allowedHosts|remotePairing/)
  })

  it('app/src/server.ts serves only through createAppRequestHandler, which calls gateRemoteRequest before any relay handler', () => {
    const src = code('app/src/server.ts')
    const servers = src.match(/http\.createServer\(.*$/gm) ?? []
    assert.equal(servers.length, 1, servers.join('\n'))
    assert.match(servers[0], /, createAppRequestHandler\(relay\)\)$/)
    const start = src.indexOf('export function createAppRequestHandler(')
    const end = src.indexOf('export async function startServer(')
    assert.ok(start >= 0 && end > start, 'createAppRequestHandler then startServer')
    const body = src.slice(start, end)
    const gate = body.indexOf('gateRemoteRequest(')
    const firstHandler = body.search(/relay\.handle\w+\(/)
    assert.ok(gate >= 0, 'createAppRequestHandler calls gateRemoteRequest')
    assert.ok(firstHandler > gate, 'gateRemoteRequest comes before the first relay handler')
    assert.match(body.slice(gate - 10, gate + 80), /if \(gateRemoteRequest\(req, res, allowedHosts,/, 'its answer stops the request')
  })

  it('at run time, an unpaired loopback request reaches no relay handler (401); a paired one does', async () => {
    const { createAppRequestHandler } = await import('../app/src/server')
    const allowedHosts: readonly string[] = Object.freeze(['box.tail1234.ts.net'])
    bindRemoteAuth(allowedHosts, { handlePair: async () => {}, isPaired: req => req.headers.cookie === 'paired=1' })
    const reached: string[] = []
    const stub = (name: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => { reached.push(name); res.writeHead(200).end() }
    const handler = createAppRequestHandler({
      allowedHosts,
      handleSSE: stub('sse'), handleStatus: stub('status'), handleStatusLine: stub('statusline'), handleContext: stub('context'),
      handleScope: stub('scope'), handleLaunch: stub('launch'), handleObservations: stub('observations'), handleIssueLinks: stub('issue-links'),
    })
    const server = http.createServer(handler)
    const port = await listenLoopback(server, 0)
    const send = (method: string, p: string, headers: http.OutgoingHttpHeaders) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    const routes: Array<[string, string]> = [
      ['GET', '/events'], ['GET', '/status'], ['GET', '/statusline'], ['GET', '/context?session=77777777-7777-4777-8777-777777777777'],
      ['GET', '/issue-links?role=qa-engineer'], ['GET', '/observations'], ['POST', '/scope'], ['POST', '/launch'],
    ]
    try {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        for (const [method, p] of routes) assert.equal(await send(method, p, { Host: host }), 401, `${method} ${p} ${host}`)
      }
      assert.deepEqual(reached, [], 'no relay handler ran for an unpaired loopback request')
      assert.equal(await send('GET', '/status', { Host: `127.0.0.1:${port}`, Cookie: 'paired=1' }), 200)
      assert.deepEqual(reached, ['status'])
    } finally {
      server.close()
    }
  })
})
