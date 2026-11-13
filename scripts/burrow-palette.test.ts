// The burrow's paper and ink come from the theme tokens (--lens-burrow-*), not from literals in the view and the renderer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_THEME, THEME_IDS, extraVars, themesCss } from '../web/lib/theme-tokens'
import { overlayColors, readBurrowPalette } from '../web/lib/burrow/burrow-palette'

const NAMES = ['bubble', 'ink', 'shadow', 'letter-return', 'letter-message', 'seal']
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

test('every theme defines every --lens-burrow-* variable, the same in all but High contrast', () => {
  for (const id of THEME_IDS) {
    const v = extraVars(id)
    for (const n of NAMES) assert.ok(v[`--lens-burrow-${n}`], `${id} ${n}`)
    if (id !== 'contrast') assert.equal(v['--lens-burrow-bubble'], extraVars(DEFAULT_THEME)['--lens-burrow-bubble'], id)
  }
  assert.equal(extraVars('contrast')['--lens-burrow-bubble'], '#ffffff')
  assert.equal(extraVars('contrast')['--lens-burrow-ink'], '#000000')
  assert.match(themesCss(), /--lens-burrow-bubble: #fbefd2;/)
})

test('readBurrowPalette reads the computed values and falls back to the default theme when one is empty', () => {
  const style = { getPropertyValue: (n: string) => (n === '--lens-burrow-bubble' ? ' #ffffff ' : n === '--lens-burrow-ink' ? '#000000' : '') }
  const p = readBurrowPalette(style)
  assert.equal(p.paper, '#ffffff')
  assert.equal(p.ink, '#000000')
  assert.equal(p.seal, extraVars(DEFAULT_THEME)['--lens-burrow-seal'])
  assert.equal(p.letterReturn, extraVars(DEFAULT_THEME)['--lens-burrow-letter-return'])
})

test('overlayColors uses the theme variables, and the system colours under forced colours', () => {
  assert.deepEqual(overlayColors(false), { paper: 'var(--lens-burrow-bubble)', ink: 'var(--lens-burrow-ink)', shadow: 'var(--lens-burrow-shadow)' })
  assert.deepEqual(overlayColors(true), { paper: 'Canvas', ink: 'CanvasText', shadow: 'transparent' })
})

test('the view and the renderer hold no colour literal of the paper and ink', () => {
  for (const f of ['web/components/agent-visualizer/burrow-view.tsx', 'web/lib/burrow/burrow-render.ts']) {
    const src = read(f)
    for (const lit of ['#fbefd2', '#3b2013', '#d6ecbf', '#cfe1f4', '#b8322a']) assert.ok(!src.includes(lit), `${f} ${lit}`)
  }
})
