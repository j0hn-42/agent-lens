/**
 * #451: the structured `toolUseResult` of a Glob (`{ filenames, numFiles, truncated, durationMs, ... }`, read on
 * real Claude Code transcripts) proves a list of files and its total, where the text output carries no header.
 * The extension forwards it only when it is valid and not truncated; anything else is dropped.
 */
import './helpers/alias-vscode'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { globListingOf, SEARCH_LISTING_MAX_FILES, SEARCH_LISTING_PATH_MAX } from '../src/search-listing'
import { makeSession, makeHarness, ofType, assistantToolUse } from './helpers/teams-fixtures'

// Shape copied from real transcripts (field names and types only)
const REAL = { filenames: ['src/deploy-commands.ts', 'dist/deploy-commands.js'], durationMs: 12, numFiles: 2, truncated: false, totalMatches: 2, countIsComplete: true }

describe('globListingOf (#451)', () => {
  it('a real structured Glob result gives its files and total', () => {
    assert.deepEqual(globListingOf('Glob', REAL), { files: ['src/deploy-commands.ts', 'dist/deploy-commands.js'], count: 2 })
  })

  it('other tools, non-objects and missing fields give nothing', () => {
    assert.equal(globListingOf('Grep', REAL), null)
    for (const v of [undefined, null, 'x', 3, [], {}, { filenames: ['a'] }, { numFiles: 1 }]) assert.equal(globListingOf('Glob', v), null)
  })

  it('a truncated result gives nothing: the total is not known', () => {
    assert.equal(globListingOf('Glob', { ...REAL, truncated: true }), null)
    assert.equal(globListingOf('Glob', { filenames: ['a'], numFiles: 1 }), null, 'truncated absent: not proven complete')
    assert.equal(globListingOf('Glob', { ...REAL, truncated: 'false' }), null)
  })

  it('an inconsistent count, a non-string, a duplicate or an odd path gives nothing', () => {
    assert.equal(globListingOf('Glob', { ...REAL, numFiles: 3 }), null)
    assert.equal(globListingOf('Glob', { ...REAL, numFiles: 2.5 }), null)
    assert.equal(globListingOf('Glob', { filenames: ['a', 1], numFiles: 2, truncated: false }), null)
    assert.equal(globListingOf('Glob', { filenames: ['a', 'a'], numFiles: 2, truncated: false }), null)
    assert.equal(globListingOf('Glob', { filenames: ['a\nb'], numFiles: 1, truncated: false }), null)
    assert.equal(globListingOf('Glob', { filenames: [''], numFiles: 1, truncated: false }), null)
    assert.equal(globListingOf('Glob', { filenames: ['x'.repeat(SEARCH_LISTING_PATH_MAX + 1)], numFiles: 1, truncated: false }), null)
  })

  it('an empty result is not a listing', () => {
    assert.equal(globListingOf('Glob', { filenames: [], numFiles: 0, truncated: false }), null)
  })

  it('at most SEARCH_LISTING_MAX_FILES files are forwarded, with the whole count', () => {
    const files = Array.from({ length: SEARCH_LISTING_MAX_FILES + 30 }, (_, i) => `f${i}.ts`)
    const l = globListingOf('Glob', { filenames: files, numFiles: files.length, truncated: false })!
    assert.equal(l.files.length, SEARCH_LISTING_MAX_FILES)
    assert.equal(l.count, files.length)
  })
})

describe('tool_call_end of a Glob (#451)', () => {
  function end(toolUseResult: unknown, isError = false): AgentEvent {
    const session = makeSession()
    const h = makeHarness(session)
    const feed = (e: unknown) => h.parser.processTranscriptLine(JSON.stringify(e), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    feed(assistantToolUse('g1', 'Glob', { pattern: '**/deploy-commands.*' }))
    feed({ type: 'user', toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'src/deploy-commands.ts\ndist/deploy-commands.js', ...(isError ? { is_error: true } : {}) }] } })
    return ofType(h.events, 'tool_call_end')[0]
  }

  it('carries the validated listing next to the text result', () => {
    assert.deepEqual(end(REAL).payload.listing, { files: ['src/deploy-commands.ts', 'dist/deploy-commands.js'], count: 2 })
  })

  it('carries none without a valid structured result, or for a failed call', () => {
    assert.equal('listing' in end(undefined).payload, false)
    assert.equal('listing' in end({ ...REAL, truncated: true }).payload, false)
    assert.equal('listing' in end(REAL, true).payload, false)
  })
})
