import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutAgentLabel } from '@/components/agent-visualizer/canvas/team-style'

const measure = (t: string) => t.length * 6
const base = { state: 'working', activity: undefined, sessionLabel: undefined } as const

test('a subagent label shows its type above its description', () => {
  const l = layoutAgentLabel({ ...base, kind: 'subagent', name: 'Audit the canvas', subagentType: 'Explore' } as never, 40, measure)
  assert.equal(l.nameLines[0], 'Explore')
  assert.equal(l.nameLines.length, 2)
  assert.equal(l.extraLines, 1)
})

test('no type line when the type is absent or equals the name', () => {
  const none = layoutAgentLabel({ ...base, kind: 'subagent', name: 'Audit' } as never, 40, measure)
  const same = layoutAgentLabel({ ...base, kind: 'subagent', name: 'Explore', subagentType: 'Explore' } as never, 40, measure)
  assert.equal(none.nameLines.length, 1)
  assert.equal(same.nameLines.length, 1)
})

test('main agents never get a type line', () => {
  const l = layoutAgentLabel({ ...base, kind: 'main', name: 'main', subagentType: 'Explore' } as never, 40, measure)
  assert.equal(l.nameLines.length, 1)
})
