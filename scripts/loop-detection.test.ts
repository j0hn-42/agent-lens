import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  REPEAT_THRESHOLD, CYCLE_THRESHOLD, detectLoops, assessHealth, healthText, findingText, sessionHealthText,
} from '../web/lib/loop-detection'
import type { ConversationMessage } from '../web/hooks/simulation/types'

// Loop detection and health verdict (#230): only what the observed events prove.

let seq = 0
const call = (toolName: string, inputData: Record<string, unknown> | undefined, toolUseId?: string): ConversationMessage =>
  ({ id: `m${seq++}`, type: 'tool_call', content: `> ${toolName}`, timestamp: seq, toolName, inputData, ...(toolUseId ? { toolUseId } : {}) })
const result = (toolName: string, isError = false, toolUseId?: string): ConversationMessage =>
  ({ id: `m${seq++}`, type: 'tool_result', content: '< x', timestamp: seq, toolName, ...(toolUseId ? { toolUseId } : {}), ...(isError ? { isError: true } : {}) })
const ok = (toolName: string, input: Record<string, unknown>, id?: string) => [call(toolName, input, id), result(toolName, false, id)]
const fail = (toolName: string, input: Record<string, unknown>, id?: string) => [call(toolName, input, id), result(toolName, true, id)]

test('thresholds are fixed: 3 identical calls in a row, 3 read-edit-fail cycles', () => {
  assert.equal(REPEAT_THRESHOLD, 3)
  assert.equal(CYCLE_THRESHOLD, 3)
})

test('three identical calls in a row are a loop; the key order of the input does not matter', () => {
  const msgs = [
    ...ok('Grep', { pattern: 'foo', path: 'src' }, 't1'),
    ...ok('Grep', { path: 'src', pattern: 'foo' }, 't2'),
    ...ok('Grep', { pattern: 'foo', path: 'src' }, 't3'),
  ]
  const v = detectLoops(msgs)
  assert.equal(v.status, 'loop')
  assert.equal(v.findings.length, 1)
  assert.deepEqual(v.findings[0], { kind: 'repeat', toolName: 'Grep', count: 3, atLeast: false, toolUseIds: ['t1', 't2', 't3'] })
  assert.equal(findingText(v.findings[0]), 'Grep called 3× in a row with the same input')
})

test('two identical calls, or three with a different call between them, are not a loop', () => {
  assert.equal(detectLoops([...ok('Read', { file_path: 'a' }), ...ok('Read', { file_path: 'a' })]).status, 'clear')
  const broken = [...ok('Read', { file_path: 'a' }), ...ok('Read', { file_path: 'a' }), ...ok('Bash', { command: 'ls' }), ...ok('Read', { file_path: 'a' })]
  assert.equal(detectLoops(broken).findings.length, 0)
  const different = [...ok('Read', { file_path: 'a' }), ...ok('Read', { file_path: 'a', offset: 10 }), ...ok('Read', { file_path: 'a' })]
  assert.equal(detectLoops(different).findings.length, 0)
})

test('a call without input data is never counted as identical: it breaks the run and makes the verdict incomplete', () => {
  const msgs = [...ok('Bash', { command: 'make' }), ...ok('Bash', { command: 'make' }), call('Bash', undefined), result('Bash'), ...ok('Bash', { command: 'make' })]
  const v = detectLoops(msgs)
  assert.equal(v.findings.length, 0)
  assert.equal(v.status, 'incomplete')
  assert.equal(v.calls, 4)
  assert.equal(v.comparable, 3)
  assert.equal(healthText(v), 'No loop in the observed part (3 of 4 tool calls comparable)')
})

test('read → edit → failure three times on the same file is a cycle; the failure can be the edit or the next call', () => {
  const msgs = [
    ...ok('Read', { file_path: '/r/src/a.ts' }, 'r1'), ...fail('Edit', { file_path: '/r/src/a.ts', old_string: 'x', new_string: 'y' }, 'e1'),
    ...ok('Read', { file_path: '/r/src/a.ts' }, 'r2'), ...ok('Edit', { file_path: '/r/src/a.ts', old_string: 'y', new_string: 'z' }, 'e2'), ...fail('Bash', { command: 'pnpm test' }, 'b2'),
    ...ok('Read', { file_path: '/r/src/a.ts' }, 'r3'), ...ok('Write', { file_path: '/r/src/a.ts', content: 'w' }, 'e3'), ...fail('Bash', { command: 'pnpm test' }, 'b3'),
  ]
  const v = detectLoops(msgs)
  assert.equal(v.status, 'loop')
  const cycle = v.findings.find(f => f.kind === 'edit-cycle')
  assert.ok(cycle && cycle.kind === 'edit-cycle')
  assert.equal(cycle.path, '/r/src/a.ts')
  assert.equal(cycle.count, 3)
  assert.equal(cycle.atLeast, false)
  assert.deepEqual(cycle.toolUseIds, ['r1', 'e1', 'r2', 'e2', 'b2', 'r3', 'e3', 'b3'])
  assert.equal(findingText(cycle), 'read → edit → failure 3× on a.ts')
})

