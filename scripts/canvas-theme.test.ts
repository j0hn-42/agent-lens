import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLORS, refreshColors } from '../web/lib/colors'
import { PERF_OVERLAY, STATE_COLOR_OVERRIDES, ORCHESTRATOR_DRAW, FRESHNESS_DRAW } from '../web/lib/canvas-constants'
import { THEME_IDS } from '../web/lib/theme-tokens'
import { sessionPalette, sessionColor } from '../web/components/agent-visualizer/canvas/cluster-model'
import { teamDefaultColor, legibleOnVoid, teammateAccent, teamColorFor } from '../web/components/agent-visualizer/canvas/team-style'

type Rgb = [number, number, number]

function parse(value: string): [number, number, number, number] {
  if (value.startsWith('#')) {
    const n = (i: number) => parseInt(value.slice(i, i + 2), 16)
    return [n(1), n(3), n(5), 1]
  }
  const m = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  assert.ok(m, `unparsable colour ${value}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
}

function over(fg: string, bg: Rgb): Rgb {
  const [r, g, b, a] = parse(fg)
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
}

function lum([r, g, b]: Rgb): number {
  const l = [r, g, b].map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const rgb = (hex: string): Rgb => { const [r, g, b] = parse(hex); return [r, g, b] }

// The identity colours of teammates (extension/src/teammate.ts) and of the guided tour
const IDENTITY_COLORS = ['#3b82f6', '#f97316', '#22c55e', '#a855f7', '#eab308', '#ef4444', '#ec4899', '#06b6d4', '#4cc9f0', '#f9c74f']

test('neon: the canvas colours are exactly the literals the canvas always used', () => {
  refreshColors('neon')
  assert.equal(PERF_OVERLAY.bgColor, 'rgba(0, 0, 0, 0.75)')
  assert.equal(PERF_OVERLAY.fpsGoodColor, '#44ff44')
  assert.equal(PERF_OVERLAY.fpsCautionColor, '#ffaa00')
  assert.equal(PERF_OVERLAY.fpsWarningColor, '#ff4444')
  assert.equal(PERF_OVERLAY.textColor, '#cccccc')
  assert.equal(STATE_COLOR_OVERRIDES.thinking, '#b79cff')
  assert.equal(STATE_COLOR_OVERRIDES.waiting_permission, '#ff7ad9')
  assert.equal(ORCHESTRATOR_DRAW.accent, '#ffd166')
  assert.equal(ORCHESTRATOR_DRAW.textColor, '#11161c')
  assert.equal(FRESHNESS_DRAW.staleColor, '#8a94a0')
  assert.equal(FRESHNESS_DRAW.staleTextColor, '#c5ced8')
  assert.equal(teamDefaultColor(), '#b794f6')
  assert.equal(COLORS.depthShadow, 'rgba(0, 0, 0, 0.5)')
  assert.deepEqual([...sessionPalette()], ['#66ccff', '#7ee0a8', '#ffcc66', '#ff9ec7', '#b79cff', '#9ad0ff', '#ffa978', '#8de3de'])
})

test('the canvas constants follow the theme when it changes', () => {
  refreshColors('neon')
  const neon = FRESHNESS_DRAW.staleTextColor
  refreshColors('paper')
  assert.notEqual(FRESHNESS_DRAW.staleTextColor, neon)
  assert.equal(FRESHNESS_DRAW.staleTextColor, COLORS.inkMuted)
  refreshColors('neon')
})

for (const id of THEME_IDS) {
  test(`${id}: canvas colours are #rrggbb where an alpha suffix is appended, and contrast holds`, () => {
    refreshColors(id)
    const ground = rgb(COLORS.void)
    const hexOnly = [COLORS.fpsGood, COLORS.fpsCaution, COLORS.fpsWarning, COLORS.perfText, COLORS.crownFill, COLORS.crownText,
      COLORS.staleNode, COLORS.staleText, COLORS.teamDefault, COLORS.stateThinking, COLORS.stateWaitingPermission, ...sessionPalette()]
    for (const c of hexOnly) assert.match(c, /^#[0-9a-f]{6}$/, `${id}: ${c}`)

    // Text: >= 4.5:1
    const perfBg = over(COLORS.perfBg, ground)
    for (const c of [COLORS.fpsGood, COLORS.fpsCaution, COLORS.fpsWarning, COLORS.perfText]) {
      if (id === 'neon') continue // pinned literals, covered by the legacy-values test
      assert.ok(ratio(rgb(c), perfBg) >= 4.5, `${id}: perf overlay text ${c} on the overlay`)
    }
    assert.ok(ratio(rgb(COLORS.staleText), ground) >= 4.5, `${id}: stale label on void`)
    assert.ok(ratio(rgb(COLORS.crownText), rgb(COLORS.crownFill)) >= 4.5, `${id}: crown text on its fill`)
    if (id !== 'neon') assert.equal(COLORS.crownText, COLORS.onAccent, `${id}: text on accent is on-accent`)

    // Components: >= 3:1 against the void
    for (const c of [COLORS.staleNode, COLORS.teamDefault, COLORS.stateThinking, COLORS.stateWaitingPermission, COLORS.crownFill, ...sessionPalette()]) {
      assert.ok(ratio(rgb(c), ground) >= 3, `${id}: ${c} on void`)
    }
  })

  test(`${id}: states stay distinguishable and session halos are distinct`, () => {
    refreshColors(id)
    assert.notEqual(COLORS.stateThinking, COLORS.idle)
    assert.notEqual(COLORS.stateWaitingPermission, COLORS.tool_calling)
    assert.notEqual(COLORS.stateThinking, COLORS.stateWaitingPermission)
    assert.equal(new Set(sessionPalette()).size, 8)
    assert.ok(sessionPalette().includes(sessionColor('any-session')))
  })

  test(`${id}: identity colours are legible (>= 3:1) on the void, unchanged on dark grounds`, () => {
    refreshColors(id)
    const ground = rgb(COLORS.void)
    for (const c of IDENTITY_COLORS) {
      const out = legibleOnVoid(c)
      assert.match(out, /^#[0-9a-f]{6}$/)
      if (id === 'paper') assert.ok(ratio(rgb(out), ground) >= 3, `paper: ${c} -> ${out}`)
      else assert.equal(out, c, `${id} keeps the colour of the data`)
      assert.equal(teammateAccent({ teamColor: c }), out)
      assert.equal(teamColorFor('t', [{ teamColor: c }]), out)
    }
  })
}

test('paper: a colour that is already legible is left alone', () => {
  refreshColors('paper')
  assert.equal(legibleOnVoid('#6b3fb0'), '#6b3fb0')
  assert.equal(legibleOnVoid('not-a-colour'), 'not-a-colour')
  refreshColors('neon')
})
