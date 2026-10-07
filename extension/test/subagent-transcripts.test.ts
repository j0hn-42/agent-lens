/**
 * Workflow agents write their transcripts to subagents/workflows/<wf_id>/agent-*.jsonl, next to a
 * journal.jsonl that is NOT a transcript. A scan limited to subagents/*.jsonl never shows them.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listSubagentTranscripts } from '../src/fs-utils'

describe('listSubagentTranscripts', () => {
  let dir: string
  const touch = (...parts: string[]) => {
    const p = path.join(dir, ...parts)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{}\n')
    return p
  }

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-subagents-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns [] for a missing directory', () => {
    assert.deepEqual(listSubagentTranscripts(path.join(dir, 'nope')), [])
  })

  it('lists direct transcripts and workflow agent transcripts, skipping journal and meta files', () => {
    const direct = touch('agent-a1.jsonl')
    touch('agent-a1.meta.json')
    const wfAgent = touch('workflows', 'wf_x-1', 'agent-b2.jsonl')
    touch('workflows', 'wf_x-1', 'journal.jsonl')
    touch('workflows', 'wf_x-1', 'agent-b2.meta.json')
    assert.deepEqual(listSubagentTranscripts(dir).sort(), [direct, wfAgent].sort())
  })

  it('does not descend into unrelated directories or beyond the workflow dirs', () => {
    touch('other', 'agent-c3.jsonl')
    touch('workflows', 'wf_x-1', 'deep', 'agent-d4.jsonl')
    const names = listSubagentTranscripts(dir).map(p => path.basename(p))
    assert.ok(!names.includes('agent-c3.jsonl'))
    assert.ok(!names.includes('agent-d4.jsonl'))
  })
})
