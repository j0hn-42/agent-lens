/**
 * --all-workspaces / AGENT_FLOW_ALL_WORKSPACES: sessions from other workspaces are
 * discovered, but only real .jsonl files directly inside real project dirs under
 * ~/.claude/projects (no symlinks, size cap, safe ids).
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-all-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
// Exercise the env var path (no explicit option passed to createRelay)
process.env.AGENT_FLOW_ALL_WORKSPACES = '1'

const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello from another workspace' } }) + '\n'

describe('relay --all-workspaces', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let port = 0

  before(async () => {
    const projects = path.join(fakeHome, '.claude', 'projects')
    const other = path.join(projects, '-some-other-workspace')
    const outside = path.join(fakeHome, 'outside')
    fs.mkdirSync(other, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(other, 'other-session.jsonl'), line)
    fs.writeFileSync(path.join(other, 'bad name.jsonl'), line)
    fs.writeFileSync(path.join(outside, 'escaped.jsonl'), line)
    fs.symlinkSync(path.join(outside, 'escaped.jsonl'), path.join(other, 'symlinked.jsonl'))
    fs.symlinkSync(outside, path.join(projects, 'linked-project'))

    const ws = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(ws, { recursive: true })
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => relay.handleSSE(req, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('discovers sessions of other workspaces but never symlinked or oddly named files', async () => {
    const ids = await new Promise<string[]>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
        res.setEncoding('utf8')
        let buf = ''
        res.on('data', (c: string) => {
          buf += c
          const m = /data: (\{"type":"session-list".*?\})\n\n/.exec(buf)
          if (m) { req.destroy(); resolve((JSON.parse(m[1]).sessions as Array<{ id: string }>).map(s => s.id)) }
        })
        res.on('close', () => resolve([]))
      })
      req.on('error', reject)
      setTimeout(() => { req.destroy(); resolve([]) }, 3000)
    })
    assert.deepEqual(ids, ['other-session'])
  })
})
