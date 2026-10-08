import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productionHtml } from '../src/webview-html'

const params = { cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/index.js', styleUri: 'vscode-resource:/index.css', nonce: 'N0nce' }

test('webview shell: the theme script runs before the app bundle and carries the CSP nonce', () => {
  const html = productionHtml(params)
  const theme = html.indexOf('dataset.theme') // set by the bootstrap
  const bundle = html.indexOf('src="vscode-resource:/index.js"')
  assert.ok(theme > 0 && bundle > theme, 'theme script precedes the bundle')
  assert.match(html, /<script nonce="N0nce">\(function/)
  assert.match(html, /script-src 'nonce-N0nce'/)
})
