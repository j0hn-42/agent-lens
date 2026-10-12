// The helpers web/lib used to expose twice (#222): tab navigation, focus ring, m:ss time. One source each.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { FOCUS_RING, FOCUS_RING_INSET } from '../web/lib/focus-ring'
import { nextTabIndex } from '../web/lib/tab-nav'
import { formatElapsed } from '../web/lib/feed-utils'
import { formatDuration } from '../web/lib/utils'
import { buildLinkPanelModel } from '../web/components/agent-visualizer/canvas/link-panel-model'

function linkTimeText(seconds: number): string {
  const link: any = {
    id: 'L1', from: 's1:lead', to: 's1:alice', kind: 'teammate', sessionId: 's1', dropped: 0,
    messages: [{ id: 'm1', type: 'message', content: 'hello', timestamp: seconds }],
  }
  return buildLinkPanelModel(link, new Map()).entries[0].timeText
}

test('nextTabIndex: one signature (current, key, count, orientation), horizontal by default', () => {
  assert.equal(nextTabIndex(0, 'ArrowLeft', 3), 2)
  assert.equal(nextTabIndex(2, 'ArrowRight', 3), 0)
  assert.equal(nextTabIndex(1, 'Home', 3), 0)
  assert.equal(nextTabIndex(1, 'End', 3), 2)
  assert.equal(nextTabIndex(1, 'ArrowDown', 3), null)
  assert.equal(nextTabIndex(1, 'a', 3), null)
  assert.equal(nextTabIndex(0, 'ArrowRight', 0), null)
  assert.equal(nextTabIndex(0, 'Home', 0, 'both'), null)
})

test("nextTabIndex: 'both' orientation also handles Up/Down and wraps", () => {
  assert.equal(nextTabIndex(2, 'ArrowDown', 3, 'both'), 0)
  assert.equal(nextTabIndex(0, 'ArrowUp', 3, 'both'), 2)
  assert.equal(nextTabIndex(0, 'ArrowLeft', 3, 'both'), 2)
  assert.equal(nextTabIndex(0, 'Enter', 3, 'both'), null)
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.next' ? [] : sourceFiles(full)
    return /\.(ts|tsx|css)$/.test(e.name) ? [full] : []
  })
}
const root = join(__dirname, '..')
const webSources = ['web/components', 'web/lib', 'web/app'].flatMap(d => sourceFiles(join(root, d)))

test('focus ring: one source, one theme token, an explicit inset variant', () => {
  assert.match(FOCUS_RING, /outline-offset-2/)
  assert.match(FOCUS_RING, /var\(--lens-focus\)/)
  assert.match(FOCUS_RING_INSET, /-outline-offset-2/)
  assert.match(FOCUS_RING_INSET, /var\(--lens-focus\)/)
  assert.notEqual(FOCUS_RING, FOCUS_RING_INSET)
})

test('focus ring: no component spells the ring inline and --lens-focus-ring is gone', () => {
  // The canvas draws white outlines on the scene: not a control ring.
  const allowed = new Set(['web/lib/focus-ring.ts', 'web/components/agent-visualizer/canvas.tsx'])
  for (const file of webSources) {
    const rel = relative(root, file)
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /--lens-focus-ring/, `${rel}: --lens-focus-ring was merged into --lens-focus`)
    if (allowed.has(rel)) continue
    const inline = text.split('\n').filter(l => /(?<![\w-])focus-visible:(outline-offset|-outline-offset|outline-\[)/.test(l))
    assert.deepEqual(inline, [], `${rel}: use FOCUS_RING / FOCUS_RING_INSET from lib/focus-ring`)
  }
})

test('simulation time: 59 s, 3599 s and 3600 s read the same in the control bar, the conversation and the Link panel', () => {
  for (const [seconds, text] of [[59, '0:59'], [3599, '59:59'], [3600, '1:00:00'], [4500, '1:15:00']] as const) {
    assert.equal(formatDuration(seconds), text, `formatDuration(${seconds})`)
    assert.equal(formatElapsed(seconds).label, text, `formatElapsed(${seconds})`)
    assert.equal(linkTimeText(seconds), text, `link panel at ${seconds}`)
  }
})

test('formatElapsed keeps its ISO duration and clamps bad input like formatDuration', () => {
  assert.deepEqual(formatElapsed(75.4), { label: '1:15', iso: 'PT75.4S' })
  assert.equal(formatElapsed(-3).label, '0:00')
  assert.equal(formatElapsed(NaN).iso, 'PT0.0S')
})
