import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from './args'
import { DEFAULT_RELAY_PORT } from '../../extension/src/constants'

describe('parseArgs --port', () => {
  it('keeps the default port without the flag', () => {
    assert.equal(parseArgs([]).port, DEFAULT_RELAY_PORT)
  })
  it('accepts 0 (ephemeral port chosen by the OS)', () => {
    assert.equal(parseArgs(['--port', '0']).port, 0)
    assert.equal(parseArgs(['-p', '0']).port, 0)
  })
  it('still rejects out-of-range and non-numeric ports', () => {
    for (const v of ['-1', '65536', 'abc']) assert.equal(parseArgs(['--port', v]).port, DEFAULT_RELAY_PORT, v)
  })
})
