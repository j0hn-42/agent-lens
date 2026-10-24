import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { fitClusterLabelLines } from '../web/components/agent-visualizer/canvas/cluster-model'
import { drawClusterLabels } from '../web/components/agent-visualizer/canvas/draw-teams'

/** Monospace measure: 7 px per character */
const measure = (s: string) => s.length * 7

test('fitClusterLabelLines: a long title keeps its member count, with an ellipsis and no orphan parenthesis (#378)', () => {
  const lines = { title: 'Session payments-api · refactor the ledger reconciliation (4)', detail: 'claude · payments-api · idle' }
  const fit = fitClusterLabelLines(lines, 30 * 7, 40 * 7, measure)
  assert.ok(measure(fit.title) <= 30 * 7, fit.title)
  assert.ok(fit.title.endsWith('… (4)'), fit.title)
  assert.ok(fit.title.startsWith('Session payments-api'), fit.title)
  // Never a cut "(" without its count
  assert.equal((fit.title.match(/\(/g) ?? []).length, (fit.title.match(/\)/g) ?? []).length)
})

test('fitClusterLabelLines: a title that fits is unchanged (#378)', () => {
  const lines = { title: 'Team web (3)', detail: 'claude · idle' }
  assert.deepEqual(fitClusterLabelLines(lines, 200, 200, measure), lines)
})

test('fitClusterLabelLines: a long detail line ends with an ellipsis instead of a hard cut (#378)', () => {
  const lines = { title: 'Team web (3)', detail: 'claude · agent-lens · /home/someone/projects/agent-lens/web · 2 working · $1.20' }
  const fit = fitClusterLabelLines(lines, 200, 30 * 7, measure)
  assert.ok(measure(fit.detail) <= 30 * 7, fit.detail)
  assert.ok(fit.detail.endsWith('…'), fit.detail)
})

test('fitClusterLabelLines: room smaller than the count suffix falls back to a plain ellipsis (#378)', () => {
  const fit = fitClusterLabelLines({ title: 'Session payments-api (12)', detail: '' }, 3 * 7, 100, measure)
  assert.ok(measure(fit.title) <= 3 * 7, fit.title)
  assert.ok(fit.title.endsWith('…'), fit.title)
})

/* eslint-disable @typescript-eslint/no-explicit-any */
test('drawClusterLabels: the drawn title of a narrow chip keeps its count, with an ellipsis (#378)', () => {
  const texts: string[] = []
  const ctx: any = new Proxy({}, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: measure(s) })
      if (k === 'fillText') return (s: string) => { texts.push(s) }
      return () => {}
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  const cluster: any = {
    key: 'k', kind: 'session', title: 'payments-api · refactor the ledger reconciliation', color: '#336699',
    cx: 0, cy: 0, r: 100, memberIds: ['a', 'b', 'c', 'd'], runtime: 'Claude', statusText: 'idle', costText: '',
  }
  const w = 30 * 7
  const plan = new Map([['cluster:k', { id: 'cluster:k', dx: 0, dy: 0, rect: { x: 0, y: 0, w, h: 36 }, hidden: false, collapsed: false }]])
  drawClusterLabels(ctx, [cluster], plan)
  const title = texts[0]
  assert.ok(title.endsWith('… (4)'), title)
  // The title starts after the colour dot (18 px) and the chip clips 4 px before its right edge
  assert.ok(18 + measure(title) <= w - 4, title)
})
