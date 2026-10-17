// #513: stop channel of the relay over the Node IPC channel of its parent (the tray driver), without SIGTERM.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { IPC_STOP_FLAG, STOP_MESSAGE, isStopMessage, watchParentStop } from './parent-stop'
import { parseArgs } from './args'

/** A process with (or without) an IPC channel opened by its parent */
function fakeProcess(channel = true) {
  const proc = new EventEmitter() as EventEmitter & { send?: (m: unknown) => boolean; connected?: boolean }
  if (channel) { proc.send = () => true; proc.connected = true }
  return proc
}

describe('isStopMessage: only the exact stop message', () => {
  it('accepts {v:1,type:"stop"}', () => {
    assert.equal(isStopMessage({ v: 1, type: 'stop' }), true)
    assert.equal(isStopMessage(JSON.parse(JSON.stringify(STOP_MESSAGE))), true)
  })
  it('refuses everything else', () => {
    const big = { v: 1, type: 'stop', pad: 'x'.repeat(100_000) }
    for (const m of [
      undefined, null, 'stop', 'agent-lens:stop', 1, true, [], ['stop'], [{ v: 1, type: 'stop' }],
      {}, { type: 'stop' }, { v: 1 }, { v: 2, type: 'stop' }, { v: '1', type: 'stop' }, { v: 1, type: 'STOP' },
      { v: 1, type: 'stop ' }, { v: 1, type: 'quit' }, { v: 1, type: 'stop', extra: 1 }, big,
      { v: 1, type: 'stop', cmd: 'NODE_HANDLE' }, Object.assign(Object.create({ v: 1, type: 'stop' }), {}),
    ]) assert.equal(isStopMessage(m), false, JSON.stringify(m)?.slice(0, 80))
  })
  it('refuses an object whose prototype is not Object (class instance)', () => {
    class M { v = 1; type = 'stop' }
    assert.equal(isStopMessage(new M()), false)
  })
})

describe('watchParentStop', () => {
  it('refuses to start without an IPC channel from a parent (the flag alone is not enough)', () => {
    const r = watchParentStop(fakeProcess(false))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /--ipc-stop/)
    const disconnected = fakeProcess()
    disconnected.connected = false
    assert.equal(watchParentStop(disconnected).ok, false)
  })

  it('runs the clean-up once on the stop message', () => {
    const proc = fakeProcess()
    const r = watchParentStop(proc)
    assert.ok(r.ok)
    let runs = 0
    r.onStop(() => { runs++ })
    proc.emit('message', { v: 1, type: 'stop' })
    proc.emit('message', { v: 1, type: 'stop' })
    proc.emit('disconnect')
    assert.equal(runs, 1)
  })

  it('runs the clean-up when the parent goes away (no orphan relay)', () => {
    const proc = fakeProcess()
    const r = watchParentStop(proc)
    assert.ok(r.ok)
    let runs = 0
    r.onStop(() => { runs++ })
    proc.emit('disconnect')
    assert.equal(runs, 1)
  })

  it('remembers a stop asked before the server is ready and runs it once the clean-up is known', () => {
    const proc = fakeProcess()
    const r = watchParentStop(proc)
    assert.ok(r.ok)
    proc.emit('message', { v: 1, type: 'stop' })
    let runs = 0
    r.onStop(() => { runs++ })
    assert.equal(runs, 1)
  })

  it('ignores hostile messages, logs a bounded number of fixed lines, never their content', () => {
    const proc = fakeProcess()
    const logs: string[] = []
    const r = watchParentStop(proc, m => logs.push(m))
    assert.ok(r.ok)
    let runs = 0
    r.onStop(() => { runs++ })
    for (let i = 0; i < 50; i++) proc.emit('message', { v: 1, type: 'stop', secret: `s3cr3t-${i}` })
    proc.emit('message', 'stop')
    proc.emit('message', { v: 1, type: 'stop', pad: 'x'.repeat(100_000) })
    assert.equal(runs, 0)
    assert.ok(logs.length >= 1 && logs.length <= 3, `bounded logs: ${logs.length}`)
    assert.ok(logs.every(l => !l.includes('s3cr3t') && l.length < 200))
  })

  it('ignores a message carrying a handle, even the exact stop message, and closes the handle', () => {
    const proc = fakeProcess()
    const r = watchParentStop(proc, () => {})
    assert.ok(r.ok)
    let runs = 0
    let closed = 0
    r.onStop(() => { runs++ })
    proc.emit('message', { v: 1, type: 'stop' }, { destroy: () => { closed++ } })
    assert.equal(runs, 0)
    assert.equal(closed, 1)
  })
})

describe('--ipc-stop: an explicit internal flag, off by default', () => {
  it('is off without the flag', () => {
    assert.equal(parseArgs([]).ipcStop, false)
    assert.equal(parseArgs(['--port', '0', '--no-open']).ipcStop, false)
  })
  it('is on only with the exact flag', () => {
    assert.equal(IPC_STOP_FLAG, '--ipc-stop')
    assert.equal(parseArgs(['--port', '0', '--no-open', '--ipc-stop']).ipcStop, true)
    assert.equal(parseArgs(['--ipc-stop=1']).ipcStop, false)
    assert.equal(parseArgs(['--IPC-STOP']).ipcStop, false)
  })
})
