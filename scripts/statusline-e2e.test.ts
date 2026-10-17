/**
 * De bout en bout (#467) : le script de barre d'état généré, lancé comme processus, trouve le relais par le fichier de
 * découverte que celui-ci écrit vraiment (port du HookServer), et le quota arrive en SSE chez un client local.
 * Relais singleton par processus : fichier de test dédié.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-statusline-e2e-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getStatuslineScriptContent } = require('./statusline-wrapper.js') as { getStatuslineScriptContent: () => string }

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
let workspace = ''
const scriptPath = path.join(fakeHome, 'statusline.js')

function runWrapper(stdin: string, arg: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [scriptPath, arg], { env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('close', code => resolve({ stdout, code }))
    child.stdin.end(stdin)
  })
}

function openSse(): Promise<{ messages: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => {
        buf += c
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (!frame.startsWith('data: ')) continue
          try { messages.push(JSON.parse(frame.slice(6))) } catch { /* ignore */ }
        }
      })
      resolve({ messages, close: () => req.destroy() })
    })
    req.on('error', reject)
  })
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 20))
}

describe('barre d\'état -> HookServer -> SSE (#467)', () => {
  before(async () => {
    workspace = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(scriptPath, getStatuslineScriptContent())
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('le fichier de découverte réel suffit : le client SSE reçoit les bonnes valeurs, la barre d\'origine est intacte', async () => {
    const discovery = path.join(fakeHome, '.claude', 'agent-lens')
    assert.ok(fs.readdirSync(discovery).some(f => f.endsWith(`-${process.pid}.json`)), 'le relais a écrit son fichier de découverte')
    const sse = await openSse()
    try {
      const statusJson = JSON.stringify({
        session_id: 'abc-123', cwd: workspace, model: { id: 'claude-x', display_name: 'X' },
        workspace: { current_dir: workspace }, transcript_path: path.join(workspace, 't.jsonl'),
        cost: { total_cost_usd: 0.42 },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1800000000 },
          seven_day: { used_percentage: 41.2, resets_at: 1800500000 },
        },
      })
      const original = Buffer.from(JSON.stringify({ type: 'command', command: 'printf barre' })).toString('base64url')
      const r = await runWrapper(statusJson, original)
      assert.deepEqual([r.stdout, r.code], ['barre', 0])
      await waitFor(() => sse.messages.some(m => m.type === 'quota'))
      const m = sse.messages.find(x => x.type === 'quota')
      assert.ok(m, 'message quota reçu')
      assert.deepEqual(m.quota.fiveHour, { usedPercentage: 23.5, resetsAt: 1800000000 })
      assert.deepEqual(m.quota.sevenDay, { usedPercentage: 41.2, resetsAt: 1800500000 })
    } finally { sse.close() }
  })
})
