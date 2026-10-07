import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HTML_SHELL } from './static'

test('standalone shell: the theme script is inline in <body>, before the root and the bundle', () => {
  const theme = HTML_SHELL.indexOf('dataset.theme')
  assert.ok(theme > 0)
  assert.ok(theme < HTML_SHELL.indexOf('id="root"'))
  assert.ok(theme < HTML_SHELL.indexOf('src="/index.js"'))
  assert.ok(HTML_SHELL.indexOf('<body') < theme, 'after <body> opens so host classes can be read')
})
