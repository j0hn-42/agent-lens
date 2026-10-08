import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { formatTokens, formatCost, formatDuration, pluralize } from '../web/lib/utils'
import { agentCost } from '../web/lib/cost'

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
  assert.equal(formatCost(0.0123), '$0.012')
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

const table = <I, O>(name: string, fn: (i: I) => O, rows: [I, O][]) =>
  test(name, () => { for (const [i, o] of rows) assert.equal(fn(i), o, `${name}(${String(i)})`) })

table('formatTokens table', formatTokens, [
  [-5, '0'], [Infinity, '0'], [0.4, '0'], [1, '1'], [999, '999'], [999.9, '999'],
  [1000, '1k'], [1050, '1k'], [9999, '9.9k'], [10_000, '10k'], [289_000, '289k'],
  [999_999, '999k'], [1_000_000, '1M'], [9_999_999, '9.9M'], [10_000_000, '10M'], [5e12, '5000000M'],
])

table('formatCost table', formatCost, [
  [NaN, '$0.00'], [-1, '$0.00'], [Infinity, '$0.00'], [0, '$0.00'],
  [1e-9, '<$0.0001'], [0.00009, '<$0.0001'], [0.0001, '$0.0001'], [0.0004, '$0.0004'],
  [0.00994, '$0.0099'], [0.00996, '$0.010'], [0.00999, '$0.010'], [0.01, '$0.010'], [0.1234, '$0.123'],
  [0.9994, '$0.999'], [0.9996, '$1.00'], [1, '$1.00'], [1.005, '$1.00'], [12.345, '$12.35'], [1234.5, '$1234.50'],
])

table('formatDuration table', formatDuration, [
  [NaN, '0:00'], [-1, '0:00'], [Infinity, '0:00'], [0, '0:00'], [0.9, '0:00'], [59.9, '0:59'], [60, '1:00'],
  [3599, '59:59'], [3599.9, '59:59'], [3600, '1:00:00'], [86_400, '24:00:00'], [360_000, '100:00:00'],
])

table('pluralize table', (n: number) => pluralize(n, 'session'), [
  [0, '0 sessions'], [1, '1 session'], [2, '2 sessions'], [-1, '-1 sessions'],
])
