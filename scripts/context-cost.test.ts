// #364: the "$" is the context size × a blended rate, not a bill. Every cost figure says it is an estimate
// ("~" on screen, "context cost estimate" in words), even when the tokens are reported by the runtime (Codex).
import './all-locales' // #662: the tables are loaded on demand, every one is loaded before the tests
import { test } from 'node:test'
import { readReadingGuideDomains } from './reading-guide'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatCostUsage, spokenCostUsage, USAGE_LABELS } from '../web/lib/usage'
import { COST_LABELS } from '../web/lib/ui-glossary'
import { formatRollup, type RollupTotal } from '../web/lib/cost-rollup'
import { costCell } from '../web/lib/session-columns'
import { clusterAnnouncement } from '../web/components/agent-visualizer/canvas/cluster-model'
import { evaluateTriggers, emptySnapshot, DEFAULT_RULES, type NotifySnapshot } from '../web/lib/notification-rules'

const reported = { value: 2.1, status: 'available', estimated: false } as const

test('a cost priced from reported tokens is still marked as an estimate', () => {
  assert.equal(formatCostUsage(reported), '~$2.10')
  assert.equal(formatCostUsage({ value: 0.5, status: 'partial', estimated: true }), `${USAGE_LABELS.atLeast} ~$0.500 ${USAGE_LABELS.estimated}`)
  assert.equal(formatCostUsage({ value: null, status: 'unavailable', estimated: false }), USAGE_LABELS.unavailable)
})

test('the spoken cost names the estimate in words, without a "~" a screen reader would spell out', () => {
  assert.equal(spokenCostUsage(reported), `${COST_LABELS.name} $2.10`)
  assert.equal(spokenCostUsage({ value: null, status: 'unavailable', estimated: false }), `${COST_LABELS.name} ${USAGE_LABELS.unavailable}`)
  assert.doesNotMatch(spokenCostUsage(reported), /~/)
})

test('the method says what the figure is and what it misses', () => {
  assert.match(COST_LABELS.method, /context/i)
  assert.match(COST_LABELS.method, /blended/i)
  assert.match(COST_LABELS.method, /compact/i)
  assert.match(COST_LABELS.method, /cache/i)
})

test('rollups and session cells carry the estimate mark', () => {
  const total: RollupTotal = { tokens: 1_000_000, cost: 6, agents: 1, known: 1, unknown: 0, complete: true, estimated: false }
  assert.equal(formatRollup(total), '~$6.00 · 1M')
  const cell = costCell(total)
  assert.equal(cell.text, '~$6.00')
  assert.equal(cell.label, `${COST_LABELS.name} $6.00`, 'same order as every other spoken cost')
  assert.equal(costCell({ ...total, complete: false, estimated: true }).label, `${COST_LABELS.name} $6.00, from estimated tokens, incomplete`)
})

test('a halo announcement and the cost notification name the estimate', () => {
  const c = { kind: 'session' as const, title: 'S', memberIds: ['a'], runtime: 'Claude' as const, workspace: 'w', projectName: '', statusText: 'working', costText: formatCostUsage(reported), costSpoken: spokenCostUsage(reported) }
  assert.match(clusterAnnouncement(c), new RegExp(`${COST_LABELS.name} \\$2\\.10`))
  assert.doesNotMatch(clusterAnnouncement(c), /~/)
  const prev: NotifySnapshot = { ...emptySnapshot(), cost: { value: 0, status: 'available', estimated: false } }
  const cur: NotifySnapshot = { ...prev, cost: { value: 5.5, status: 'available', estimated: false } }
  const items = evaluateTriggers(prev, cur, { ...DEFAULT_RULES, cost: true, costThresholdUsd: 5 })
  const body = items.find(i => i.trigger === 'cost')?.body ?? ''
  assert.match(body, new RegExp(`^${COST_LABELS.name[0].toUpperCase()}${COST_LABELS.name.slice(1)} reached ~\\$5\\.50`))
})

test('the guide explains the context cost estimate and the tokens in context', () => {
  const guide = readReadingGuideDomains()
  assert.match(guide, /context cost estimate/)
  assert.match(guide, /tokens in context/)
  assert.match(guide, /compaction/)
  assert.match(guide, /cache reads/)
})
