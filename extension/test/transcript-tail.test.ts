import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  extractLastAssistantText, extractLastAssistantTextAsync, parseLastAssistantText,
  isAllowedTranscriptPath, buildSubagentReportAsync,
} from '../src/transcript-parser'
import { SUBAGENT_TRANSCRIPT_TAIL_BYTES } from '../src/constants'

const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

describe('subagent transcript tail', () => {
  let dir: string
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tail-')) })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('parses the last assistant text from a partial tail', () => {
    assert.equal(parseLastAssistantText(`garbage{\n${assistant('one')}\n${assistant('two')}\n`), 'two')
    assert.equal(parseLastAssistantText('not json\n'), undefined)
  })

  it('reads only the tail: a huge file with the answer at the end is fast and correct', async () => {
    const file = path.join(dir, 'huge.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(2000) } }) + '\n'
    fs.writeFileSync(file, filler.repeat(5000) + assistant('the end') + '\n')
    assert.ok(fs.statSync(file).size > SUBAGENT_TRANSCRIPT_TAIL_BYTES * 20)
    assert.equal(extractLastAssistantText(file), 'the end')
    assert.equal(await extractLastAssistantTextAsync(file), 'the end')
  })

  it('does not see text that is only before the tail window', async () => {
    const file = path.join(dir, 'early.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(2000) } }) + '\n'
    fs.writeFileSync(file, assistant('too early') + '\n' + filler.repeat(200))
    assert.equal(await extractLastAssistantTextAsync(file), undefined)
  })

  it('returns undefined for missing files and directories', async () => {
    assert.equal(await extractLastAssistantTextAsync(path.join(dir, 'missing.jsonl')), undefined)
    assert.equal(await extractLastAssistantTextAsync(dir), undefined)
  })

  it('isAllowedTranscriptPath keeps rejecting escapes', () => {
    const root = path.join(dir, 'root')
    fs.mkdirSync(root)
    const inside = path.join(root, 'a.jsonl')
    const outside = path.join(dir, 'outside.jsonl')
    fs.writeFileSync(inside, '{}\n')
    fs.writeFileSync(outside, '{}\n')
    fs.symlinkSync(outside, path.join(root, 'link.jsonl'))
    assert.equal(isAllowedTranscriptPath(inside, [root]), true)
    assert.equal(isAllowedTranscriptPath(outside, [root]), false)
    assert.equal(isAllowedTranscriptPath(path.join(root, 'link.jsonl'), [root]), false)
    assert.equal(isAllowedTranscriptPath(path.join(root, '..', 'outside.jsonl'), [root]), false)
    assert.equal(isAllowedTranscriptPath(`${inside}\0.jsonl`, [root]), false)
    assert.equal(isAllowedTranscriptPath(42, [root]), false)
  })

  it('buildSubagentReportAsync falls back to last_assistant_message without reading disallowed paths', async () => {
    let reads = 0
    const report = await buildSubagentReportAsync(
      { agent_transcript_path: '/etc/passwd', last_assistant_message: '  hello  ' },
      async () => { reads++; return 'leak' },
    )
    assert.equal(report, 'hello')
    assert.equal(reads, 0)
  })
})
