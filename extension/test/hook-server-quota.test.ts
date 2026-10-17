/**
 * POST /quota sur le HookServer (#467) : c'est le port de découverte, donc le seul que le script de barre d'état
 * atteint. Sans handler (extension VS Code) : 404 immédiat, sans compter de requête malformée ni consommer le
 * limiteur des hooks. Avec handler (relais) : la route a ses propres gardes, appelée avant la validation des hooks.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { HOOK_RATE_IP_BURST } from '../src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hook-quota-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

type HookServerCtor = typeof import('../src/hook-server').HookServer
let HookServer: HookServerCtor

function request(port: number, urlPath: string, body: string, method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const QUOTA = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1790000000 } } })

async function start() {
  const server = new HookServer()
  const port = await server.start()
  const internals = server as unknown as {
    unattributed: { noteMalformed: () => void }
    ipLimiter: { allow: (k: string) => boolean }
  }
  let malformed = 0
  let limiterCalls = 0
  const noteMalformed = internals.unattributed.noteMalformed.bind(internals.unattributed)
  internals.unattributed.noteMalformed = () => { malformed++; noteMalformed() }
  const allow = internals.ipLimiter.allow.bind(internals.ipLimiter)
  internals.ipLimiter.allow = k => { limiterCalls++; return allow(k) }
  return { server, port, counts: () => ({ malformed, limiterCalls }) }
}

describe('HookServer POST /quota (#467)', () => {
  before(async () => { ({ HookServer } = await import('../src/hook-server')) })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('sans handler : 404, rien compté comme malformé, limiteur des hooks intact', async () => {
    const { server, port, counts } = await start()
    try {
      for (const p of ['/quota', '/quota?x=1']) assert.equal((await request(port, p, QUOTA)).status, 404)
      assert.deepEqual(counts(), { malformed: 0, limiterCalls: 0 })
    } finally { server.dispose() }
  })

  it('sans handler : une rafale de POST /quota ne prive pas les vrais hooks de leur budget', async () => {
    const { server, port } = await start()
    try {
      for (let i = 0; i < HOOK_RATE_IP_BURST + 10; i++) await request(port, '/quota', QUOTA)
      const hook = await request(port, '/', JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart' }))
      assert.equal(hook.status, 200)
    } finally { server.dispose() }
  })

  it('avec handler : la requête l\'atteint, avant la validation des hooks, le comptage et le limiteur', async () => {
    const { server, port, counts } = await start()
    try {
      const seen: Array<string | undefined> = []
      server.setQuotaHandler((req, res) => {
        seen.push(req.url)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
      for (const p of ['/quota', '/quota?x=1']) {
        const r = await request(port, p, QUOTA)
        assert.deepEqual([r.status, r.body], [200, '{}'])
      }
      assert.deepEqual(seen, ['/quota', '/quota?x=1'])
      assert.deepEqual(counts(), { malformed: 0, limiterCalls: 0 })
    } finally { server.dispose() }
  })

  it('avec handler : un chemin voisin n\'est pas la route (/quota/, /quotas) et reste un hook invalide', async () => {
    const { server, port } = await start()
    try {
      server.setQuotaHandler((_req, res) => { res.writeHead(200); res.end() })
      for (const p of ['/quota/', '/quotas']) assert.equal((await request(port, p, QUOTA)).status, 400)
    } finally { server.dispose() }
  })

  it('avec handler : un POST de hook normal est inchangé', async () => {
    const { server, port } = await start()
    try {
      const events: string[] = []
      server.onEvent(e => events.push((e as { type: string }).type))
      server.setQuotaHandler((_req, res) => { res.writeHead(200); res.end() })
      const r = await request(port, '/', JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart' }))
      assert.equal(r.status, 200)
      assert.deepEqual(events, ['agent_spawn'])
    } finally { server.dispose() }
  })

  it('setQuotaHandler(null) retire la route : 404 de nouveau', async () => {
    const { server, port } = await start()
    try {
      server.setQuotaHandler((_req, res) => { res.writeHead(200); res.end() })
      assert.equal((await request(port, '/quota', QUOTA)).status, 200)
      server.setQuotaHandler(null)
      assert.equal((await request(port, '/quota', QUOTA)).status, 404)
    } finally { server.dispose() }
  })

  it('un handler qui lève : 500, le serveur continue', async () => {
    const { server, port } = await start()
    try {
      server.setQuotaHandler(() => { throw new Error('boom') })
      assert.equal((await request(port, '/quota', QUOTA)).status, 500)
      const hook = await request(port, '/', JSON.stringify({ session_id: 's2', hook_event_name: 'SessionStart' }))
      assert.equal(hook.status, 200)
    } finally { server.dispose() }
  })
})
