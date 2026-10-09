/**
 * #138 : with CLAUDE_CONFIG_DIR set (second account), the relay discovers the sessions of that account
 * and not those of ~/.claude. The variable is fixed BEFORE the modules are imported, as in real use.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-relay-cfg-'))
const configDir = path.join(fakeHome, 'second-account')
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.AGENT_LENS_ALL_WORKSPACES = '1'

const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n'

describe('relay + CLAUDE_CONFIG_DIR', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let port = 0

  before(async () => {
    const second = path.join(configDir, 'projects', '-second-ws')
    const home = path.join(fakeHome, '.claude', 'projects', '-home-ws')
    fs.mkdirSync(second, { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(second, 'second-session.jsonl'), line)
    fs.writeFileSync(path.join(home, 'home-session.jsonl'), line)
    const ws = path.join(fakeHome, 'ws')
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

  it('lists the sessions of the second account, not those of ~/.claude', async () => {
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
    assert.deepEqual(ids, ['second-session'])
  })
})
