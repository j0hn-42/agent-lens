import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { formatTokens, formatCost, formatDuration, pluralize } from '../web/lib/utils'
import { agentCost, totalAgentCost } from '../web/lib/cost'

test('formatTokens', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(NaN), '0')
  assert.equal(formatTokens(640), '640')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(9999), '9.9k')
  assert.equal(formatTokens(12_345), '12k')
  assert.equal(formatTokens(128_500), '128k')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(1_250_000), '1.2M')
  assert.equal(formatTokens(25_000_000), '25M')
})

test('formatCost uses one consistent format', () => {
  assert.equal(formatCost(0), '$0.00')
  assert.equal(formatCost(0.0004), '$0.0004')
  assert.equal(formatCost(0.0123), '$0.01')
  assert.equal(formatCost(1.234), '$1.23')
})

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(-3), '0:00')
  assert.equal(formatDuration(12.9), '0:12')
  assert.equal(formatDuration(75), '1:15')
  assert.equal(formatDuration(3600), '1:00:00')
  assert.equal(formatDuration(3725), '1:02:05')
})

test('pluralize', () => {
  assert.equal(pluralize(0, 'agent'), '0 agents')
  assert.equal(pluralize(1, 'agent'), '1 agent')
  assert.equal(pluralize(2, 'file'), '2 files')
  assert.equal(pluralize(2, 'child', 'children'), '2 children')
})

test('total cost equals the sum of per-agent costs priced by model', () => {
  const agents = [
    { tokensUsed: 500_000, model: 'claude-opus-4-6-20250514' },
    { tokensUsed: 2_000_000, model: 'claude-haiku-4-5-20251001' },
    { tokensUsed: 300_000 },
  ]
  const expected = agents.reduce((s, a) => s + agentCost(a.tokensUsed, a.model), 0)
  assert.equal(totalAgentCost(agents), expected)
  const flat = agentCost(agents.reduce((s, a) => s + a.tokensUsed, 0))
  assert.notEqual(totalAgentCost(agents), flat)
})
