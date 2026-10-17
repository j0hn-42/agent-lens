// #335, increment 2: JSON line protocol between the driver and the native menu binary.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INCOMING_LINE_BYTES, PROTOCOL_VERSION, createLineSplitter, encodeMessage, parseBinaryMessage, type DriverMessage,
} from './protocol'

describe('encodeMessage', () => {
  it('writes one JSON line with the version', () => {
    const msg: DriverMessage = { type: 'menu', tooltip: 'Agent Lens', items: [{ id: 'open', label: 'Ouvrir', enabled: true }] }
    const line = encodeMessage(msg)
    assert.ok(line.endsWith('\n'))
    assert.equal(line.slice(0, -1).includes('\n'), false)
    assert.deepEqual(JSON.parse(line), { v: PROTOCOL_VERSION, ...msg })
  })
  it('keeps a label with a newline on one line', () => {
    const line = encodeMessage({ type: 'menu', tooltip: 'a\nb', items: [] })
    assert.equal(line.split('\n').length, 2)
  })
})

describe('parseBinaryMessage: strict validation', () => {
  const v = PROTOCOL_VERSION
  it('accepts ready, closed and a click on a known item', () => {
    assert.deepEqual(parseBinaryMessage(JSON.stringify({ v, type: 'ready' })), { ok: true, message: { type: 'ready' } })
    assert.deepEqual(parseBinaryMessage(JSON.stringify({ v, type: 'closed' })), { ok: true, message: { type: 'closed' } })
    assert.deepEqual(parseBinaryMessage(JSON.stringify({ v, type: 'click', id: 'copyUrl' })), { ok: true, message: { type: 'click', id: 'copyUrl' } })
  })
  it('rejects anything else', () => {
    const bad = [
      '', 'nope', '[]', 'null', '1', '"click"',
      JSON.stringify({ type: 'ready' }), // no version
      JSON.stringify({ v: 2, type: 'ready' }), // wrong version
      JSON.stringify({ v, type: 'exec', cmd: 'rm -rf /' }), // unknown type
      JSON.stringify({ v, type: 'click' }), // no id
      JSON.stringify({ v, type: 'click', id: 'rm' }), // unknown id
      JSON.stringify({ v, type: 'click', id: 42 }),
      JSON.stringify({ v, type: 'click', id: 'open', url: 'http://evil.example' }), // extra key
      JSON.stringify({ v, type: 'ready', id: 'open' }), // extra key
      JSON.stringify({ v, type: 'click', id: '__proto__' }),
      '{"v":1,"type":"click","id":"open"} trailing',
    ]
    for (const line of bad) assert.equal(parseBinaryMessage(line).ok, false, line)
  })
  it('rejects a line over the cap', () => {
    const line = JSON.stringify({ v, type: 'click', id: 'open', pad: 'x'.repeat(MAX_INCOMING_LINE_BYTES) })
    assert.equal(parseBinaryMessage(line).ok, false)
  })
})

describe('createLineSplitter: bounded lines', () => {
  const run = (chunks: string[], max = 16) => {
    const out: Array<{ line: string } | { overflow: true }> = []
    const s = createLineSplitter(max, e => out.push(e))
    for (const c of chunks) s.push(Buffer.from(c))
    return out
  }
  it('splits on newlines across chunks and handles CRLF', () => {
    assert.deepEqual(run(['ab\ncd', 'ef\r\ng\n']), [{ line: 'ab' }, { line: 'cdef' }, { line: 'g' }])
  })
  it('reports an overflow once and resumes after the next newline', () => {
    assert.deepEqual(run(['x'.repeat(40), 'yyyy\nok\n']), [{ overflow: true }, { line: 'ok' }])
  })
  it('does not buffer without bound when no newline comes', () => {
    const out: unknown[] = []
    const s = createLineSplitter(8, e => out.push(e))
    for (let i = 0; i < 1000; i++) s.push(Buffer.from('abcdefgh'))
    assert.deepEqual(out, [{ overflow: true }])
    assert.ok(s.bufferedBytes() <= 8)
  })
  it('an exact-cap line passes', () => {
    assert.deepEqual(run(['12345678\n'], 8), [{ line: '12345678' }])
  })
})
