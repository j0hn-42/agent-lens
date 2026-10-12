/**
 * Tests for tool-summarizer (#188): error detection must not invent failures from free text
 * when the structured is_error flag is present, and the summarizers keep their shapes/limits.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'
import { summarizeInput, summarizeResult, extractInputData } from '../src/tool-summarizer'
import { ARGS_MAX, RESULT_MAX, EDIT_CONTENT_MAX } from '../src/constants'

function makeSession(): WatchedSession {
  return {
    sessionId: 's1', filePath: '', fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    seenMessageHashes: new Set(), sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null, subagentWatchers: new Map(),
    spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'x', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function runTool(name: string, input: Record<string, unknown>, content: string, isError?: boolean): boolean | undefined {
  const session = makeSession()
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: (e) => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  const pending = new Map()
  parser.handleToolUse({ type: 'tool_use', id: 'x1', name, input }, 'orchestrator', pending, 's1')
  const block: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =
    { type: 'tool_result', tool_use_id: 'x1', content }
  if (isError !== undefined) { block.is_error = isError }
  parser.handleToolResult(block, 'orchestrator', pending, 's1')
  return events.find(e => e.type === 'tool_call_end')?.payload.isError as boolean | undefined
}

describe('tool error detection (#188)', () => {
  it('Read of a file containing "failed" is not an error when is_error is false', () => {
    assert.ok(!runTool('Read', { file_path: '/a/log.txt' }, 'the build failed last night; file not found handling', false))
  })

  it('Bash "0 failed" is not an error when is_error is false', () => {
    assert.ok(!runTool('Bash', { command: 'pnpm test' }, 'Tests: 12 passed, 0 failed', false))
  })

  it('Bash with is_error true is an error', () => {
    assert.equal(runTool('Bash', { command: 'false' }, 'boom', true), true)
  })

  it('falls back to the heuristic only when is_error is absent', () => {
    assert.equal(runTool('Bash', { command: 'foo' }, 'bash: foo: command not found'), true)
  })
})

describe('summarizers', () => {
  it('summarizeInput truncates Bash commands and shortens paths', () => {
    assert.equal(summarizeInput('Bash', { command: 'x'.repeat(ARGS_MAX + 50) }).length, ARGS_MAX)
    assert.equal(summarizeInput('Read', { file_path: '/a/b/c/d.ts' }), 'c/d.ts')
  })

  it('summarizeResult handles strings, text arrays and truncation', () => {
    assert.equal(summarizeResult('y'.repeat(RESULT_MAX + 10)).length, RESULT_MAX)
    assert.equal(summarizeResult([{ text: 'a' }, 'b']), 'a\nb')
    assert.equal(summarizeResult({ content: 'hi' }), 'hi')
  })

  it('extractInputData returns the expected shape and truncates Write content', () => {
    assert.deepEqual(extractInputData('Bash', { command: 'ls', description: 'list' }), { command: 'ls', description: 'list' })
    const w = extractInputData('Write', { file_path: '/f', content: 'z'.repeat(EDIT_CONTENT_MAX + 5) })
    assert.equal((w?.content as string).length, EDIT_CONTENT_MAX)
    assert.equal(extractInputData('Unknown', {}), undefined)
  })
})
