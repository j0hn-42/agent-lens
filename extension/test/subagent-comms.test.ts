import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptParser, extractLastAssistantText, isAllowedTranscriptPath } from '../src/transcript-parser'
import { extractInputData } from '../src/tool-summarizer'
import type { AgentEvent, PendingToolCall } from '../src/protocol'

function makeParser() {
  const events: AgentEvent[] = []
  const session = { spawnedSubagents: new Set<string>(), contextBreakdown: { subagentResults: 0, toolResults: 0 } }
  const parser = new TranscriptParser({
    emit: (e: AgentEvent) => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session as never,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  })
  return { parser, events }
}

describe('Task/Agent subagent communications', () => {
  it('extractInputData keeps prompt up to 2000 chars', () => {
    const data = extractInputData('Agent', { description: 'd', prompt: 'x'.repeat(5000), subagent_type: 'Explore', model: 'haiku' })
    assert.equal((data?.prompt as string).length, 2000)
    assert.equal(data?.subagent_type, 'Explore')
    assert.equal(data?.model, 'haiku')
    assert.equal(extractInputData('Task', { prompt: 'p' })?.prompt, 'p')
  })

  it('dispatch carries prompt; return carries full report and toolUseId', () => {
    const { parser, events } = makeParser()
    const pending = new Map<string, PendingToolCall>()
    parser.handleToolUse(
      { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Explore', prompt: 'p'.repeat(1500), subagent_type: 'Explore' } } as never,
      'orchestrator', pending, 's1',
    )
    const dispatch = events.find(e => e.type === 'subagent_dispatch')!
    assert.equal((dispatch.payload.prompt as string).length, 1500)
    assert.equal(dispatch.payload.subagentType, 'Explore')
    assert.equal(dispatch.payload.toolUseId, 'toolu_1')
    const start = events.find(e => e.type === 'tool_call_start')!
    assert.equal(((start.payload.inputData as Record<string, unknown>).prompt as string).length, 1500)

    parser.handleToolResult({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'r'.repeat(3000) } as never, 'orchestrator', pending, 's1')
    const ret = events.find(e => e.type === 'subagent_return')!
    assert.equal((ret.payload.summary as string).length, 2000)
    assert.equal(ret.payload.toolUseId, 'toolu_1')
    assert.equal(typeof ret.payload.durationS, 'number')
    assert.equal(typeof ret.payload.isError, 'boolean')
  })

  it('extractLastAssistantText reads the last assistant text block with safe fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-sub-'))
    const file = path.join(dir, 'agent.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'final report' }, { type: 'tool_use', id: 'x', name: 'Read', input: {} }] } }),
      JSON.stringify({ message: { role: 'user', content: 'ignored' } }),
      'not json',
    ].join('\n'))
    assert.equal(extractLastAssistantText(file), 'final report')
    assert.equal(extractLastAssistantText(path.join(dir, 'missing.jsonl')), undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('isAllowedTranscriptPath only accepts real .jsonl files inside the allowed root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-out-'))
    const inside = path.join(root, 'proj', 'sub.jsonl')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, '{}\n')
    const secret = path.join(outside, 'secret.jsonl')
    fs.writeFileSync(secret, '{"message":{"role":"assistant","content":"leak"}}\n')
    fs.writeFileSync(path.join(outside, 'passwd'), 'x')
    fs.symlinkSync(secret, path.join(root, 'proj', 'link.jsonl'))
    const roots = [root]
    assert.equal(isAllowedTranscriptPath(inside, roots), true)
    assert.equal(isAllowedTranscriptPath(secret, roots), false)
    assert.equal(isAllowedTranscriptPath(path.join(root, 'proj', '..', '..', path.basename(outside), 'secret.jsonl'), roots), false)
    assert.equal(isAllowedTranscriptPath(path.join(root, 'proj', 'link.jsonl'), roots), false)
    assert.equal(isAllowedTranscriptPath(path.join(outside, 'passwd'), roots), false)
    assert.equal(isAllowedTranscriptPath('/etc/passwd', roots), false)
    assert.equal(isAllowedTranscriptPath('relative.jsonl', roots), false)
    assert.equal(isAllowedTranscriptPath(undefined, roots), false)
    assert.equal(isAllowedTranscriptPath(root, roots), false)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
})
