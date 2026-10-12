import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contextWindowSize, windowCoveringUsage } from '../web/lib/context-window'

describe('contextWindowSize (#249)', () => {
  it('reads the family table, newest ids included', () => {
    assert.equal(contextWindowSize('claude-opus-4-6', false), 1_000_000)
    assert.equal(contextWindowSize('claude-haiku-4-5-20251001', false), 200_000)
    assert.equal(contextWindowSize('gpt-5-codex', false), 400_000)
  })
  it('CLAUDE_CODE_DISABLE_1M_CONTEXT caps every window to 200k, known or not', () => {
    assert.equal(contextWindowSize('claude-opus-4-6', true), 200_000)
    assert.equal(contextWindowSize(undefined, true), 200_000)
    assert.equal(contextWindowSize('claude-sonnet-4-5[1m]', true), 200_000)
  })
  it('an explicit [1m] suffix means a 1M window, even for a family below that', () => {
    assert.equal(contextWindowSize('claude-haiku-4-5[1m]', false), 1_000_000)
    assert.equal(contextWindowSize('CLAUDE-SONNET-4-5[1M]', false), 1_000_000)
  })
  it('an unknown model keeps the 200k default; no model at all keeps the 1M fallback', () => {
    assert.equal(contextWindowSize('some-new-model', false), 200_000)
    assert.equal(contextWindowSize(undefined, false), 1_000_000)
  })
  it('the cap also applies to a window above 200k that is not 1M', () => {
    assert.equal(contextWindowSize('gpt-5-codex', true), 200_000)
  })
})

describe('windowCoveringUsage (#249)', () => {
  it('keeps the window while the usage fits in it', () => {
    assert.equal(windowCoveringUsage(200_000, 150_000), 200_000)
    assert.equal(windowCoveringUsage(200_000, 200_000), 200_000)
  })
  it('a window cannot be smaller than what was used: it grows to the next known size', () => {
    assert.equal(windowCoveringUsage(200_000, 340_000), 1_000_000)
  })
  it('beyond every known size, the usage itself is the only proven bound', () => {
    assert.equal(windowCoveringUsage(200_000, 1_250_000), 1_250_000)
  })
  it('ignores a missing or invalid usage', () => {
    assert.equal(windowCoveringUsage(200_000, 0), 200_000)
    assert.equal(windowCoveringUsage(200_000, Number.NaN), 200_000)
  })
})
