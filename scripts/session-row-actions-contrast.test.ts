// #377 (WCAG 1.4.11) : les actions de ligne du panneau Sessions (✎ ⤓ ✕) sont des composants d'interface identifiés par
// leur seul glyphe. Au repos (sans survol ni focus), leur opacité s'applique à la couleur du glyphe : le contraste
// effectif sur le fond du panneau doit rester ≥ 3:1 dans tous les thèmes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_IDS } from '../web/lib/theme-tokens'
import { paletteFor } from '../web/lib/theme-palette'

type Rgba = [number, number, number, number]
const parse = (c: string): Rgba => {
  if (c.startsWith('#')) {
    const h = c.slice(1)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
    return [r, g, b, a]
  }
  const m = (c.match(/[\d.]+/g) ?? []).map(Number)
  return [m[0], m[1], m[2], m[3] ?? 1]
}
const over = (fg: Rgba, bg: Rgba, alpha: number): Rgba =>
  [0, 1, 2].map(i => fg[i] * alpha + bg[i] * (1 - alpha)).concat(1) as Rgba
const lum = (c: Rgba) => {
  const [r, g, b] = c.slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const source = readFileSync(join(__dirname, '..', 'web/components/agent-visualizer/session-list-panel.tsx'), 'utf8')

/** Each row action: its accessible-name marker, the glyph, and the resting opacity + colour key read from the source */
function rowAction(glyph: string): { opacity: number; colorKey: 'textMuted' | 'tabClose' } {
  const end = source.indexOf(`<span aria-hidden="true">${glyph}</span>`)
  assert.ok(end > 0, `glyph ${glyph} not found in session-list-panel.tsx`)
  const start = source.lastIndexOf('<button', end)
  const button = source.slice(start, end)
  const cls = button.match(/className=\{`([^`]*)`\}/)?.[1] ?? ''
  // The first opacity utility without a state variant is the resting one
  const resting = cls.split(/\s+/).find(c => /^opacity-\d+$/.test(c))
  const opacity = resting ? Number(resting.slice('opacity-'.length)) / 100 : 1
  const colorKey = button.match(/color: COLORS\.(\w+)/)?.[1]
  assert.ok(colorKey === 'textMuted' || colorKey === 'tabClose', `${glyph}: unexpected colour ${colorKey}`)
  return { opacity, colorKey }
}

for (const glyph of ['✎', '⤓', '✕']) {
  test(`session row action ${glyph}: resting glyph keeps 3:1 against the panel in every theme`, () => {
    const { opacity, colorKey } = rowAction(glyph)
    for (const id of THEME_IDS) {
      const p = paletteFor(id)
      const bg = parse(p.void)
      const fg = parse(p[colorKey])
      const ratio = contrast(over(fg, bg, fg[3] * opacity), bg)
      assert.ok(ratio >= 3, `${id}: ${glyph} (${colorKey} at opacity ${opacity}) is ${ratio.toFixed(2)}:1 on ${p.void}`)
    }
  })
}
