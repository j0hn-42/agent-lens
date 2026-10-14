// #381: every theme gives each agent state its own colour. Thinking is not idle, waiting for permission is not a tool call,
// in the panels (COLORS) as on the canvas (SCENE + its state colours), and each state colour stays readable as text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paletteFor, NEON_COLORS } from '../web/lib/theme-palette'
import { THEME_IDS, TOKENS } from '../web/lib/theme-tokens'
import { COLORS, SCENE, refreshColors, getStateColor, uiColor } from '../web/lib/colors'
import { stateColor } from '../web/components/agent-visualizer/canvas/draw-misc'

type Rgb = [number, number, number]
const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb

function lum([r, g, b]: Rgb): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

/** OKLab (Ottosson 2020): a perceptual space where a euclidean distance of ~0.02 is a just noticeable difference. */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
const deltaE = (a: string, b: string) => { const p = oklab(a), q = oklab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }

/** Minimum OKLab distance between thinking / waiting_permission and every other agent state (about 4.5 just noticeable differences). */
const MIN_DELTA_E = 0.09
const STATES = ['idle', 'thinking', 'tool_calling', 'waiting_permission', 'complete', 'error', 'paused'] as const
const NEW_ROLES = ['thinking', 'waiting_permission'] as const

test('the tokens carry a thinking role and a waiting-for-permission role in every theme', () => {
  for (const id of THEME_IDS) {
    assert.match(TOKENS[id]['state-thinking'], /^#[0-9a-f]{6}$/i, id)
    assert.match(TOKENS[id]['state-waiting'], /^#[0-9a-f]{6}$/i, id)
  }
  assert.equal(TOKENS.neon['state-thinking'], NEON_COLORS.stateThinking, 'neon tokens = the canvas thinking colour')
  assert.equal(TOKENS.neon['state-waiting'], NEON_COLORS.stateWaitingPermission, 'neon tokens = the canvas waiting colour')
})

for (const id of THEME_IDS) {
  test(`${id}: thinking and waiting for permission are their own colours, distinct from every other state`, () => {
    const p = paletteFor(id)
    assert.equal(p.thinking, TOKENS[id]['state-thinking'])
    assert.equal(p.waiting_permission, TOKENS[id]['state-waiting'])
    assert.equal(p.stateThinking, p.thinking)
    assert.equal(p.stateWaitingPermission, p.waiting_permission)
    for (const a of NEW_ROLES) {
      for (const b of STATES) {
        if (a === b) continue
        const d = deltaE(p[a], p[b])
        assert.ok(d >= MIN_DELTA_E, `${a} ${p[a]} vs ${b} ${p[b]}: deltaE ${d.toFixed(3)} < ${MIN_DELTA_E}`)
      }
    }
  })

  test(`${id}: thinking and waiting colours are readable as text (>= 4.5:1) on void, surface and surface-raised`, () => {
    const p = paletteFor(id)
    const t = TOKENS[id]
    for (const key of NEW_ROLES) {
      for (const ground of ['void', 'surface', 'surface-raised'] as const) {
        const r = ratio(p[key], t[ground])
        assert.ok(r >= 4.5, `${key} ${p[key]} on ${ground}: ${r.toFixed(2)}:1`)
      }
    }
  })
}

test('High contrast: the new state colours reach 7:1 on its black grounds, like its text', () => {
  const t = TOKENS.contrast
  for (const key of ['state-thinking', 'state-waiting'] as const) {
    for (const ground of ['void', 'surface', 'surface-raised'] as const) assert.ok(ratio(t[key], t[ground]) >= 7, `${key} on ${ground}`)
  }
})

test('neon interface paints thinking and waiting with the canvas colours (one state, one colour on both surfaces)', () => {
  const p = paletteFor('neon')
  assert.equal(p.thinking, stateColor('thinking'))
  assert.equal(p.waiting_permission, stateColor('waiting_permission'))
})

test('the canvas keeps its neon state colours, now read from the scene palette instead of literals', () => {
  for (const id of THEME_IDS) {
    refreshColors(id)
    assert.equal(stateColor('thinking'), '#b79cff', id)
    assert.equal(stateColor('waiting_permission'), '#ff7ad9', id)
    assert.equal(stateColor('idle'), SCENE.idle, id)
    assert.equal(stateColor('tool_calling'), SCENE.tool_calling, id)
  }
  refreshColors('neon')
  const src = readFileSync(join(__dirname, '../web/lib/canvas-constants.ts'), 'utf8')
  assert.doesNotMatch(src, /#b79cff|#ff7ad9/i, 'no second copy of the canvas state colours')
})

test('timeline blocks stored with a scene colour paint the theme colour of their state (thinking is not idle)', () => {
  for (const id of THEME_IDS) {
    refreshColors(id)
    assert.equal(uiColor(SCENE.thinking, 'thinking'), COLORS.thinking, id)
    assert.equal(uiColor(SCENE.idle, 'idle'), COLORS.idle, id)
    assert.equal(uiColor(SCENE.waiting_permission, 'waiting_permission'), COLORS.waiting_permission, id)
    assert.equal(uiColor(SCENE.tool, 'tool_call'), COLORS.tool, id)
    assert.equal(uiColor(SCENE.error, 'error'), COLORS.error, id)
    assert.equal(getStateColor('thinking'), COLORS.thinking, id)
  }
  refreshColors('neon')
})

test('warnings that are not a permission wait (incomplete rollup, loop health) do not borrow the waiting colour', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../web/components/agent-visualizer', f), 'utf8')
  const sessions = read('session-list-panel.tsx')
  assert.doesNotMatch(sessions, /total\.known > 0 \? COLORS\.textMuted : COLORS\.waiting_permission/, 'rollup (incomplete)')
  assert.doesNotMatch(sessions, /data-testid="session-health" style=\{\{ color: COLORS\.waiting_permission/, 'session health')
  assert.doesNotMatch(read('agent-detail-card.tsx'), /loop \? COLORS\.waiting_permission/, 'inspector loop verdict')
})
