/**
 * Operator control wiring (#240, PR 3): between the gate and the Agent Lens panel, over postMessage only.
 * No HTTP route is involved, so a web page cannot reach it. The panel must declare a decision surface before any
 * request is held; without one Claude Code is never kept waiting.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { OperatorControl, type ControlPanel } from '../src/operator-control'

function fakePanel(over: Partial<ControlPanel> = {}) {
  const sent: Array<Record<string, unknown>> = []
  const panel: ControlPanel = { isReady: true, controlSurface: false, postMessage: m => { sent.push(m as unknown as Record<string, unknown>) }, ...over }
  return { panel, sent }
}

function setup(opts: { allowed?: boolean; panel?: ControlPanel | undefined; ttlMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-opctl-'))
  const state = { allowed: opts.allowed ?? true, panel: 'panel' in opts ? opts.panel : fakePanel().panel }
  const control = new OperatorControl({
    allowed: () => state.allowed,
    getPanel: () => state.panel,
    journalFile: path.join(dir, 'decisions.jsonl'),
    ttlMs: opts.ttlMs ?? 5000,
  })
  return { control, state, dir, journal: () => (fs.existsSync(path.join(dir, 'decisions.jsonl')) ? fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8') : '') }
}
const ask = (c: OperatorControl, toolUseId: string | null = 'toolu_1') => c.gate.request({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' }, toolUseId })

describe('OperatorControl', () => {
  it('has a fresh 32-byte token per start', () => {
    const a = setup().control.token
    assert.match(a, /^[0-9a-f]{64}$/)
    assert.notEqual(a, setup().control.token)
  })

  it('holds no request until the panel declares a decision surface', async () => {
    const { panel, sent } = fakePanel()
    const { control } = setup({ panel })
    assert.equal(await ask(control).decision, null)
    assert.equal(sent.length, 0)
  })

  it('the setting turned off while requests wait ends them at once (long TTL) and tells the panel', async () => {
    const { panel, sent } = fakePanel()
    const { control, state, journal } = setup({ panel, ttlMs: 5000 })
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    const r = ask(control)
    state.allowed = false
    control.settingChanged()
    assert.equal(await r.decision, null)
    assert.equal(control.gate.pending().length, 0)
    assert.equal(control.discoveryToken(), undefined)
    assert.ok(sent.some(m => m.type === 'permission-closed' && m.outcome === 'disabled'))
    assert.match(journal(), /"outcome":"disabled"/)
  })

  it('the setting changed but still on: waiting requests stay', () => {
    const { panel } = fakePanel()
    const { control } = setup({ panel, ttlMs: 5000 })
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    ask(control)
    control.settingChanged()
    assert.equal(control.gate.pending().length, 1)
    control.dispose()
  })

  it('holds nothing when the setting is off, whatever the panel says', async () => {
    const { panel, sent } = fakePanel()
    const { control } = setup({ panel, allowed: false })
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    assert.equal(await ask(control).decision, null)
    assert.equal(sent.length, 0)
  })

  it('sends the panel each request and how it ended; a decision from the panel answers it', async () => {
    const { panel, sent } = fakePanel()
    const { control, journal } = setup({ panel })
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    const r = ask(control)
    const req = sent.find(m => m.type === 'permission-request') as { request: { nonce: string; toolName: string; inputPreview: string; sessionId: string; toolUseId: string } }
    assert.ok(req)
    assert.equal(req.request.toolName, 'Bash'); assert.equal(req.request.sessionId, 's1'); assert.equal(req.request.toolUseId, 'toolu_1')
    assert.match(req.request.inputPreview, /ls/)

    control.handlePanelMessage(panel, { type: 'permission-decision', sessionId: 's1', toolUseId: 'toolu_1', nonce: req.request.nonce, action: 'approve' })
    assert.deepEqual(await r.decision, { behavior: 'allow' })
    assert.deepEqual(sent.find(m => m.type === 'permission-result'), { type: 'permission-result', nonce: req.request.nonce, ok: true })
    assert.deepEqual(sent.find(m => m.type === 'permission-closed'), { type: 'permission-closed', nonce: req.request.nonce, sessionId: 's1', toolUseId: 'toolu_1', outcome: 'sent' })
    assert.match(journal(), /"outcome":"sent"/)
  })

  it('reports why a decision was refused, and keeps the request open', async () => {
    const { panel, sent } = fakePanel()
    const { control } = setup({ panel })
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    const r = ask(control)
    const nonce = (sent.find(m => m.type === 'permission-request') as { request: { nonce: string } }).request.nonce
    control.handlePanelMessage(panel, { type: 'permission-decision', sessionId: 's1', toolUseId: 'toolu_1', nonce, action: 'redirect', message: '' })
    assert.deepEqual(sent.filter(m => m.type === 'permission-result').at(-1), { type: 'permission-result', nonce, ok: false, reason: 'message-required' })
    assert.equal(control.gate.pending().length, 1)
    control.gate.dispose()
    assert.equal(await r.decision, null)
  })

  it('ignores a decision from a panel that never declared the surface, and a malformed one', () => {
    const { panel, sent } = fakePanel()
    const { control } = setup({ panel })
    control.handlePanelMessage(panel, { type: 'permission-decision', sessionId: 's1', toolUseId: 'toolu_1', nonce: 'f'.repeat(32), action: 'approve' })
    assert.deepEqual(sent.at(-1), { type: 'permission-result', nonce: 'f'.repeat(32), ok: false, reason: 'no-surface' })
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    control.handlePanelMessage(panel, { type: 'permission-decision', nonce: 7 })
    assert.deepEqual(sent.at(-1), { type: 'permission-result', nonce: null, ok: false, reason: 'unknown' })
  })

  it('a panel that declares its surface later gets the requests already waiting', async () => {
    const { panel, sent } = fakePanel()
    const { control, state } = setup({ panel })
    // a first panel is the one that holds the request
    const other = fakePanel()
    state.panel = other.panel
    control.handlePanelMessage(other.panel, { type: 'permission-surface', ready: true })
    ask(control)
    state.panel = panel
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    assert.equal(sent.filter(m => m.type === 'permission-request').length, 1)
    control.gate.dispose()
  })

  it('closing the surface or the panel ends the waiting requests with no decision', async () => {
    const { panel } = fakePanel()
    const { control } = setup({ panel })
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    const a = ask(control, 'a')
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: false })
    assert.equal(await a.decision, null)
    assert.equal(panel.controlSurface, false)
    control.handlePanelMessage(panel, { type: 'permission-surface', ready: true })
    const b = ask(control, 'b')
    control.panelDisposed()
    assert.equal(await b.decision, null)
  })

  it('the discovery token is offered only while the setting is on', () => {
    const { control, state } = setup()
    assert.equal(control.discoveryToken(), control.token)
    state.allowed = false
    assert.equal(control.discoveryToken(), undefined)
  })
})
