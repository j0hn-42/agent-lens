// Zone « timeline, légende, statistiques » : plus de couleur en dur, neon inchangé, contrastes des trois thèmes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { paletteFor } from '../web/lib/theme-palette'
import { THEME_IDS, TOKENS } from '../web/lib/theme-tokens'

type Rgb = [number, number, number]
const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb
function lum([r, g, b]: Rgb): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a: Rgb, b: Rgb) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

const ZONE_FILES = [
  'timeline-panel', 'graph-legend', 'active-time-stat', 'graph-a11y-list', 'chrome-announcer', 'freshness-announcer',
].map(n => `web/components/agent-visualizer/${n}.tsx`)

test('zone 4 : aucun littéral de couleur dans les fichiers de la zone', () => {
  for (const f of ZONE_FILES) {
    const src = readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('//'))
    for (const line of src) {
      assert.doesNotMatch(line, /#[0-9a-fA-F]{6}\b|outline-white|rgba?\(/, `${f}: ${line.trim()}`)
    }
  }
})

test('neon : couleurs de la timeline et de la légende identiques à l’existant', () => {
  const p = paletteFor('neon')
  assert.equal(p.swimlaneDispatch, '#7fb2ff')
  assert.equal(p.swimlaneReturn, '#7fe3a3')
  assert.equal(p.swimlaneError, '#ff8f8f')
  assert.equal(p.swimlaneMessage, '#e0b0ff')
  assert.equal(p.textMutedOpaque, '#8fcfef')
  assert.equal(p.crownAccent, '#ffd166')
})

for (const id of THEME_IDS) {
  test(`${id} : flèches et texte de la timeline lisibles sur le fond`, () => {
    const p = paletteFor(id)
    const ground = rgb(TOKENS[id].void)
    assert.ok(ratio(rgb(p.textMutedOpaque), ground) >= 4.5, 'texte atténué >= 4.5:1')
    for (const k of ['swimlaneDispatch', 'swimlaneReturn', 'swimlaneError', 'swimlaneMessage', 'crownAccent'] as const) {
      assert.ok(ratio(rgb(p[k]), ground) >= 3, `${k} >= 3:1`)
    }
  })
}
