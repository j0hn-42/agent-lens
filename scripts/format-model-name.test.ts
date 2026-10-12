import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { formatModelName, modelTierColor } from '../web/lib/utils'
import { CLAUDE_FAMILIES } from '../web/lib/canvas-constants'

test('formats new Claude model ids', () => {
  assert.equal(formatModelName('claude-sonnet-4-20250514'), 'Sonnet 4')
  assert.equal(formatModelName('claude-opus-4-6-20250514'), 'Opus 4.6')
  assert.equal(formatModelName('claude-opus-4-1-20250805'), 'Opus 4.1')
  assert.equal(formatModelName('claude-haiku-4-5-20251001'), 'Haiku 4.5')
})

test('formats legacy Claude model ids', () => {
  assert.equal(formatModelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5')
  assert.equal(formatModelName('claude-3-haiku-20240307'), 'Haiku 3')
})

test('formats additional Claude families declared in the formatter', () => {
  assert.equal(formatModelName('claude-fable-1-20250101'), 'Fable 1')
  assert.equal(formatModelName('claude-2-mythos-20250101'), 'Mythos 2')
})

test('strips Bedrock/Vertex provider prefixes and version suffixes', () => {
  assert.equal(formatModelName('us.anthropic.claude-sonnet-4-20250514-v1:0'), 'Sonnet 4')
  assert.equal(formatModelName('us.anthropic.claude-opus-4-1-20250805-v1:0'), 'Opus 4.1')
  assert.equal(formatModelName('eu.anthropic.claude-haiku-4-5-20251001-v2:0'), 'Haiku 4.5')
})

test('formats GPT model ids', () => {
  assert.equal(formatModelName('gpt-5.3-codex'), 'GPT-5.3-codex')
  assert.equal(formatModelName('gpt-5-2025-01-01'), 'GPT-5')
  assert.equal(formatModelName('gpt-4o-2024-08-06'), 'GPT-4o')
  assert.equal(formatModelName('chatgpt-4o-latest'), 'GPT-4o-latest')
})

test('modelTierColor scales colour with model size', () => {
  const red = '#ff5a5a', orange = '#ff9a3c', blue = '#5aa9ff'
  assert.equal(modelTierColor('claude-fable-5-1'), red)
  assert.equal(modelTierColor('claude-opus-5-5'), orange)
  assert.equal(modelTierColor('claude-haiku-4-5-20251001'), blue)
  assert.equal(modelTierColor('gpt-5.6-sol'), red)
  assert.equal(modelTierColor('gpt-5.6-terra'), orange)
  assert.equal(modelTierColor('gpt-5.6-luna'), blue)
  assert.equal(modelTierColor('gpt-5.5-pro'), red)
  assert.equal(modelTierColor('gpt-5.4-mini'), blue)
  assert.equal(modelTierColor('o3'), orange)
  assert.equal(modelTierColor('o4-mini'), blue)
  assert.equal(modelTierColor('gpt-4.1-nano'), blue)
  assert.equal(modelTierColor('gpt-oss-120b'), orange)
})

test('falls back to stripped base model id for unknown formats', () => {
  assert.equal(formatModelName('custom-model-20250101'), 'custom-model')
})

test('matches case-insensitively, preserving fallback case', () => {
  assert.equal(formatModelName('CLAUDE-3-5-SONNET-20241022'), 'Sonnet 3.5')
  assert.equal(formatModelName('US.ANTHROPIC.CLAUDE-OPUS-4-1-20250805-V1:0'), 'Opus 4.1')
  assert.equal(formatModelName('Custom-Model-20250101'), 'Custom-Model')
})

test('every CLAUDE_FAMILIES entry is formattable', () => {
  for (const f of CLAUDE_FAMILIES) {
    assert.equal(formatModelName(`claude-${f.name}-9-20990101`), `${f.name[0].toUpperCase()}${f.name.slice(1)} 9`)
  }
})