test('a success after the edit breaks the cycle count; two failing cycles are not enough', () => {
  const cycle = (fails: boolean) => [
    ...ok('Read', { file_path: 'a.ts' }), ...ok('Edit', { file_path: 'a.ts', old_string: '1', new_string: '2' }),
    ...(fails ? fail : ok)('Bash', { command: 'pnpm test' }),
  ]
  assert.equal(detectLoops([...cycle(true), ...cycle(true)]).findings.length, 0)
  assert.equal(detectLoops([...cycle(true), ...cycle(true), ...cycle(false), ...cycle(true)]).findings.length, 0)
  assert.equal(detectLoops([...cycle(true), ...cycle(true), ...cycle(true)]).findings.length, 1)
})

test('an edit whose outcome was never seen proves no failure', () => {
  const msgs: ConversationMessage[] = []
  for (let i = 0; i < 3; i++) msgs.push(...ok('Read', { file_path: 'a.ts' }), call('Edit', { file_path: 'a.ts', old_string: `${i}`, new_string: 'n' }))
  assert.equal(detectLoops(msgs).findings.filter(f => f.kind === 'edit-cycle').length, 0)
})

test('results are paired by tool_use_id, not by position', () => {
  // Two parallel Edit calls: the failure belongs to e2 (other file), not to e1
  const msgs: ConversationMessage[] = []
  for (let i = 0; i < 3; i++) {
    msgs.push(
      ...ok('Read', { file_path: 'a.ts' }, `r${i}`),
      call('Edit', { file_path: 'a.ts', old_string: `${i}`, new_string: 'n' }, `e1-${i}`),
      call('Edit', { file_path: 'b.ts', old_string: `${i}`, new_string: 'n' }, `e2-${i}`),
      result('Edit', true, `e2-${i}`), result('Edit', false, `e1-${i}`),
      ...ok('Bash', { command: `echo ${i}` }),
    )
  }
  assert.equal(detectLoops(msgs).findings.filter(f => f.kind === 'edit-cycle').length, 0)
})

test('when earlier history was dropped, a run that starts the kept buffer is "at least" and the verdict says the history is partial', () => {
  const msgs = [...ok('Read', { file_path: 'a' }), ...ok('Read', { file_path: 'a' }), ...ok('Read', { file_path: 'a' })]
  const v = detectLoops(msgs, 12)
  assert.equal(v.findings[0].atLeast, true)
  assert.equal(findingText(v.findings[0]), 'Read called at least 3× in a row with the same input')
  const later = detectLoops([...ok('Bash', { command: 'ls' }), ...msgs], 12)
  assert.equal(later.findings[0].atLeast, false, 'a run after another call is fully observed')
  const clean = detectLoops([...ok('Bash', { command: 'ls' })], 12)
  assert.equal(clean.status, 'incomplete')
  assert.equal(healthText(clean), 'No loop in the observed part (1 tool call; earlier history dropped)')
})

test('no tool call observed: nothing to judge, never "healthy"', () => {
  const v = detectLoops([{ id: 'x', type: 'assistant', content: 'hi', timestamp: 1 }])
  assert.equal(v.status, 'unknown')
  assert.equal(healthText(v), 'Not enough activity to judge')
  const noInput = detectLoops([call('Bash', undefined), result('Bash')])
  assert.equal(noInput.status, 'unknown')
})

test('a fully observed history without loop is "clear" and says how many calls it covers', () => {
  const v = detectLoops([...ok('Read', { file_path: 'a' }), ...ok('Edit', { file_path: 'a', old_string: '1', new_string: '2' })])
  assert.equal(v.status, 'clear')
  assert.equal(healthText(v), 'No loop observed (2 tool calls)')
  assert.equal(healthText(detectLoops([...ok('Read', { file_path: 'a' })])), 'No loop observed (1 tool call)')
})

test('assessHealth gives a verdict per agent and per session; a loop of any agent marks its session', () => {
  const loop = [...ok('Read', { file_path: 'a' }), ...ok('Read', { file_path: 'a' }), ...ok('Read', { file_path: 'a' })]
  const conversations = new Map<string, ConversationMessage[]>([
    ['s1:main', [...ok('Bash', { command: 'ls' })]],
    ['s1:sub', loop],
    ['s2:main', [...ok('Bash', { command: 'ls' })]],
    ['s3:main', []],
  ])
  const sessionOf = new Map([['s1:main', 's1'], ['s1:sub', 's1'], ['s2:main', 's2'], ['s3:main', 's3']])
  const h = assessHealth(conversations, new Map([['s2:main', 4]]), k => sessionOf.get(k))
  assert.equal(h.byAgent.get('s1:main')!.status, 'clear')
  assert.equal(h.byAgent.get('s1:sub')!.status, 'loop')
  assert.equal(h.byAgent.get('s1:sub')!.findings[0].agentKey, 's1:sub')
  assert.equal(h.bySession.get('s1')!.status, 'loop')
  assert.equal(h.bySession.get('s1')!.calls, 4)
  assert.equal(h.bySession.get('s2')!.status, 'incomplete')
  assert.equal(h.bySession.get('s3')!.status, 'unknown')
  assert.equal(sessionHealthText(h.bySession.get('s1')), 'loop observed')
  assert.equal(sessionHealthText(h.bySession.get('s2')), null, 'the session row only speaks up for a proven loop')
  assert.equal(sessionHealthText(undefined), null)
})

test('an agent whose session is unknown is judged alone and never lands in a session verdict', () => {
  const h = assessHealth(new Map([['ghost', [...ok('Bash', { command: 'ls' })]]]), new Map(), () => undefined)
  assert.equal(h.byAgent.get('ghost')!.status, 'clear')
  assert.equal(h.bySession.size, 0)
})
