/**
 * handlePermissionDetection (#192): a tool call pending for PERMISSION_DETECT_MS with no recent activity is reported
 * as waiting for permission. The timer, the snapshot, the activity check and the re-arm are driven with mock timers.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { handlePermissionDetection, type PermissionState, type PermissionDetectionDelegate } from '../src/permission-detection'
import { PERMISSION_DETECT_MS } from '../src/constants'
import type { AgentEvent, PendingToolCall } from '../src/protocol'

const tool = (name: string, startTime = Date.now()): PendingToolCall => ({ name, args: '', startTime })

let emitted: Array<{ event: AgentEvent; sessionId?: string }>
let lastActivity: number | undefined
let state: PermissionState

const delegate: PermissionDetectionDelegate = {
  emit: (event, sessionId) => { emitted.push({ event, sessionId }) },
  elapsed: () => 42,
  getLastActivityTime: () => lastActivity,
}

const run = (
  pending: Map<string, PendingToolCall>,
  opts: { completed?: boolean; checkActivity?: boolean } = {},
) => handlePermissionDetection(delegate, 'main', pending, state, 's1', opts.completed, opts.checkActivity)

describe('handlePermissionDetection', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    emitted = []
    lastActivity = undefined
    state = { permissionTimer: null, permissionEmitted: false }
  })
  afterEach(() => {
    if (state.permissionTimer) { clearTimeout(state.permissionTimer) }
    mock.timers.reset()
  })

  it('emits permission_requested once PERMISSION_DETECT_MS has elapsed, not before', () => {
    run(new Map([['t1', tool('Bash')]]))
    mock.timers.tick(PERMISSION_DETECT_MS - 1)
    assert.equal(emitted.length, 0)
    mock.timers.tick(1)
    assert.equal(emitted.length, 1)
    assert.deepEqual(emitted[0], {
      sessionId: 's1',
      event: { time: 42, type: 'permission_requested', payload: { agent: 'main', message: 'Waiting for permission' } },
    })
    assert.equal(state.permissionEmitted, true)
  })

  it('arms no timer when only Agent or Task tools are pending', () => {
    run(new Map([['a', tool('Agent')], ['b', tool('Task')]]))
    assert.equal(state.permissionTimer, null)
    mock.timers.tick(PERMISSION_DETECT_MS * 2)
    assert.equal(emitted.length, 0)
  })

  it('arms no timer when nothing is pending', () => {
    run(new Map())
    assert.equal(state.permissionTimer, null)
  })

  it('a non-Agent tool next to an Agent tool still counts', () => {
    run(new Map([['a', tool('Agent')], ['b', tool('Edit')]]))
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 1)
  })

  it('emits nothing when the session completed before the timer fired', () => {
    run(new Map([['t1', tool('Bash')]]), { completed: true })
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 0)
    assert.equal(state.permissionEmitted, false)
  })

  it('emits nothing when the tool finished before the timer fired', () => {
    const pending = new Map([['t1', tool('Bash')]])
    run(pending)
    pending.clear()
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 0)
  })

  it('ignores a tool added after the snapshot (freshly started, not yet waiting)', () => {
    const pending = new Map([['old', tool('Bash')]])
    run(pending)
    pending.clear()
    mock.timers.tick(100)
    pending.set('fresh', tool('Read'))
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 0)
  })

  it('with checkSessionActivity, recent file activity means the tool is running: no emission', () => {
    run(new Map([['t1', tool('Bash')]]), { checkActivity: true })
    mock.timers.tick(PERMISSION_DETECT_MS - 1)
    lastActivity = Date.now() // written just before the timer fires
    mock.timers.tick(1)
    assert.equal(emitted.length, 0)
  })

  it('with checkSessionActivity, an activity older than the threshold does not block the emission', () => {
    lastActivity = Date.now() - 1 // before the arming: stale by the time the timer fires
    run(new Map([['t1', tool('Bash')]]), { checkActivity: true })
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 1)
  })

  it('with checkSessionActivity and no known activity, it still emits', () => {
    lastActivity = undefined
    run(new Map([['t1', tool('Bash')]]), { checkActivity: true })
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 1)
  })

  it('without checkSessionActivity (subagents) recent activity is ignored', () => {
    lastActivity = Date.now() + 1000
    run(new Map([['t1', tool('Bash')]]))
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 1)
  })

  it('re-arming after an emission sends agent_idle first, then restarts the detection', () => {
    const pending = new Map([['t1', tool('Bash')]])
    run(pending)
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(state.permissionEmitted, true)

    run(pending)
    assert.equal(emitted.length, 2)
    assert.deepEqual(emitted[1], {
      sessionId: 's1',
      event: { time: 42, type: 'agent_idle', payload: { name: 'main' } },
    })
    assert.equal(state.permissionEmitted, false)
    assert.notEqual(state.permissionTimer, null, 'the tool is still pending: detection restarts')
    mock.timers.tick(PERMISSION_DETECT_MS)
    assert.equal(emitted.length, 3)
    assert.equal(emitted[2].event.type, 'permission_requested')
  })

  it('re-arming with nothing pending sends agent_idle and leaves no timer', () => {
    const pending = new Map([['t1', tool('Bash')]])
    run(pending)
    mock.timers.tick(PERMISSION_DETECT_MS)
    pending.clear()
    run(pending)
    assert.deepEqual(emitted.map(e => e.event.type), ['permission_requested', 'agent_idle'])
    assert.equal(state.permissionTimer, null)
  })

  it('a second call before the timer fires cancels the first timer (one emission only)', () => {
    const pending = new Map([['t1', tool('Bash')]])
    run(pending)
    mock.timers.tick(PERMISSION_DETECT_MS - 1000)
    run(pending)
    mock.timers.tick(PERMISSION_DETECT_MS - 1)
    assert.equal(emitted.length, 0)
    mock.timers.tick(1)
    assert.equal(emitted.length, 1)
  })
})
