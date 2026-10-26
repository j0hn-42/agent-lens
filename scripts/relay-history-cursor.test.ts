/**
 * The relay-cursor that ends a history flush (#652) names the last event the client was sent or told it lost. A live
 * event triggers that flush (the history read before it goes out before it) and its own `agent-event` is queued
 * AFTER the cursor: the cursor must not already carry that event's number. Otherwise a page that gets the cursor
 * and loses the link before the event resumes with since=<its number>, and the event is neither replayed nor
 * counted lost.
 * No transport makes a live event follow a pending history within one run on demand (a hook arrives in a later
 * task, after the flush microtask; a Codex, Gemini or Pi attach next to a resumed session does it, with no test
 * seam), so the order is checked where it is decided: in deliverEvent, the pending history is flushed before the
 * live event takes its number, and the cursor is the last number given out.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** relay.ts without its comments: a comment naming flushHistory is not a call */
const source = fs.readFileSync(path.join(__dirname, 'relay.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

function body(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} is defined in relay.ts`)
  const open = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced ${name}`)
}

describe('relay: the cursor of a history flush never runs ahead of the live event that triggered it (#652)', () => {
  it('flushHistory puts the cursor at eventSeq, the last number given out', () => {
    assert.match(body('flushHistory'), /type: 'relay-cursor', instance: relayInstance, seq: eventSeq \}/)
  })

  it('deliverEvent flushes the pending history for a live event before giving that event its number', () => {
    const deliver = body('deliverEvent')
    const numbered = deliver.indexOf('++eventSeq')
    assert.ok(numbered >= 0, 'deliverEvent numbers the event')
    const flush = deliver.indexOf('if (live) flushHistory()')
    assert.ok(flush >= 0, 'deliverEvent flushes the pending history for a live event')
    assert.ok(flush < numbered, 'the flush comes before ++eventSeq')
    // A replayed event joins the pending history instead: the same `live` decides both
    assert.match(deliver, /const live = !\(event\.sessionId && event\.replayed === true\)/)
    assert.match(deliver, /if \(!live\) queueHistory\(/)
  })
})
