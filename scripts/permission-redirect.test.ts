// #387: the text of a redirect, cleaned on the page the way the extension cleans it, so an empty or invisible-only
// text is never sent; and the proof that a refusal was applied. Pure logic, node:test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { REDIRECT_MESSAGE_MAX, carriesRefusal, redirectMessage, refusalProbe } from '../web/lib/permission-requests'

test('a redirect text is trimmed and keeps its line breaks', () => {
  assert.equal(redirectMessage('  use pnpm\ninstead  '), 'use pnpm\ninstead')
})

test('blank, control-only or invisible-only texts give nothing to send', () => {
  for (const text of ['', '   ', '\n\t', '\u0007', '\u200b\u202e', ' \u0000 ']) assert.equal(redirectMessage(text), '', JSON.stringify(text))
})

test('control and invisible characters are removed, never passed on', () => {
  assert.equal(redirectMessage('use\u0007 pnpm\u202e'), 'use pnpm')
})

test('the text is capped like the extension caps it', () => {
  assert.equal(REDIRECT_MESSAGE_MAX, 2000)
  assert.equal(redirectMessage('x'.repeat(5000)).length, REDIRECT_MESSAGE_MAX)
})

test('the cut never splits a surrogate pair', () => {
  const out = redirectMessage('x'.repeat(REDIRECT_MESSAGE_MAX - 1) + '😀')
  assert.ok(!/[\uD800-\uDBFF]$/.test(out), 'no lone high surrogate at the end')
})

// The proof of a refusal: an error end of the call whose text carries the refusal this page sent
test('the deny probe is the very text the extension hands Claude Code', () => {
  const gate = readFileSync(new URL('../extension/src/permission-gate.ts', import.meta.url), 'utf8')
  const probe = refusalProbe('deny')
  assert.ok(probe && gate.includes(`message: '${probe}'`), 'web and extension agree on the deny text')
})

test('a redirect probe is the beginning of the cleaned text, spaces collapsed', () => {
  assert.equal(refusalProbe('redirect', '  use\n\n pnpm   instead '), 'use pnpm instead')
  assert.equal(refusalProbe('redirect', 'x'.repeat(500))?.length, 40)
  assert.equal(refusalProbe('redirect', ''), null)
  assert.equal(refusalProbe('approve'), null)
})

test('a result carries the refusal only when it contains the probe and is not a hook failure', () => {
  assert.equal(carriesRefusal('use pnpm instead', 'use pnpm\ninstead, please'), true)
  assert.equal(carriesRefusal('use pnpm instead', 'Error: use pnpm   instead'), true)
  assert.equal(carriesRefusal('use pnpm instead', 'Exit code 1'), false)
  assert.equal(carriesRefusal('use pnpm instead', '[FAILED] use pnpm instead'), false)
  assert.equal(carriesRefusal('use pnpm instead', undefined), false)
})
