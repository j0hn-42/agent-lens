// #387: the text of a redirect, cleaned on the page the way the extension cleans it, so an empty or invisible-only
// text is never sent. Pure logic, node:test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REDIRECT_MESSAGE_MAX, redirectMessage } from '../web/lib/permission-requests'

test('a redirect text is trimmed and keeps its line breaks', () => {
  assert.equal(redirectMessage('  use pnpm\ninstead  '), 'use pnpm\ninstead')
})

test('blank, control-only or invisible-only texts give nothing to send', () => {
  for (const text of ['', '   ', '\n\t', '\u0007', '​‮', ' \u0000 ']) assert.equal(redirectMessage(text), '', JSON.stringify(text))
})

test('control and invisible characters are removed, never passed on', () => {
  assert.equal(redirectMessage('use\u0007 pnpm‮'), 'use pnpm')
})

test('the text is capped like the extension caps it', () => {
  assert.equal(REDIRECT_MESSAGE_MAX, 2000)
  assert.equal(redirectMessage('x'.repeat(5000)).length, REDIRECT_MESSAGE_MAX)
})
