import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SessionModelTracker } from '../web/lib/session-model'

const spawn = (sessionId: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'agent_spawn', sessionId, payload: { name, ...extra } })
const detected = (sessionId: string, agent: string, model: string) =>
  ({ type: 'model_detected', sessionId, payload: { agent, model } })

test('the main agent model wins over sub-agent models, whatever the arrival order', () => {
  const t = new SessionModelTracker()
  assert.equal(t.ingest(detected('s1', 'sub', 'claude-haiku-4-5')), true)
  assert.equal(t.modelOf('s1'), 'claude-haiku-4-5', 'fallback: latest model reported')
  assert.equal(t.ingest(spawn('s1', 'main', { isMain: true })), false, 'no model yet for main: nothing changes')
  assert.equal(t.ingest(detected('s1', 'main', 'claude-opus-4-6')), true)
  assert.equal(t.modelOf('s1'), 'claude-opus-4-6')
  assert.equal(t.ingest(detected('s1', 'sub', 'claude-sonnet-4-6')), false, 'a sub-agent does not override main')
  assert.equal(t.ingest(detected('s1', 'main', 'claude-opus-4-6')), false, 'same model: no change')
})

test('the model can come from agent_spawn, is kept per session, and ignores unrelated or malformed events', () => {
  const t = new SessionModelTracker()
  t.ingest(spawn('a', 'main', { isMain: true, model: 'gpt-5' }))
  t.ingest(detected('b', 'main', 'claude-opus-4-6'))
  assert.deepEqual([...t.snapshot()], [['a', 'gpt-5'], ['b', 'claude-opus-4-6']])
  assert.equal(t.ingest({ type: 'message', sessionId: 'a', payload: { model: 'x' } }), false)
  assert.equal(t.ingest({ type: 'model_detected', payload: { agent: 'm', model: 'x' } }), false, 'no session id')
  assert.equal(t.ingest({ type: 'model_detected', sessionId: 'a', payload: { agent: 'm', model: 42 } }), false)
  t.clear()
  assert.equal(t.modelOf('a'), undefined)
})
