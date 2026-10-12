/**
 * Imported transcripts (#294) are not discovered by the scan: a change of scope (#291) neither removes nor
 * announces them, in either direction. Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { encodeProjectDirName } from '../extension/src/project-dir'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-scope-imported-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.AGENT_LENS_IMPORT

const CLOUD = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'
const line = (o: unknown) => JSON.stringify(o) + '\n'

describe('scope change with an imported transcript', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let port = 0

  const sessionIds = () => new Promise<string[]>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => {
        buf += c
        const m = /data: (\{"type":"session-list".*?\})\n\n/.exec(buf)
        if (m) { req.destroy(); resolve((JSON.parse(m[1]).sessions as Array<{ id: string }>).map(s => s.id).sort()) }
      })
    })
    req.on('error', reject)
    setTimeout(() => { req.destroy(); resolve([]) }, 2000)
  })

  before(async () => {
    const projects = path.join(fakeHome, '.claude', 'projects')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const own = path.join(projects, encodeProjectDirName(fs.realpathSync(ws)))
    const other = path.join(projects, '-elsewhere')
    fs.mkdirSync(own, { recursive: true })
    fs.mkdirSync(other, { recursive: true })
    const hello = line({ type: 'user', message: { role: 'user', content: 'hello' } })
    fs.writeFileSync(path.join(own, 'own-session.jsonl'), hello)
    fs.writeFileSync(path.join(other, 'other-session.jsonl'), hello)
    const importDir = path.join(fakeHome, 'downloads')
    fs.mkdirSync(importDir, { recursive: true })
    fs.writeFileSync(path.join(importDir, `${CLOUD}.jsonl`), line({ type: 'user', cwd: '/home/user/cloud', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'cloud' } }))

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', imports: [importDir] })
    server = http.createServer((req, res) => relay.handleSSE(req, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('keeps the imported session through workspace -> all -> workspace, and drops only the live ones', async () => {
    assert.deepEqual(await sessionIds(), [CLOUD, 'own-session'].sort())
    relay.setScope('all')
    assert.deepEqual(await sessionIds(), [CLOUD, 'other-session', 'own-session'].sort())
    relay.setScope('workspace')
    assert.deepEqual(await sessionIds(), [CLOUD, 'own-session'].sort())
    assert.equal(relay.debugState().watchedSessions, 1, 'imported sessions are not live watchers')
  })

  it('announces no end for the imported session when narrowing', async () => {
    relay.setScope('all')
    const ended: string[] = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => { for (const m of c.matchAll(/"type":"session-ended","sessionId":"([^"]+)"/g)) ended.push(m[1]) })
    })
    await new Promise(r => setTimeout(r, 300))
    relay.setScope('workspace')
    await new Promise(r => setTimeout(r, 300))
    req.destroy()
    assert.deepEqual(ended, ['other-session'])
  })
})
