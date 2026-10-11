// #247: per-layer motion. Pure logic, node:test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MOTION_LAYERS, DEFAULT_CALM_LAYERS, parseCalmLayers, serializeCalmLayers, toggleCalmLayer, layerIsCalm,
  allLayersCalm, MOTION_LAYERS_STORAGE_KEY,
} from '../web/lib/motion-layers'

test('four layers, in draw order, none calm by default', () => {
  assert.deepEqual([...MOTION_LAYERS], ['background', 'links', 'agents', 'effects'])
  assert.deepEqual(DEFAULT_CALM_LAYERS, { background: false, links: false, agents: false, effects: false })
  assert.ok(MOTION_LAYERS_STORAGE_KEY.length > 0)
})

test('the global reduced motion (OS or Pause animations) calms every layer', () => {
  for (const l of MOTION_LAYERS) assert.equal(layerIsCalm(true, DEFAULT_CALM_LAYERS, l), true)
  for (const l of MOTION_LAYERS) assert.equal(layerIsCalm(false, DEFAULT_CALM_LAYERS, l), false)
})

test('a single calm layer calms only that layer', () => {
  const calm = toggleCalmLayer(DEFAULT_CALM_LAYERS, 'background')
  assert.equal(layerIsCalm(false, calm, 'background'), true)
  assert.equal(layerIsCalm(false, calm, 'agents'), false)
  assert.equal(allLayersCalm(calm), false)
  assert.equal(toggleCalmLayer(calm, 'background').background, false)
})

test('toggling never mutates its input', () => {
  const before = { ...DEFAULT_CALM_LAYERS }
  toggleCalmLayer(DEFAULT_CALM_LAYERS, 'effects')
  assert.deepEqual(DEFAULT_CALM_LAYERS, before)
})

test('all four layers calm is the same as reduced motion', () => {
  let calm = DEFAULT_CALM_LAYERS
  for (const l of MOTION_LAYERS) calm = toggleCalmLayer(calm, l)
  assert.equal(allLayersCalm(calm), true)
})

test('stored value: round trip, garbage and hostile payloads fall back to the default', () => {
  const calm = toggleCalmLayer(DEFAULT_CALM_LAYERS, 'links')
  assert.deepEqual(parseCalmLayers(serializeCalmLayers(calm)), calm)
  for (const bad of [null, undefined, '', 'nope', '[]', '42', '{"links":"yes"}', '{"__proto__":{"links":true}}', 'x'.repeat(5000)]) {
    assert.deepEqual(parseCalmLayers(bad), DEFAULT_CALM_LAYERS, String(bad).slice(0, 20))
  }
  assert.deepEqual(parseCalmLayers('{"agents":true,"unknown":true}'), { ...DEFAULT_CALM_LAYERS, agents: true })
})
