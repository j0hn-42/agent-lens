import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  sumUsage, combineUsage, usageFromAgent, formatTokenUsage, formatCostUsage, readTokenCost, readTokenSource, USAGE_LABELS, effectiveTokenStatus, isValue,
} from '../web/lib/usage'

test('sumUsage: no value at all is unavailable (null), never 0', () => {
  assert.deepEqual(sumUsage([]), { value: null, status: 'unavailable', estimated: false })
  assert.deepEqual(sumUsage([null, undefined]), { value: null, status: 'unavailable', estimated: false })
})

test('sumUsage: an exact 0 stays available and is distinct from absent', () => {
  assert.deepEqual(sumUsage([0]), { value: 0, status: 'available', estimated: false })
  assert.equal(sumUsage([0, null]).status, 'partial')
})

test('sumUsage: a partial total is a lower bound', () => {
  const t = sumUsage([100, null, 50])
  assert.equal(t.value, 150)
  assert.equal(t.status, 'partial')
})

test('sumUsage: all present is available; estimated flag is passed through', () => {
  assert.deepEqual(sumUsage([1, 2, 3]), { value: 6, status: 'available', estimated: false })
  assert.equal(sumUsage([1, 2], true).estimated, true)
  assert.equal(sumUsage([null], true).estimated, false, 'nothing to qualify when nothing is known')
})

test('sumUsage ignores non-finite and negative numbers (treated as absent)', () => {
  assert.equal(sumUsage([NaN, -5, Infinity]).status, 'unavailable')
  assert.equal(sumUsage([10, NaN]).status, 'partial')
})

test('combineUsage: unavailable parts degrade an otherwise exact total to partial', () => {
  const exact = { value: 10, status: 'available' as const, estimated: false }
  const part = { value: 5, status: 'partial' as const, estimated: true }
  const none = { value: null, status: 'unavailable' as const, estimated: false }
  assert.deepEqual(combineUsage([exact, exact]), { value: 20, status: 'available', estimated: false })
  assert.deepEqual(combineUsage([exact, part]), { value: 15, status: 'partial', estimated: true })
  assert.deepEqual(combineUsage([exact, none]), { value: 10, status: 'partial', estimated: false })
  assert.deepEqual(combineUsage([none, none]), { value: null, status: 'unavailable', estimated: false })
  assert.deepEqual(combineUsage([]), { value: null, status: 'unavailable', estimated: false })
})

test('usageFromAgent: explicit status wins, legacy agents infer it from the counter', () => {
  assert.deepEqual(usageFromAgent({ tokensUsed: 0, tokenStatus: 'unavailable' }), { value: null, status: 'unavailable', estimated: false })
  assert.deepEqual(usageFromAgent({ tokensUsed: 40, tokenStatus: 'partial', tokensEstimated: true }), { value: 40, status: 'partial', estimated: true })
  assert.equal(usageFromAgent({ tokensUsed: 40 }).status, 'available')
  assert.equal(usageFromAgent({ tokensUsed: 0 }).status, 'unavailable')
})

test('formatTokenUsage: unavailable, partial (au moins) and estimated (badge)', () => {
  assert.equal(formatTokenUsage({ value: null, status: 'unavailable', estimated: false }), USAGE_LABELS.unavailable)
  assert.equal(formatTokenUsage({ value: 1500, status: 'available', estimated: false }), '1.5k')
  assert.equal(formatTokenUsage({ value: 1500, status: 'partial', estimated: false }), `${USAGE_LABELS.atLeast} 1.5k`)
  assert.equal(formatTokenUsage({ value: 1500, status: 'available', estimated: true }), `1.5k ${USAGE_LABELS.estimated}`)
  assert.equal(formatTokenUsage({ value: 1500, status: 'partial', estimated: true }), `${USAGE_LABELS.atLeast} 1.5k ${USAGE_LABELS.estimated}`)
  assert.equal(formatTokenUsage({ value: 0, status: 'available', estimated: false }), '0')
})

test('formatCostUsage mirrors the token total with a currency format', () => {
  assert.equal(formatCostUsage({ value: null, status: 'unavailable', estimated: false }), USAGE_LABELS.unavailable)
  assert.equal(formatCostUsage({ value: 0.5, status: 'partial', estimated: true }), `${USAGE_LABELS.atLeast} $0.500 ${USAGE_LABELS.estimated}`)
})

test('readTokenCost: only a finite non-negative number is a value; anything else is null (not 0)', () => {
  assert.equal(readTokenCost(120), 120)
  assert.equal(readTokenCost(0), 0)
  assert.equal(readTokenCost(undefined), null)
  assert.equal(readTokenCost('12'), null)
  assert.equal(readTokenCost(-1), null)
  assert.equal(readTokenCost(NaN), null)
})

test('readTokenSource: reported only when stated, estimated otherwise', () => {
  assert.equal(readTokenSource('reported'), 'reported')
  assert.equal(readTokenSource('estimated'), 'estimated')
  assert.equal(readTokenSource(undefined), 'estimated')
  assert.equal(readTokenSource('whatever'), 'estimated')
})

test('effectiveTokenStatus: an explicit status wins, a legacy agent infers it from the counter', () => {
  assert.equal(effectiveTokenStatus({ tokensUsed: 0, tokenStatus: 'available' }), 'available')
  assert.equal(effectiveTokenStatus({ tokensUsed: 50, tokenStatus: 'partial' }), 'partial')
  assert.equal(effectiveTokenStatus({ tokensUsed: 50 }), 'available')
  assert.equal(effectiveTokenStatus({ tokensUsed: 0 }), 'unavailable')
  assert.equal(usageFromAgent({ tokensUsed: 0 }).status, effectiveTokenStatus({ tokensUsed: 0 }))
})

test('isValue: only finite non-negative numbers', () => {
  assert.equal(isValue(0), true)
  assert.equal(isValue(3.5), true)
  for (const bad of [-1, NaN, Infinity, '5', null, undefined]) assert.equal(isValue(bad), false)
})
