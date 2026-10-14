// #380: source-level guards for markup that no runtime check sees (jsdom has no colour contrast, no theme loop).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

test('the canvas focus rings take the --lens-focus token, not a hard-coded white (2.4.7)', () => {
  assert.doesNotMatch(read('web/components/agent-visualizer/canvas.tsx'), /outline-white/)
})

test('the "Result:" label of the tool popup is not dimmed with an opacity (1.4.3)', () => {
  const src = read('web/components/agent-visualizer/tool-detail-popup.tsx')
  assert.doesNotMatch(src, /opacity-70[^\n]*Result:/)
})
