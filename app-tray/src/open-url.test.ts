// #335, increment 3: open the UI and copy the local URL, without a shell and only for the relay's own URL.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { copyLocalUrl, isLocalRelayUrl, openLocalUrl, type SpawnLike } from './open-url'

const URL3001 = 'http://127.0.0.1:3001'

interface Call { file: string; args: readonly string[]; options: Record<string, unknown>; stdin: string }
type Outcome = 'ok' | 'enoent' | 'fail' | 'hang'

/** A spawn that records every call; `outcomes[file]` says how that command ends. */
function fakeSpawn(outcomes: Record<string, Outcome> = {}): { spawn: SpawnLike; calls: Call[] } {
  const calls: Call[] = []
  const spawn: SpawnLike = (file, args, options) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; unref(): void; kill(): boolean }
    const call: Call = { file, args, options: options as Record<string, unknown>, stdin: '' }
    calls.push(call)
    child.stdin = new PassThrough()
    child.stdin.on('data', d => { call.stdin += String(d) })
    child.unref = () => {}
    child.kill = () => true
    const outcome = outcomes[file] ?? 'ok'
    setImmediate(() => {
      if (outcome === 'enoent') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      else if (outcome === 'ok') child.emit('exit', 0, null)
      else if (outcome === 'fail') child.emit('exit', 1, null)
    })
    return child as never
  }
  return { spawn, calls }
}

describe('isLocalRelayUrl: only the relay on loopback', () => {
  it('accepts 127.0.0.1 and localhost on the relay port', () => {
    assert.equal(isLocalRelayUrl(URL3001, 3001), true)
    assert.equal(isLocalRelayUrl(`${URL3001}/`, 3001), true)
    assert.equal(isLocalRelayUrl('http://localhost:3001', 3001), true)
  })
  it('refuses every other host, port, scheme, path, credential or shape', () => {
    const bad = [
      'http://127.0.0.1:3002', 'http://127.0.0.1', 'https://127.0.0.1:3001', 'http://0.0.0.0:3001',
      'http://192.168.1.2:3001', 'http://example.com:3001', 'http://127.0.0.1.evil.example:3001',
      'http://127.0.0.1:3001@evil.example', 'http://user:pw@127.0.0.1:3001', 'http://[::1]:3001',
      'http://127.0.0.1:3001/path', 'http://127.0.0.1:3001/?q=1', 'http://127.0.0.1:3001/#x',
      'file:///etc/passwd', 'javascript:alert(1)', '-a', '', ' http://127.0.0.1:3001', 'http://127.0.0.1:3001\n',
      'http://127.0.0.1:3001; rm -rf /', 'http://127.0.0.1:3001 && calc', 'http://127.0.0.1:3001&calc',
      'http://127.1:3001', 'http://2130706433:3001', 'http://127.0.0.1:03001',
    ]
    for (const u of bad) assert.equal(isLocalRelayUrl(u, 3001), false, JSON.stringify(u))
  })
  it('refuses an invalid port', () => {
    for (const p of [0, -1, 65536, 1.5, NaN]) assert.equal(isLocalRelayUrl(`http://127.0.0.1:${p}`, p), false, String(p))
  })
})

describe('openLocalUrl: argument array, never a shell', () => {
  it('uses the opener of each platform', async () => {
    const expected: Array<[NodeJS.Platform, string, string[]]> = [
      ['linux', 'xdg-open', [URL3001]],
      ['darwin', 'open', [URL3001]],
      ['win32', 'rundll32', ['url.dll,FileProtocolHandler', URL3001]],
    ]
    for (const [platform, file, args] of expected) {
      const { spawn, calls } = fakeSpawn()
      assert.equal(await openLocalUrl(URL3001, 3001, { platform, spawn }), true, platform)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].file, file)
      assert.deepEqual(calls[0].args, args)
      assert.notEqual(calls[0].options.shell, true, 'no shell')
    }
  })
  it('does not spawn anything for an unvalidated URL', async () => {
    const { spawn, calls } = fakeSpawn()
    for (const u of ['http://evil.example', 'http://127.0.0.1:3001; rm -rf /', 'file:///etc/passwd', '--version']) {
      assert.equal(await openLocalUrl(u, 3001, { platform: 'linux', spawn }), false)
    }
    assert.equal(calls.length, 0)
  })
  it('says false when the opener is missing or fails, never throws', async () => {
    assert.equal(await openLocalUrl(URL3001, 3001, { platform: 'linux', spawn: fakeSpawn({ 'xdg-open': 'enoent' }).spawn }), false)
    assert.equal(await openLocalUrl(URL3001, 3001, { platform: 'linux', spawn: fakeSpawn({ 'xdg-open': 'fail' }).spawn }), false)
  })
  it('counts an opener still running after the delay as started', async () => {
    const { spawn } = fakeSpawn({ 'xdg-open': 'hang' })
    assert.equal(await openLocalUrl(URL3001, 3001, { platform: 'linux', spawn, settleMs: 10 }), true)
  })
  it('says false when spawn throws', async () => {
    const spawn: SpawnLike = () => { throw new Error('boom') }
    assert.equal(await openLocalUrl(URL3001, 3001, { platform: 'linux', spawn }), false)
  })
})

describe('copyLocalUrl: best effort on Linux', () => {
  it('writes the URL on stdin of pbcopy (macOS) and clip (Windows)', async () => {
    for (const [platform, file] of [['darwin', 'pbcopy'], ['win32', 'clip']] as const) {
      const { spawn, calls } = fakeSpawn()
      assert.equal(await copyLocalUrl(URL3001, 3001, { platform, spawn }), true)
      assert.equal(calls[0].file, file)
      assert.deepEqual(calls[0].args, [])
      assert.equal(calls[0].stdin, URL3001)
    }
  })
  it('tries wl-copy, xclip then xsel on Linux and stops at the first that works', async () => {
    const { spawn, calls } = fakeSpawn({ 'wl-copy': 'enoent', xclip: 'ok' })
    assert.equal(await copyLocalUrl(URL3001, 3001, { platform: 'linux', spawn }), true)
    assert.deepEqual(calls.map(c => c.file), ['wl-copy', 'xclip'])
    assert.deepEqual(calls[1].args, ['-selection', 'clipboard'])
    assert.equal(calls[1].stdin, URL3001)
  })
  it('says false, without throwing, when no clipboard tool exists', async () => {
    const { spawn, calls } = fakeSpawn({ 'wl-copy': 'enoent', xclip: 'enoent', xsel: 'enoent' })
    assert.equal(await copyLocalUrl(URL3001, 3001, { platform: 'linux', spawn }), false)
    assert.equal(calls.length, 3)
  })
  it('copies nothing for an unvalidated URL', async () => {
    const { spawn, calls } = fakeSpawn()
    assert.equal(await copyLocalUrl('http://evil.example', 3001, { platform: 'linux', spawn }), false)
    assert.equal(calls.length, 0)
  })
})
