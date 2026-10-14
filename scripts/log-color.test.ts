// #402: relay logs are colored by category, only on a TTY, and never alter the plain text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { colorEnabled, colorizeLog } from './log-color'

const E = '\x1b'
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('colorEnabled: TTY only, NO_COLOR wins, FORCE_COLOR overrides a non-TTY', () => {
  assert.equal(colorEnabled({}, true), true)
  assert.equal(colorEnabled({}, false), false)
  assert.equal(colorEnabled({ NO_COLOR: '1' }, true), false)
  assert.equal(colorEnabled({ NO_COLOR: '' }, true), true)
  assert.equal(colorEnabled({ FORCE_COLOR: '1' }, false), true)
  assert.equal(colorEnabled({ FORCE_COLOR: '0' }, true), false)
  assert.equal(colorEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, true), false)
})

test('colorizeLog: disabled returns the text untouched', () => {
  assert.equal(colorizeLog('[event] x', false), '[event] x')
})

test('colorizeLog: each known tag gets its own color and the text is preserved', () => {
  const tags = ['event', 'sse', 'session', 'scan', 'relay']
  const colors = new Set<string>()
  for (const t of tags) {
    const out = colorizeLog(`[${t}] hello`, true)
    assert.equal(strip(out), `[${t}] hello`)
    assert.ok(out.startsWith(`${E}[`), t)
    assert.ok(out.endsWith(`${E}[0m`), t)
    colors.add(out.slice(0, out.indexOf('m') + 1))
  }
  assert.equal(colors.size, tags.length)
})

test('colorizeLog: failures are highlighted whatever the tag', () => {
  for (const msg of ['[session] Failed to watch x', '[sse] Dropping slow or closed client', '[session] abc read failed, no longer watched:']) {
    const out = colorizeLog(msg, true)
    assert.equal(strip(out), msg)
    assert.ok(out.startsWith(`${E}[33m`), msg)
  }
})

test('colorizeLog: unknown or missing tag stays plain', () => {
  assert.equal(colorizeLog('no tag here', true), 'no tag here')
  assert.equal(colorizeLog('[other] x', true), '[other] x')
})
