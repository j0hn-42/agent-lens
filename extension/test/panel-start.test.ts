/**
 * The page start of the VS Code panel with a real SessionWatcher (#592, #601 review): the order of the messages a
 * page receives on `ready`, and the `event-loss` it ends with, computed from what the watcher really emitted
 * through the wiring (transcript history, hook events) minus what its replay really re-sent. Also the JSONL log path,
 * and a session unwatched then rediscovered, whose history is emitted again: counted once, and the open page's
 * figure lowered.
 */
import './helpers/alias-vscode'
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, ExtensionToWebviewMessage } from '../src/protocol'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-panel-start-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

const SESSION = '77777777-7777-4777-8777-777777777777'
const line = (o: unknown) => JSON.stringify(o) + '\n'

type Mods = {
  SessionWatcher: typeof import('../src/session-watcher').SessionWatcher
  runtime: typeof import('../src/session-runtime')
  startPanelPage: typeof import('../src/panel-start').startPanelPage
  panelLoss: typeof import('../src/panel-loss').panelLoss
  VisualizerPanel: typeof import('../src/webview-provider').VisualizerPanel
}

type Internals = { unwatchSession(id: string): void; watchSession(id: string, filePath: string): void }

class FakePanel {
  ready = false
  readonly messages: ExtensionToWebviewMessage[] = []
  get isReady(): boolean { return this.ready }
  markReady(): void { this.ready = true }
  postMessage(m: ExtensionToWebviewMessage): void { this.messages.push(m) }
  sendEvent(event: AgentEvent): void { this.postMessage({ type: 'agent-event', event }) }
  setConnectionStatus(status: 'watching', source: string): void { this.postMessage({ type: 'connection-status', status, source }) }
}

const losses = (p: FakePanel) => p.messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'event-loss' }> => m.type === 'event-loss')
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
/** The attach is queued and read over several ticks (#651): waits until the session is announced and its history delivered */
async function attached(watcher: unknown): Promise<void> {
  const w = watcher as { sessions: Map<string, { sessionDetected: boolean }>; reconciler: { isLoading: boolean } }
  const done = () => w.sessions.get(SESSION)?.sessionDetected === true && !w.reconciler.isLoading
  // Bounded in time, not in turns: the reads go through the libuv pool, slower on a loaded machine
  for (const deadline = Date.now() + 10_000; !done() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 2))
  assert.ok(done(), 'the session is attached')
}

