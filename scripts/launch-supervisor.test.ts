/**
 * #229 PR 2: the process supervisor of "launch an agent on an issue". The spawn, the group kill, the clock and the
 * journal are injected: no process is started here. Every state is asserted to appear ONLY when its fact was
 * observed (reading-the-ui.md): no "started" without the spawn event, no "session" without the transcript.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildLaunchCommand, LAUNCH_CAPS, type LaunchCommand, type LaunchRequest } from '../extension/src/launch-policy'
import {
  createLaunchSupervisor, launchEnv, RingBuffer, KILL_GRACE_MS,
  type ChildLike, type JournalEntry, type LaunchView, type SupervisorDeps,
} from './launch-supervisor'

const REPO = 'j0hn-42/agent-lens'
const UUID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b'
const req = (issue = 229, role = 'backend-engineer'): LaunchRequest => ({ repo: REPO, issue, role })
const cmd = (r: LaunchRequest = req(), sessionId = UUID): LaunchCommand => {
  const out = buildLaunchCommand(r, { sessionId })
  if (!out.ok) throw new Error('fixture')
  return out.value
}

class FakeChild extends EventEmitter {
  pid: number | undefined
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed: string[] = []
  constructor(pid?: number) { super(); this.pid = pid }
  kill(signal?: string) { this.killed.push(signal ?? 'SIGTERM'); return true }
}

function fakeClock() {
  let t = 1_000_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: t + ms, fn }); return id },
    clearTimer: (id: unknown) => { timers.delete(id as number) },
    advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0]); t = due[1].at; due[1].fn()
      }
      t = end
    },
    pending: () => timers.size,
  }
}

function setup(over: Partial<SupervisorDeps> = {}) {
  const clock = fakeClock()
  const children: FakeChild[] = []
  const spawned: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
  const kills: Array<[number, string]> = []
  const journal: JournalEntry[] = []
  const changes: LaunchView[] = []
  let pid = 4000
  const sup = createLaunchSupervisor({
    workspace: '/work/space',
    spawn: (file, args, opts) => { spawned.push({ file, args, opts: opts as unknown as Record<string, unknown> }); const c = new FakeChild(++pid); children.push(c); return c as ChildLike },
    killGroup: (p, s) => { kills.push([p, s]) },
    journal: { append: e => { journal.push(e); return true } },
    clock, randomId: (() => { let n = 0; return () => (++n).toString(16).padStart(16, '0') })(),
    env: { PATH: '/bin', HOME: '/home/u', AGENT_LENS_LAUNCH_TOKEN: 'secret-token', GITHUB_TOKEN: 'gh', SOMETHING_ELSE: 'x' },
    onChange: v => changes.push(v),
    ...over,
  })
  return { sup, clock, children, spawned, kills, journal, changes }
}

const started = (s: ReturnType<typeof setup>, r = req(), c = cmd(r, UUID)) => {
  const out = s.sup.start(r, c)
  assert.equal(out.ok, true)
  return out.ok ? out.launch : (undefined as never)
}

describe('lifecycle: each state only once observed', () => {
  it('requested has no pid; started needs the spawn event; session needs the transcript; exit gives the code', () => {
    const s = setup()
    const l = started(s)
    assert.equal(l.state, 'requested')
    assert.equal(l.pid, undefined)
    assert.equal(s.spawned.length, 1)
    // The child exists and has a pid, but the spawn was not observed yet: still "requested", no pid shown
    assert.equal(s.sup.get(l.id)?.state, 'requested')
    assert.equal(s.sup.get(l.id)?.pid, undefined)
    s.children[0].emit('spawn')
    assert.equal(s.sup.get(l.id)?.state, 'started')
    assert.equal(s.sup.get(l.id)?.pid, 4001)
    s.sup.sessionSeen(UUID)
    assert.equal(s.sup.get(l.id)?.state, 'session')
    s.children[0].emit('exit', 0, null)
    const end = s.sup.get(l.id)
    assert.equal(end?.state, 'exited')
    assert.equal(end?.exitCode, 0)
    assert.equal(end?.sessionSeenAt !== undefined, true)
  })

  it('a session seen before the spawn event is applied only when the start is observed', () => {
    const s = setup()
    const l = started(s)
    s.sup.sessionSeen(UUID)
    assert.equal(s.sup.get(l.id)?.state, 'requested')
    s.children[0].emit('spawn')
    assert.equal(s.sup.get(l.id)?.state, 'session')
  })

  it('a session id that is not a launch of ours changes nothing', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    s.sup.sessionSeen('11111111-1111-4111-8111-111111111111')
    assert.equal(s.sup.get(l.id)?.state, 'started')
  })

  it('a non-zero exit is "exited" with its code, a signal death keeps the signal name', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    s.children[0].emit('exit', 3, null)
    assert.deepEqual([s.sup.get(l.id)?.state, s.sup.get(l.id)?.exitCode], ['exited', 3])
    const s2 = setup()
    const l2 = started(s2)
    s2.children[0].emit('spawn')
    s2.children[0].emit('exit', null, 'SIGSEGV')
    assert.equal(s2.sup.get(l2.id)?.exitCode, undefined)
    assert.equal(s2.sup.get(l2.id)?.signal, 'SIGSEGV')
  })

  it('spawn throwing, or an error event, is "failed" with a bounded code, and frees the slot', () => {
    const s = setup({ spawn: () => { throw new Error('boom /secret/path') } })
    const out = s.sup.start(req(), cmd())
    assert.equal(out.ok, true)
    const l = out.ok ? out.launch : undefined
    assert.equal(l?.state, 'failed')
    assert.equal(l?.failure, 'spawn-error')
    assert.equal(JSON.stringify(l).includes('secret'), false)
    assert.equal(s.sup.start(req(230), cmd(req(230), '22222222-2222-4222-8222-222222222222')).ok, true)

    const s2 = setup()
    const l2 = started(s2)
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    s2.children[0].emit('error', err)
    assert.equal(s2.sup.get(l2.id)?.state, 'failed')
    assert.equal(s2.sup.get(l2.id)?.failure, 'ENOENT')
    assert.equal(s2.sup.get(l2.id)?.pid, undefined)
  })

  it('an exit seen before any spawn event is a failure, not an "exited"', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('exit', 1, null)
    assert.equal(s.sup.get(l.id)?.state, 'failed')
    assert.equal(s.sup.get(l.id)?.failure, 'exit-before-start')
  })

  it('spawns claude without a shell, in its own group, in the workspace, with a filtered environment', () => {
    const s = setup()
    started(s)
    const { file, args, opts } = s.spawned[0]
    assert.equal(file, 'claude')
    assert.deepEqual(args, cmd().args)
    assert.equal(opts.shell, false)
    assert.equal(opts.detached, true)
    assert.equal(opts.cwd, '/work/space')
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
    const env = opts.env as Record<string, string>
    assert.equal(env.PATH, '/bin')
    assert.equal(env.GITHUB_TOKEN, 'gh')
    assert.equal('AGENT_LENS_LAUNCH_TOKEN' in env, false)
    assert.equal('SOMETHING_ELSE' in env, false)
  })

  it('refuses any file other than claude', () => {
    const s = setup()
    const bad = { ...cmd(), file: 'sh' } as unknown as LaunchCommand
    const out = s.sup.start(req(), bad)
    assert.equal(out.ok, false)
    assert.equal(s.spawned.length, 0)
  })

  it('views are copies: changing one does not change the supervisor', () => {
    const s = setup()
    const l = started(s)
    ;(l as { state: string }).state = 'exited'
    assert.equal(s.sup.get(l.id)?.state, 'requested')
  })

  it('every change is announced with the new view', () => {
    const s = setup()
    started(s)
    s.children[0].emit('spawn')
    s.sup.sessionSeen(UUID)
    s.children[0].emit('exit', 0, null)
    assert.deepEqual(s.changes.map(c => c.state), ['requested', 'started', 'session', 'exited'])
  })
})

describe('stop and expiry', () => {
  it('stop sends SIGTERM to the group, SIGKILL after 10 s, and is "stopped" only once the exit is seen', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    const r = s.sup.stop(l.id)
    assert.equal(r.ok, true)
    assert.deepEqual(s.kills, [[4001, 'SIGTERM']])
    assert.equal(s.sup.get(l.id)?.state, 'started', 'not stopped until the exit is observed')
    assert.equal(s.sup.get(l.id)?.stopRequestedAt !== undefined, true)
    assert.equal(KILL_GRACE_MS, 10_000)
    s.clock.advance(KILL_GRACE_MS - 1)
    assert.equal(s.kills.length, 1)
    s.clock.advance(1)
    assert.deepEqual(s.kills, [[4001, 'SIGTERM'], [4001, 'SIGKILL']])
    s.children[0].emit('exit', null, 'SIGKILL')
    assert.equal(s.sup.get(l.id)?.state, 'stopped')
    assert.equal(s.clock.pending(), 0, 'no timer left behind')
  })

  it('an exit within the grace period cancels the SIGKILL', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    s.sup.stop(l.id)
    s.children[0].emit('exit', 0, 'SIGTERM')
    s.clock.advance(60 * 60_000)
    assert.deepEqual(s.kills, [[4001, 'SIGTERM']])
    assert.equal(s.sup.get(l.id)?.state, 'stopped')
  })

  it('stop twice signals once; stop on an ended or unknown launch says so', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    s.sup.stop(l.id)
    assert.equal(s.sup.stop(l.id).ok, true)
    assert.equal(s.kills.length, 1)
    s.children[0].emit('exit', 0, null)
    assert.deepEqual(s.sup.stop(l.id), { ok: false, reason: 'ended' })
    assert.deepEqual(s.sup.stop('ffffffffffffffff'), { ok: false, reason: 'unknown' })
  })

  it('a stop asked before the spawn is observed is carried out as soon as the pid is known', () => {
    const s = setup()
    const l = started(s)
    s.sup.stop(l.id)
    assert.equal(s.kills.length, 0, 'no pid yet, no signal')
    s.children[0].emit('spawn')
    assert.deepEqual(s.kills, [[4001, 'SIGTERM']])
  })

  it('a process that is already gone (ESRCH) is not an error; the exit event settles the state', () => {
    const s = setup({ killGroup: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }) } })
    const l = started(s)
    s.children[0].emit('spawn')
    assert.equal(s.sup.stop(l.id).ok, true)
    s.children[0].emit('exit', 0, null)
    assert.equal(s.sup.get(l.id)?.state, 'stopped')
  })

  it('another kill failure falls back to the child handle and is journaled', () => {
    const s = setup({ killGroup: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }) } })
    const l = started(s)
    s.children[0].emit('spawn')
    s.sup.stop(l.id)
    assert.deepEqual(s.children[0].killed, ['SIGTERM'])
    assert.equal(s.journal.some(e => e.event === 'signal-failed'), true)
  })

  it('the wall clock (60 min) stops the run and the final state is "expired"', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    assert.equal(LAUNCH_CAPS.wallClockMs, 3_600_000)
    s.clock.advance(LAUNCH_CAPS.wallClockMs - 1)
    assert.equal(s.kills.length, 0)
    s.clock.advance(1)
    assert.deepEqual(s.kills, [[4001, 'SIGTERM']])
    assert.equal(s.sup.get(l.id)?.state, 'started')
    s.children[0].emit('exit', null, 'SIGTERM')
    assert.equal(s.sup.get(l.id)?.state, 'expired')
  })

  it('a process that ended on its own before the deadline has no expiry timer left', () => {
    const s = setup()
    started(s)
    s.children[0].emit('spawn')
    s.children[0].emit('exit', 0, null)
    assert.equal(s.clock.pending(), 0)
  })
})

describe('caps', () => {
  it('one simultaneous launch by default, a second is refused until the first ended', () => {
    const s = setup()
    const l = started(s)
    const second = s.sup.start(req(230), cmd(req(230), '22222222-2222-4222-8222-222222222222'))
    assert.deepEqual(second, { ok: false, reason: 'concurrent' })
    s.children[0].emit('spawn'); s.children[0].emit('exit', 0, null)
    assert.equal(s.sup.get(l.id)?.state, 'exited')
    assert.equal(s.sup.start(req(230), cmd(req(230), '22222222-2222-4222-8222-222222222222')).ok, true)
  })

  it('two at most when configured; more than two is a configuration error', () => {
    const s = setup({ maxConcurrent: 2 })
    started(s)
    assert.equal(s.sup.start(req(230), cmd(req(230), '22222222-2222-4222-8222-222222222222')).ok, true)
    assert.deepEqual(s.sup.start(req(231), cmd(req(231), '33333333-3333-4333-8333-333333333333')), { ok: false, reason: 'concurrent' })
    assert.throws(() => setup({ maxConcurrent: 3 }), /maxConcurrent/)
    assert.throws(() => setup({ maxConcurrent: 0 }), /maxConcurrent/)
  })

  it('one launch per issue, whatever the role, even with room for two', () => {
    const s = setup({ maxConcurrent: 2 })
    started(s)
    assert.deepEqual(s.sup.start(req(229, 'qa-engineer'), cmd(req(229, 'qa-engineer'), '22222222-2222-4222-8222-222222222222')), { ok: false, reason: 'issue-active' })
    assert.equal(s.sup.check(req(229, 'qa-engineer')), 'issue-active')
    assert.equal(s.sup.check(req(230)), null)
  })

  it('the repository is part of the issue key (case-insensitive)', () => {
    const s = setup({ maxConcurrent: 2 })
    started(s)
    const upper = { repo: REPO.toUpperCase(), issue: 229, role: 'backend-engineer' }
    assert.equal(s.sup.check(upper), 'issue-active')
  })

  it('a failed spawn does not count as running', () => {
    let first = true
    const s = setup({ spawn: (f, a, o) => { if (first) { first = false; throw new Error('x') } return new FakeChild(9) as ChildLike } })
    s.sup.start(req(), cmd())
    assert.equal(s.sup.start(req(), cmd()).ok, true)
  })

  it('the history of ended launches is bounded', () => {
    const s = setup({ historyMax: 3 })
    for (let i = 1; i <= 6; i++) {
      const l = started(s, req(i), cmd(req(i), `${i}${i}${i}${i}${i}${i}${i}${i}-1111-4111-8111-111111111111`))
      s.children[i - 1].emit('spawn'); s.children[i - 1].emit('exit', 0, null)
      void l
    }
    assert.equal(s.sup.list().length, 3)
    assert.deepEqual(s.sup.list().map(l => l.issue), [4, 5, 6])
  })
})

describe('output ring buffer (256 KiB)', () => {
  it('keeps the last bytes, counts what it dropped, never grows', () => {
    const rb = new RingBuffer(8)
    rb.write(Buffer.from('abcdef'))
    rb.write(Buffer.from('ghij'))
    assert.equal(rb.toString(), 'cdefghij')
    assert.equal(rb.totalBytes, 10)
    assert.equal(rb.droppedBytes, 2)
    rb.write(Buffer.from('0123456789ABCDEF'))
    assert.equal(rb.toString(), '89ABCDEF')
    assert.equal(rb.droppedBytes, 18)
    rb.write(Buffer.alloc(0))
    assert.equal(rb.toString(), '89ABCDEF')
  })

  it('the supervisor buffers stdout and stderr up to the cap and exposes sizes, not content, in the view', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    for (let i = 0; i < 40; i++) s.children[0].stdout.emit('data', Buffer.alloc(10_000, 'a'))
    s.children[0].stderr.emit('data', 'warning text')
    const view = s.sup.get(l.id)
    assert.equal(view?.outputBytes, 400_000 + 12)
    assert.equal(view?.outputDroppedBytes, 400_012 - LAUNCH_CAPS.outputBufferBytes)
    assert.equal(s.sup.tail(l.id).length, LAUNCH_CAPS.outputBufferBytes)
    assert.equal(JSON.stringify(view).includes('warning'), false)
  })

  it('an unknown launch has an empty tail', () => {
    assert.equal(setup().sup.tail('ffffffffffffffff'), '')
  })
})

describe('journal', () => {
  it('records each step with the fields of the design, never the token', () => {
    const s = setup()
    const l = started(s)
    s.children[0].emit('spawn')
    s.sup.sessionSeen(UUID)
    s.clock.advance(5000)
    s.sup.stop(l.id)
    s.children[0].emit('exit', null, 'SIGTERM')
    const events = s.journal.map(e => e.event)
    assert.deepEqual(events, ['requested', 'started', 'session', 'stop-requested', 'ended'])
    const req0 = s.journal[0]
    assert.equal(req0.repo, REPO); assert.equal(req0.issue, 229); assert.equal(req0.role, 'backend-engineer')
    assert.equal(req0.uuid, UUID)
    assert.deepEqual(req0.argv, cmd().args)
    assert.equal(s.journal[1].pid, 4001)
    const end = s.journal[4]
    assert.equal(end.signal, 'SIGTERM')
    assert.equal(end.durationMs, 5000)
    assert.equal(end.state, 'stopped')
    assert.equal(typeof end.ts, 'string')
    assert.equal(JSON.stringify(s.journal).includes('secret-token'), false)
  })

  it('does not start when the first entry cannot be written (fail closed)', () => {
    const s = setup({ journal: { append: () => false } })
    assert.deepEqual(s.sup.start(req(), cmd()), { ok: false, reason: 'journal' })
    assert.equal(s.spawned.length, 0)
    assert.equal(s.sup.list().length, 0)
  })

  it('a later entry that cannot be written does not break the lifecycle', () => {
    let n = 0
    const s = setup({ journal: { append: () => ++n === 1 } })
    const l = started(s)
    s.children[0].emit('spawn')
    s.children[0].emit('exit', 0, null)
    assert.equal(s.sup.get(l.id)?.state, 'exited')
  })

  it('recordRefusal writes only a fixed reason and the validated request, never raw input', () => {
    const s = setup()
    s.sup.recordRefusal('body')
    s.sup.recordRefusal('label', req())
    assert.deepEqual(s.journal.map(e => [e.event, e.reason, e.repo]), [['refused', 'body', undefined], ['refused', 'label', REPO]])
  })
})

describe('dispose', () => {
  it('kills every running group (SIGKILL: the relay is exiting), clears the timers, refuses new launches', () => {
    const s = setup({ maxConcurrent: 2 })
    const a = started(s)
    s.children[0].emit('spawn')
    s.sup.start(req(230), cmd(req(230), '22222222-2222-4222-8222-222222222222'))
    s.children[1].emit('spawn')
    s.sup.dispose()
    assert.deepEqual(s.kills.sort(), [[4001, 'SIGKILL'], [4002, 'SIGKILL']])
    assert.equal(s.clock.pending(), 0)
    assert.deepEqual(s.sup.start(req(231), cmd(req(231), '33333333-3333-4333-8333-333333333333')), { ok: false, reason: 'disposed' })
    assert.equal(s.journal.filter(e => e.event === 'killed-on-dispose').length, 2)
    void a
  })

  it('a launch whose spawn was never observed has no pid to kill: the child handle is used', () => {
    const s = setup()
    started(s)
    s.sup.dispose()
    assert.equal(s.kills.length, 0)
    assert.deepEqual(s.children[0].killed, ['SIGKILL'])
  })

  it('is idempotent', () => {
    const s = setup()
    started(s); s.children[0].emit('spawn')
    s.sup.dispose(); s.sup.dispose()
    assert.equal(s.kills.length, 1)
  })
})

describe('launchEnv', () => {
  it('passes only what claude and gh need, nothing of the relay', () => {
    const env = launchEnv({
      PATH: '/bin', HOME: '/h', LANG: 'C', LC_ALL: 'C', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', GH_TOKEN: 't', HTTPS_PROXY: 'p',
      AGENT_LENS_LAUNCH_TOKEN: 'x', AGENT_LENS_WEBHOOKS: 'https://hook', NODE_OPTIONS: '--require /evil.js', LD_PRELOAD: '/evil.so', AWS_SECRET_ACCESS_KEY: 's',
    })
    assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'GH_TOKEN', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'PATH'])
  })

  it('drops undefined values', () => {
    assert.deepEqual(launchEnv({ PATH: undefined, HOME: '/h' }), { HOME: '/h' })
  })
})
