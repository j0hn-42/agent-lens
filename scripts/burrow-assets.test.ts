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

const size = (name: string) => {
  const png = fs.readFileSync(path.join(DIR, `${name}.png`))
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) }
}

test('every picture name is one the standalone app serves: lower-case letters, digits and hyphens', () => {
  for (const n of burrowImageNames(BURROW_DATA)) assert.match(n, /^[a-z0-9-]+$/, n)
})

test('the squirrel has a close-up picture, loaded with the others, as wide as its columns and as high as its cell', () => {
  assert.ok(burrowImageNames(BURROW_DATA).includes('squirrel-glass'))
  const glass = BURROW_DATA.sprites.squirrel.glass
  assert.ok(glass)
  const { w, h } = size('squirrel-glass')
  assert.equal(h, glass.cell[1])
  assert.equal(w % glass.cell[0], 0)
  assert.equal(w, 1456)
  for (const [sprite, meta] of Object.entries(BURROW_DATA.sprites)) {
    if (sprite !== 'squirrel') assert.equal(meta.glass, undefined, `${sprite} has no close-up`)
  }
})

test('every walk row and every pose of every sheet lies inside its picture', () => {
  for (const [sprite, meta] of Object.entries(BURROW_DATA.sprites)) {
    const { w, h } = size(sprite)
    for (const [dir, a] of Object.entries(meta.anims)) {
      assert.ok((a.row + 1) * meta.cell <= h, `${sprite} ${dir} row`)
      assert.ok(a.frames * meta.cell <= w, `${sprite} ${dir} frames`)
    }
    for (const [name, p] of Object.entries(meta.poses)) {
      assert.ok((p.col + 1) * meta.cell <= w, `${sprite}.${name} col`)
      assert.ok((p.row + 1) * meta.cell <= h, `${sprite}.${name} row`)
      assert.ok(p.h > 0 && p.h <= meta.cell, `${sprite}.${name} h`)
    }
  }
})

test('every close-up pose lies inside the close-up picture, its x range inside the cell', () => {
  const glass = BURROW_DATA.sprites.squirrel.glass!
  const { w } = size('squirrel-glass')
  assert.deepEqual(Object.keys(glass.poses).sort(), [
    'acornHit', 'acornUp', 'breath', 'finger', 'knock', 'peek', 'ready', 'rest', 'shock', 'shrug', 'squish', 'waveA', 'waveB',
  ])
  for (const [name, p] of Object.entries(glass.poses)) {
    assert.ok((p.col + 1) * glass.cell[0] <= w, `${name} col`)
    assert.ok(p.x0 >= 0 && p.x0 < p.x1 && p.x1 <= glass.cell[0], `${name} x range`)
    assert.ok(p.h > 0 && p.h <= glass.cell[1], `${name} h`)
  }
})

test('every effect rect lies inside the effects picture, which holds the 24 new w_ rects', () => {
  const { w, h } = size('fx')
  for (const [name, [x, y, rw, rh]] of Object.entries(BURROW_DATA.fx.rects)) {
    assert.ok(x >= 0 && y >= 0 && x + rw <= w && y + rh <= h, name)
  }
  assert.equal(Object.keys(BURROW_DATA.fx.rects).filter((n) => n.startsWith('w_')).length, 24)
  assert.equal(h, 1046)
})

test('the squirrel has the 30 poses of the source, still no wave and no sleep, on a 288 x 480 sheet', () => {
  const names = [
    'happy', 'sit', 'sitLeft', 'front', 'think', 'knockA', 'knockB', 'crossA', 'crossB', 'startled', 'dizzyA', 'dizzyB',
    'sheepish', 'sad', 'readA', 'readB', 'teaA', 'teaB', 'stretchA', 'stretchB', 'sweepA', 'sweepB', 'pokeA', 'pokeB',
    'acornA', 'acornB', 'windup', 'gasp', 'stretchC', 'rummage',
  ]
  assert.deepEqual(Object.keys(BURROW_DATA.sprites.squirrel.poses).sort(), [...names].sort())
  assert.equal(BURROW_DATA.sprites.squirrel.poses.wave, undefined)
  assert.equal(BURROW_DATA.sprites.squirrel.poses.sleep, undefined)
  assert.deepEqual(size('squirrel'), { w: 288, h: 480 })
})

test('the poses of the eight other animals are the ones the burrow was first given', () => {
  const others: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(BURROW_DATA.sprites)) if (k !== 'squirrel') others[k] = v.poses
  assert.deepEqual(others, OTHER_POSES)
})

const OTHER_POSES = {"hedgehog":{"happy":{"row":4,"col":0,"h":36},"wink":{"row":4,"col":1,"h":36},"wave":{"row":4,"col":2,"h":35},"sit":{"row":4,"col":3,"h":33},"sitLeft":{"row":4,"col":4,"h":34},"sleep":{"row":4,"col":5,"h":24}},"otter":{"happy":{"row":4,"col":0,"h":33},"wave":{"row":4,"col":1,"h":33},"sit":{"row":4,"col":2,"h":30},"sitLeft":{"row":4,"col":3,"h":30},"sleep":{"row":4,"col":4,"h":20}},"frog":{"happy":{"row":4,"col":0,"h":30},"wave":{"row":4,"col":1,"h":30},"sit":{"row":4,"col":2,"h":29},"sitLeft":{"row":4,"col":3,"h":29},"sleep":{"row":4,"col":4,"h":22}},"fox":{"happy":{"row":4,"col":0,"h":35},"wave":{"row":4,"col":1,"h":35},"sit":{"row":4,"col":2,"h":32},"sitLeft":{"row":4,"col":3,"h":32},"sleep":{"row":4,"col":4,"h":27}},"woodpecker":{"happy":{"row":4,"col":0,"h":32},"wave":{"row":4,"col":1,"h":32},"sit":{"row":4,"col":2,"h":28},"sitLeft":{"row":4,"col":3,"h":29},"sleep":{"row":4,"col":4,"h":27}},"beetle":{"happy":{"row":4,"col":0,"h":32},"wave":{"row":4,"col":1,"h":32},"sit":{"row":4,"col":2,"h":28},"sitLeft":{"row":4,"col":3,"h":28},"sleep":{"row":4,"col":4,"h":23}},"hare":{"happy":{"row":4,"col":0,"h":38},"wave":{"row":4,"col":1,"h":38},"sit":{"row":4,"col":2,"h":39},"sitLeft":{"row":4,"col":3,"h":39},"sleep":{"row":4,"col":4,"h":29}},"raccoon":{"happy":{"row":4,"col":0,"h":33},"wave":{"row":4,"col":1,"h":33},"sit":{"row":4,"col":2,"h":31},"sitLeft":{"row":4,"col":3,"h":32},"sleep":{"row":4,"col":4,"h":22}}}
