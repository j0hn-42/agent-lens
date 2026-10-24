import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { truncateName } from '../web/lib/truncate-name'

test('truncateName clips with a single ellipsis character', () => {
  assert.equal(truncateName('orchestrator-main', 13), 'orchestrator-…')
  assert.equal(truncateName('short', 13), 'short')
})

test('no panel clips an agent name with two dots', () => {
  for (const f of ['timeline-panel.tsx', 'conversation-panel.tsx']) {
    const src = readFileSync(new URL(`../web/components/agent-visualizer/${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\+ '\.\.'/, f)
  }
})
