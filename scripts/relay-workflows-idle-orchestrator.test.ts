/**
 * Relay session discovery (#79): an orchestrator blocked on the Workflow tool for more than
 * ACTIVE_SESSION_AGE_S has an old main file, and only the files under subagents/workflows/<id>/ are
 * fresh. The relay must still discover and watch the session, and announce the workflow agents.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-workflows-idle-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

const ORCH = '44444444-4444-4444-8444-444444444444'

type Ev = { type: string; payload: Record<string, unknown>; sessionId?: string }

function snapshot(port: number): Promise<Ev[]> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => { buf += c })
      setTimeout(() => {
        req.destroy()
        const events: Ev[] = []
        for (const block of buf.split('\n\n')) {
          if (!block.startsWith('data: ')) continue
          const msg = JSON.parse(block.slice(6))
          if (msg.type === 'agent-event') events.push(msg.event)
          else if (msg.type === 'agent-event-batch') events.push(...msg.events)
        }
        resolve(events)
      }, 700)
    })
    req.on('error', reject)
  })
}

const line = (o: unknown) => JSON.stringify(o) + '\n'
const SEC = 1000
const MIN = 60 * SEC

describe('relay with Workflow tool runs', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let events: Ev[] = []

  before(async () => {
    const ws = path.join(fakeHome, 'work', 'demo')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    const sessionDir = path.join(projectDir, ORCH)
    const subDir = path.join(sessionDir, 'subagents')
    const scripts = path.join(sessionDir, 'workflows', 'scripts')
    fs.mkdirSync(scripts, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${ORCH}.jsonl`),
      line({ type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the workflows' } }))
    const old = (Date.now() - 60 * MIN) / 1000
    fs.utimesSync(path.join(projectDir, `${ORCH}.jsonl`), old, old)

    const addAgent = (wf: string, id: string, description: string, phase: string, entries: unknown[], ageMs: number) => {
      const dir = path.join(subDir, 'workflows', wf)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `agent-${id}.jsonl`)
      fs.writeFileSync(file, entries.map(line).join(''))
      fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({
        agentType: 'workflow-subagent', description, workflowPhase: phase, spawnDepth: 1, requestShape: 'foreground',
      }))
      const t = (Date.now() - ageMs) / 1000
      fs.utimesSync(file, t, t)
    }
    const text = (t: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
    const user = (t: string) => ({ type: 'user', message: { role: 'user', content: t } })
    const tool = (id: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make' } }] } })

    // Running workflow: one agent working (pending tool), one idle between calls, one that already finished
    fs.writeFileSync(path.join(scripts, 'demo-wave-wf_run1-aaa.js'), '// never read')
    addAgent('wf_run1-aaa', 'work0001', 'impl:build', 'Implement', [user('go'), tool('tu-1')], 4 * MIN)
    addAgent('wf_run1-aaa', 'idle0002', 'impl:docs', 'Implement', [user('go'), text('thinking about docs')], 30 * SEC)
    addAgent('wf_run1-aaa', 'done0003', 'review:build', 'Review', [user('go'), text('Reviewed: all good.')], 3 * MIN)
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => relay.handleSSE(req, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    events = await snapshot((server.address() as { port: number }).port)
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  const ofType = (t: string) => events.filter(e => e.type === t && e.sessionId === ORCH)

  it('discovers a session whose main file is 1 h old when only workflow agent files are fresh', () => {
    const spawns = ofType('agent_spawn').filter(e => e.payload.kind === 'teammate')
    assert.deepEqual(spawns.map(e => String(e.payload.name)).sort(), ['impl:build', 'impl:docs', 'review:build'])
    for (const e of spawns) assert.equal(e.payload.teamKind, 'workflow')
    assert.ok(ofType('team_info').some(e => e.payload.teamName === 'demo-wave'), 'team_info of the workflow')
  })
})
