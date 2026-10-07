/**
 * Relay + Workflow tool runs (#79): a synthetic ~/.claude tree in a fake HOME with an orchestrator
 * session and two workflows (one running, one finished). The relay must announce EVERY workflow agent
 * (idle ones included) as a teammate of a group named after the workflow script, report team_info with
 * teamKind 'workflow', give each agent an activity and never complete a visible member.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-workflows-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const ORCH = '33333333-3333-4333-8333-333333333333'

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
    // Finished workflow: journal shows every agent with a result
    fs.writeFileSync(path.join(scripts, 'older-run-wf_fin2-bbb.js'), '')
    addAgent('wf_fin2-bbb', 'fin00004', 'impl:old', 'Implement', [user('go'), text('done')], 5 * MIN)
    fs.writeFileSync(path.join(subDir, 'workflows', 'wf_fin2-bbb', 'journal.jsonl'),
      line({ type: 'launched' }) + line({ type: 'started', agentId: 'fin00004', label: 'impl:old', phase: 'Implement' }) +
      line({ type: 'result', agentId: 'fin00004', result: { ok: true } }))

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

  it('announces every agent of both workflows, idle and finished ones included', () => {
    const spawns = ofType('agent_spawn').filter(e => e.payload.kind === 'teammate')
    const byName = new Map(spawns.map(e => [String(e.payload.name), e.payload]))
    assert.deepEqual([...byName.keys()].sort(), ['impl:build', 'impl:docs', 'impl:old', 'review:build'])
    assert.equal(byName.get('impl:build')?.teamName, 'demo-wave')
    assert.equal(byName.get('impl:old')?.teamName, 'older-run')
    for (const p of byName.values()) {
      assert.equal(p.teamKind, 'workflow')
      assert.equal(p.agentType, 'workflow-subagent')
    }
  })

  it('reports working / idle / done per agent and never completes a visible member', () => {
    const act = new Map(ofType('agent_activity').map(e => [String(e.payload.name), e.payload.activity]))
    assert.equal(act.get('impl:build'), 'working', 'pending tool_use')
    assert.equal(act.get('impl:docs'), 'idle', 'turn ended 30 s ago')
    assert.equal(act.get('review:build'), 'done', 'final text and silent for 3 minutes')
    assert.equal(act.get('impl:old'), 'done', 'the journal shows its result')
    assert.equal(ofType('agent_complete').filter(e => e.payload.name !== 'orchestrator').length, 0)
  })

  it('emits one team_info per workflow with teamKind workflow, the orchestrator as lead and the phases', () => {
    const infos = ofType('team_info').map(e => e.payload as {
      teamName: string; teamKind: string; leadSessionId: string; members: Array<{ name: string; phase?: string; agentType?: string }>
    })
    const run = infos.filter(i => i.teamName === 'demo-wave').at(-1)!
    assert.ok(run, 'running workflow reported')
    assert.equal(run.teamKind, 'workflow')
    assert.equal(run.leadSessionId, ORCH)
    assert.deepEqual(run.members.map(m => m.name).sort(), ['impl:build', 'impl:docs', 'review:build'])
    assert.equal(run.members.find(m => m.name === 'review:build')?.phase, 'Review')
    const fin = infos.filter(i => i.teamName === 'older-run').at(-1)!
    assert.deepEqual(fin.members.map(m => m.name), ['impl:old'])
  })
})
