/**
 * Burrow view: the pictures are PNG files next to the bundle (web/public/burrow in the Next app, burrow/ beside
 * index.js in the webview and the standalone app), not base64 strings parsed as JavaScript.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'
import { burrowImageNames, burrowImageUrl, setBurrowAssetBase } from '../web/lib/burrow/burrow-assets'

const DIR = path.join(__dirname, '..', 'web', 'public', 'burrow')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('every picture the burrow draws (decor, effects, one sheet per sprite of the data) is a PNG file', () => {
  const names = burrowImageNames(BURROW_DATA)
  assert.ok(names.includes('decor'))
  assert.ok(names.includes('fx'))
  for (const sprite of Object.keys(BURROW_DATA.sprites)) assert.ok(names.includes(sprite), sprite)
  for (const n of names) {
    const file = path.join(DIR, `${n}.png`)
    assert.ok(fs.existsSync(file), `missing ${file}`)
    assert.deepEqual(fs.readFileSync(file).subarray(0, 8), PNG_SIGNATURE, `${n}.png is not a PNG`)
  }
})

test('the decor has the size of the map its coordinates are given in', () => {
  const png = fs.readFileSync(path.join(DIR, 'decor.png'))
  assert.equal(png.readUInt32BE(16), BURROW_DATA.map.w)
  assert.equal(png.readUInt32BE(20), BURROW_DATA.map.h)
})

test('no picture is shipped that the burrow does not draw', () => {
  const names = new Set(burrowImageNames(BURROW_DATA))
  for (const f of fs.readdirSync(DIR)) assert.ok(names.has(f.replace(/\.png$/, '')), `unused ${f}`)
})

test('a picture is fetched from /burrow/ of the site, or beside the script of a bundle that sets its base', () => {
  assert.equal(burrowImageUrl('decor'), '/burrow/decor.png')
  setBurrowAssetBase('vscode-webview://abc/ext/dist/webview/index.js?v=2')
  assert.equal(burrowImageUrl('fox'), 'vscode-webview://abc/ext/dist/webview/burrow/fox.png')
  setBurrowAssetBase('http://127.0.0.1:3001/index.js')
  assert.equal(burrowImageUrl('fx'), 'http://127.0.0.1:3001/burrow/fx.png')
})
