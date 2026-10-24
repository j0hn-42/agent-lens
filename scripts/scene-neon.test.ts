// #381: the scene follows the theme, and Neon keeps the look it has always had. The paint of a fixed scene (every text, line
// and shape of the labels, links, halos, cards and grid, with its colour and alpha) is pinned in fixtures/scene-neon.paint.json,
// recorded before the scene read the theme. A draw call without a theme (a test, an old caller) paints the same as before too.
import './canvas-recorder'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAMILIES, paintOf } from './scene-fixture'

const pinned = JSON.parse(readFileSync(join(__dirname, 'fixtures/scene-neon.paint.json'), 'utf8')) as Record<'neon' | 'no theme', Record<string, string[]>>

for (const family of FAMILIES) {
  test(`neon: the ${family} of the scene paint exactly what they painted before the scene followed the theme`, () => {
    assert.ok(pinned.neon[family].length > 0, `${family}: the fixture draws something`)
    assert.deepEqual(paintOf(family, 'neon'), pinned.neon[family])
  })

  test(`no theme given: the ${family} paint what they painted before (the neon scene)`, () => {
    assert.deepEqual(paintOf(family), pinned['no theme'][family])
  })
}
