import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  mergeModel, parseEffort, parseModelSource, recordModelUsed, modelRequestMatches, modelBadge, describeModel, MAX_MODELS_USED,
} from '../web/lib/model-provenance'

test('priority: runtime > configured > requested', () => {
  assert.deepEqual(mergeModel({}, { model: 'opus', source: 'requested' }), { model: 'opus', modelSource: 'requested' })
  assert.deepEqual(mergeModel({ model: 'opus', modelSource: 'requested' }, { model: 'm1', source: 'configured' }), { model: 'm1', modelSource: 'configured' })
  assert.deepEqual(mergeModel({ model: 'm1', modelSource: 'configured' }, { model: 'm2', source: 'runtime' }), { model: 'm2', modelSource: 'runtime' })
})

test('a weaker source never replaces a stronger one', () => {
  assert.equal(mergeModel({ model: 'm2', modelSource: 'runtime' }, { model: 'opus', source: 'requested' }), null)
  assert.equal(mergeModel({ model: 'm2', modelSource: 'runtime' }, { model: 'm1', source: 'configured' }), null)
  assert.equal(mergeModel({ model: 'm1', modelSource: 'configured' }, { model: 'opus', source: 'requested' }), null)
})

test('same-rank source updates (a /model switch is runtime again)', () => {
  assert.deepEqual(mergeModel({ model: 'a', modelSource: 'runtime' }, { model: 'b', source: 'runtime' }), { model: 'b', modelSource: 'runtime' })
  assert.equal(mergeModel({}, { model: '', source: 'runtime' }), null)
})

test('parseEffort keeps only known levels, lower-cased', () => {
  assert.equal(parseEffort('High'), 'high')
  assert.equal(parseEffort(' xhigh '), 'xhigh')
  assert.equal(parseEffort('turbo'), undefined)
  assert.equal(parseEffort(3), undefined)
  assert.equal(parseEffort(undefined), undefined)
})

test('parseModelSource rejects unknown values', () => {
  assert.equal(parseModelSource('runtime'), 'runtime')
  assert.equal(parseModelSource('guess'), undefined)
})

test('recordModelUsed dedupes, keeps order and is bounded', () => {
  assert.deepEqual(recordModelUsed(undefined, 'a'), ['a'])
  assert.deepEqual(recordModelUsed(['a'], 'a'), ['a'])
  assert.deepEqual(recordModelUsed(['a'], 'b'), ['a', 'b'])
  let list: string[] = []
  for (let i = 0; i < MAX_MODELS_USED + 5; i++) list = recordModelUsed(list, `m${i}`)
  assert.equal(list.length, MAX_MODELS_USED)
  assert.equal(list[list.length - 1], `m${MAX_MODELS_USED + 4}`)
})

test('modelRequestMatches handles aliases', () => {
  assert.equal(modelRequestMatches('opus', 'claude-opus-4-6-20250514'), true)
  assert.equal(modelRequestMatches('haiku', 'claude-opus-4-6-20250514'), false)
  assert.equal(modelRequestMatches('', 'x'), false)
})

test('modelBadge', () => {
  assert.equal(modelBadge({}), undefined)
  assert.equal(modelBadge({ model: 'x', modelSource: 'requested' })?.kind, 'requested')
  assert.equal(modelBadge({ model: 'x' })?.kind, 'requested')
  assert.equal(modelBadge({ model: 'x', modelSource: 'configured' })?.kind, 'configured')
  assert.equal(modelBadge({ model: 'claude-opus-4', modelSource: 'runtime', requestedModel: 'opus' })?.kind, 'actual')
  assert.equal(modelBadge({ model: 'claude-haiku-4', modelSource: 'runtime', requestedModel: 'opus' })?.kind, 'mismatch')
  assert.equal(modelBadge({ model: 'claude-haiku-4', modelSource: 'runtime' })?.kind, 'actual')
})

test('describeModel names the provenance and shows effort only when set', () => {
  const name = (id: string) => id.toUpperCase()
  assert.equal(describeModel({}, name), 'unknown model')
  assert.equal(describeModel({ model: 'a', modelSource: 'configured' }, name), 'A (configured)')
  assert.equal(describeModel({ model: 'a', modelSource: 'runtime', effort: 'high' }, name), 'A (actual), effort high')
  assert.equal(describeModel({ model: 'a', modelSource: 'runtime', requestedModel: 'opus' }, name), 'A (requested \u2260 actual), requested OPUS')
})
