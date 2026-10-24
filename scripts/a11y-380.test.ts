// #380: source-level guards for markup that no runtime check sees (jsdom has no colour contrast, no theme loop).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

test('the canvas focus rings take the --lens-focus token, not a hard-coded white (2.4.7)', () => {
  assert.doesNotMatch(read('web/components/agent-visualizer/canvas.tsx'), /outline-white/)
})

test('the tool result block carries no opacity or alpha-suffixed colour (1.4.3)', () => {
  const src = read('web/components/agent-visualizer/tool-detail-popup.tsx')
  const start = src.indexOf('aria-label="Tool result"')
  const end = src.indexOf('</div>', start)
  assert.ok(start > 0 && end > start, 'block found')
  const block = src.slice(start, end)
  assert.doesNotMatch(block, /opacity/)
  assert.doesNotMatch(block, /\b(?:text|bg|border)-[\w[\]#-]+\/\d+/)
})
