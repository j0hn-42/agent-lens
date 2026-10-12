/**
 * #229: a relay that crashes (uncaughtException) must not leave a headless agent running without a supervisor.
 * The children are detached (own group, own session) and the 60 min timer and the SIGKILL grace are the relay's
 * own timers, so the crash handler kills them before the process exits. The relay is a per-process singleton: own file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { JournalEntry } from './launch-supervisor'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-launch-crash-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

const REPO = 'j0hn-42/agent-lens'
const TOKEN = 'e'.repeat(64)

class FakeChild extends EventEmitter {
  pid: number
  stdout = new EventEmitter(); stderr = new EventEmitter()
  constructor(pid: number) { super(); this.pid = pid }
  kill() { return true }
}

describe('relay crash with a running launch (#229)', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  const children: FakeChild[] = []
  const kills: Array<[number, string]> = []
  const journal: JournalEntry[] = []
  let crashHandler: ((err: Error) => void) | undefined

  before(async () => {
    const ws = path.join(fakeHome, 'ws')
    fs.mkdirSync(ws, { recursive: true })
    const { createRelay } = await import('./relay')
    const known = new Set(process.listeners('uncaughtException'))
    let pid = 9000
    relay = await createRelay({
      workspace: ws, runtime: 'claude',
      launch: {
        repos: [REPO], token: TOKEN,
        journal: { append: e => { journal.push(e); return true } },
        spawn: () => { const c = new FakeChild(++pid); children.push(c); return c as never },
        killGroup: (p, s) => { kills.push([p, s]) },
        workspaceOrigin: async () => `git@github.com:${REPO}.git`,
        lookupIssue: async () => JSON.stringify({
          number: 229, html_url: `https://github.com/${REPO}/issues/229`, state: 'open', title: 't', body: 'b',
          author_association: 'OWNER', labels: [{ name: 'agent:backend-engineer' }],
        }),
      },
    })
    crashHandler = process.listeners('uncaughtException').find(l => !known.has(l)) as typeof crashHandler
  })
  after(() => { relay.dispose(); fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('kills the running children with SIGKILL and journals it before the process exits', async () => {
    assert.equal(typeof crashHandler, 'function', 'the relay installed its crash handler')
    const server = http.createServer((rq, rs) => { void relay.handleLaunch(rq, rs) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const status = await new Promise<number>((resolve, reject) => {
      const rq = http.request({
        host: '127.0.0.1', port, path: '/launch', method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'crash' },
      }, rs => { rs.resume(); resolve(rs.statusCode ?? 0) })
      rq.on('error', reject)
      rq.end(JSON.stringify({ repo: REPO, issue: 229, role: 'backend-engineer' }))
    })
    server.close()
    assert.equal(status, 202)
    children[0].emit('spawn')

    const exit = mock.method(process, 'exit', (() => undefined) as never)
    const err = mock.method(console, 'error', () => undefined)
    try {
      crashHandler!(new Error('boom'))
      assert.deepEqual(kills.at(-1), [9001, 'SIGKILL'])
      assert.equal(journal.some(e => e.event === 'killed-on-dispose'), true)
      assert.equal(exit.mock.calls[0]?.arguments[0], 1)
    } finally {
      exit.mock.restore(); err.mock.restore()
    }
  })
})