describe('panel page start with a real SessionWatcher (#592)', () => {
  let m: Mods
  let transcript = ''
  const setPanel = (p: FakePanel | undefined) => { (m.VisualizerPanel as unknown as { instance: unknown }).instance = p }

  before(async () => {
    const vscodeShim = require('vscode') as { window: Record<string, unknown> }
    vscodeShim.window.setStatusBarMessage = () => ({ dispose() {} })
    m = {
      SessionWatcher: (await import('../src/session-watcher')).SessionWatcher,
      runtime: await import('../src/session-runtime'),
      startPanelPage: (await import('../src/panel-start')).startPanelPage,
      panelLoss: (await import('../src/panel-loss')).panelLoss,
      VisualizerPanel: (await import('../src/webview-provider')).VisualizerPanel,
    }
    const cwd = fs.realpathSync(process.cwd())
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    transcript = path.join(projectDir, `${SESSION}.jsonl`)
    const ts = new Date().toISOString()
    fs.writeFileSync(transcript,
      line({ type: 'user', cwd, timestamp: ts, message: { role: 'user', content: 'Run the build' } }) +
      line({ type: 'assistant', cwd, timestamp: ts, message: { role: 'assistant', model: 'claude-test', content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm build' } },
      ] } }))
  })
  after(() => { setPanel(undefined); fs.rmSync(fakeHome, { recursive: true, force: true }) })
  beforeEach(() => { m.panelLoss.clear(); setPanel(undefined) })

  function harness() {
    const watcher = new m.SessionWatcher()
    const emitted: AgentEvent[] = []
    watcher.onEvent(e => emitted.push(e))
    const hooks: AgentEvent[] = []
    watcher.onHookEvent(e => hooks.push(e))
    const wiring = m.runtime.wireWatcherToPanel(watcher, { sessionLabelPrefix: 'Claude' })
    const hookWiring = m.runtime.wireHookEventsToPanel(watcher)
    const start = (panel: FakePanel) => m.startPanelPage(panel, {
      collectActiveSessions: () => watcher.getActiveSessions(),
      replaySessions: ids => watcher.replaySessionStart(ids),
      disable1MContext: () => false,
      hooksConfigured: () => true,
      connectionStatus: () => 'Session watcher',
      isCurrent: () => m.VisualizerPanel.getCurrent() === (panel as unknown),
    })
    const dispose = () => { hookWiring.dispose(); wiring.dispose(); watcher.dispose() }
    return { watcher, emitted, hooks, start, dispose }
  }

  it('on ready: reset, config, session list, the replay, then event-loss = what was emitted before minus what the replay re-sent', async () => {
    const h = harness()
    try {
      h.watcher.start()
      await attached(h.watcher)
      h.watcher.submitHookEvent({ time: 2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', toolUseId: 'hook-only' }, sessionId: SESSION } as AgentEvent)
      const before = h.emitted.length + h.hooks.length
      assert.ok(h.emitted.length > 0 && h.hooks.length === 1, 'precondition: history and one surviving hook event, no panel')

      const panel = new FakePanel()
      setPanel(panel)
      h.start(panel)
      const types = panel.messages.map(x => x.type)
      const listAt = types.indexOf('session-list')
      const lossAt = types.indexOf('event-loss')
      assert.deepEqual(types.slice(0, 3), ['reset', 'config', 'session-list'], 'reset first, the session list before any replayed event')
      const between = panel.messages.slice(listAt + 1, lossAt)
      // The replay also re-announces the detected session (status line)
      assert.ok(between.every(x => x.type === 'agent-event' || x.type === 'connection-status'))
      const replayed = between.filter(x => x.type === 'agent-event')
      assert.ok(replayed.length > 0, 'the replay comes between the list and the figure')
      assert.deepEqual(types.slice(lossAt), ['event-loss', 'connection-status'])
      assert.equal(losses(panel).length, 1)
      assert.deepEqual(losses(panel)[0], { type: 'event-loss', evicted: { [SESSION]: before - replayed.length } })
      assert.ok(before - replayed.length > 0)

      // Live from now on: delivered to the page, and counted for a page that opens later (it gets a reset, not them)
      h.watcher.submitHookEvent({ time: 3, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Grep', toolUseId: 'live' }, sessionId: SESSION } as AgentEvent)
      assert.equal(panel.messages.at(-1)?.type, 'agent-event')
      const later = new FakePanel()
      setPanel(later)
      h.start(later)
      const laterReplayed = later.messages.filter(x => x.type === 'agent-event').length
      assert.equal(laterReplayed, replayed.length, 'the same agents are re-sent')
      assert.deepEqual(losses(later)[0].evicted, { [SESSION]: before + 1 - laterReplayed })
    } finally { h.dispose() }
  })

  it('a session unwatched then rediscovered: its history is not counted twice, and the open page\'s figure is lowered', async () => {
    const h = harness()
    try {
      h.watcher.start()
      await attached(h.watcher)
      const base = h.emitted.length
      const panel = new FakePanel()
      setPanel(panel)
      h.start(panel)
      const first = losses(panel)[0].evicted[SESSION]
      assert.ok(first > 0)

      const internals = h.watcher as unknown as Internals
      internals.unwatchSession(SESSION)
      const n = h.emitted.length
      internals.watchSession(SESSION, transcript)
      await attached(h.watcher)
      const reread = h.emitted.slice(n).filter(e => e.replayed === true).length
      assert.ok(reread > 0, 'precondition: the history is emitted again, marked replayed')
      await flush()
      const updates = losses(panel)
      assert.equal(updates.length, 2, 'one update for the history read again')
      const lowered = Math.max(0, first - reread)
      assert.deepEqual(updates[1].evicted, lowered > 0 ? { [SESSION]: lowered } : {})

      // A page that opens now lacks the events counted once: never the history twice
      const later = new FakePanel()
      setPanel(later)
      h.start(later)
      const resent = later.messages.filter(x => x.type === 'agent-event').length
      const total = Math.max(base, reread) + h.emitted.slice(n).filter(e => e.replayed !== true).length
      assert.ok(total < base + (h.emitted.length - n), 'precondition: the sum would be larger')
      assert.deepEqual(losses(later)[0]?.evicted ?? {}, total - resent > 0 ? { [SESSION]: total - resent } : {})
    } finally { h.dispose() }
  })

  it('a team lead unwatched then rediscovered: its team_info is re-sent as replayed and the figure does not grow (#605 review)', async () => {
    const teamDir = path.join(fakeHome, '.claude', 'teams', 'demo-team')
    fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true })
    fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({
      name: 'demo-team', leadAgentId: 'team-lead@demo-team', leadSessionId: SESSION,
      members: [
        { agentId: 'team-lead@demo-team', name: 'team-lead', backendType: 'in-process' },
        { agentId: 'alice@demo-team', name: 'alice', backendType: 'in-process' },
      ],
    }))
    const h = harness()
    try {
      h.watcher.start()
      await attached(h.watcher)
      const internals = h.watcher as unknown as Internals & { teamWatcher: { scan(): void } }
      internals.teamWatcher.scan()
      const infos = () => h.emitted.filter(e => e.type === 'team_info')
      assert.equal(infos().length, 1, 'precondition: the team is announced once')
      const counted = m.panelLoss.snapshotAfterReplay(() => {})?.evicted[SESSION]
      assert.ok(counted && counted > 0)

      internals.unwatchSession(SESSION)
      internals.watchSession(SESSION, transcript)
      await attached(h.watcher)
      internals.teamWatcher.scan()
      assert.equal(infos().length, 2, 'precondition: the rediscovered lead gets its team_info again')
      assert.equal(infos()[1].replayed, true, 'a team_info already sent is re-sent as known state')
      assert.deepEqual(m.panelLoss.snapshotAfterReplay(() => {})?.evicted, { [SESSION]: counted },
        'the history read again and the team_info re-sent repeat what was counted: same figure')
    } finally {
      h.dispose()
      fs.rmSync(path.join(fakeHome, '.claude', 'teams'), { recursive: true, force: true })
    }
  })

  it('the JSONL log path: sent to the panel even before its page is ready, and counted either way', () => {
    const panel = new FakePanel()
    setPanel(panel)
    const event = { time: 1, type: 'message', payload: { agent: 'a' }, sessionId: 'log-1' } as unknown as AgentEvent
    m.runtime.forwardToPanel(event, { requireReady: false })
    assert.equal(panel.messages.length, 1)
    m.runtime.forwardToPanel(event)
    assert.equal(panel.messages.length, 1, 'the default waits for a ready page')
    assert.deepEqual(m.panelLoss.snapshotAfterReplay(() => {}), { evicted: { 'log-1': 2 } })
  })

  it('extension.ts and claude-runtime.ts go through these paths (no counting left inline)', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')
    const ext = src('extension.ts')
    assert.match(ext, /startPanelPage\(panel, \{/)
    assert.match(ext, /panel\.onDisposed\(\(\) => page\.end\(\)\)/, 'a closed panel lets its page figure go')
    assert.match(ext, /eventSourceWiring = wireJsonlSourceToPanel\(source\)/)
    assert.match(ext, /eventSourceWiring\?\.dispose\(\)/)
    assert.doesNotMatch(ext, /panelLoss\./)
    const claude = src('claude-runtime.ts')
    assert.match(claude, /wireHookEventsToPanel\(watcher\)/)
    assert.doesNotMatch(claude, /panelLoss\./)
  })
})
