// #381: every theme gives each agent state its own colour. Thinking is not idle, waiting for permission is not a tool call,
// in the panels (COLORS) as on the canvas (the same state colours, passed the theme), and each state colour stays readable as text.
import './canvas-recorder'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paletteFor, NEON_COLORS } from '../web/lib/theme-palette'
import { THEME_IDS, TOKENS, DEFAULT_THEME } from '../web/lib/theme-tokens'
import { COLORS, SCENE, refreshColors, getStateColor, uiColor } from '../web/lib/colors'
import { stateColor } from '../web/components/agent-visualizer/canvas/draw-misc'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { STATE_LABEL_SHORT } from '../web/lib/canvas-constants'
import { recordingContext, stubDocument } from './canvas-recorder'

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
  assert.equal(p.thinking, stateColor('thinking', 'neon'))
  assert.equal(p.waiting_permission, stateColor('waiting_permission', 'neon'))
})

test('the canvas paints each agent state with the theme colour of that state, the one the panels use (#381)', () => {
  for (const id of THEME_IDS) {
    const p = paletteFor(id)
    for (const s of STATES) {
      assert.equal(stateColor(s, id), p[s], `${id} ${s}`)
      assert.match(stateColor(s, id), /^#[0-9a-f]{6}$/i, `${id} ${s}: #rrggbb (the canvas appends an alpha to it)`)
    }
  }
  assert.equal(stateColor('thinking', 'neon'), '#b79cff', 'Neon keeps its violet')
  assert.equal(stateColor('waiting_permission', 'neon'), '#ff7ad9', 'Neon keeps its pink')
  assert.equal(stateColor('idle', 'neon'), SCENE.idle)
  const src = readFileSync(join(__dirname, '../web/lib/canvas-constants.ts'), 'utf8')
  assert.doesNotMatch(src, /#b79cff|#ff7ad9/i, 'no second copy of the canvas state colours')
})

test('every canvas state colour is readable on the scene background: >= 4.5:1 in every theme, >= 7:1 in High contrast', () => {
  for (const id of THEME_IDS) {
    const min = id === 'contrast' ? 7 : 4.5
    for (const s of STATES) {
      const r = ratio(stateColor(s, id), SCENE.void)
      assert.ok(r >= min, `${id} ${s} ${stateColor(s, id)} on ${SCENE.void}: ${r.toFixed(2)}:1 < ${min}:1`)
    }
  }
})

stubDocument()
/* eslint-disable @typescript-eslint/no-explicit-any */
function drawnColours(state: string, theme?: string): Set<string> {
  const rec = recordingContext(1)
  const seen = new Set<string>()
  const ctx = new Proxy(rec.ctx as any, {
    set(t, prop, value) { if (prop === 'strokeStyle' || prop === 'fillStyle' || prop === 'shadowColor') seen.add(String(value)); t[prop] = value; return true },
  })
  const agent: any = {
    id: 's1:worker', agentKey: 's1:worker', sessionId: 's1', localId: 's1:worker', displayName: 'worker', name: 'worker',
    state, parentId: 's1:main', parentKey: 's1:main', tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 300, y: 300, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: Date.now(),
  }
  drawAgents(ctx, new Map([[agent.id, agent]]), null, null, false, 0, { reducedMotion: true, zoom: 1, showCost: false, showStats: false, ...(theme ? { theme } : {}) } as any)
  return seen
}

test('drawAgents strokes the state ring with the colour of the theme it is given', () => {
  for (const id of THEME_IDS) {
    for (const s of ['thinking', 'waiting_permission', 'idle', 'error'] as const) {
      const seen = drawnColours(s, id)
      assert.ok(seen.has(paletteFor(id)[s]), `${id} ${s}: ${paletteFor(id)[s]} drawn`)
    }
  }
  // No theme given (a test, an old caller): the default theme, the one COLORS starts on
  assert.ok(drawnColours('thinking').has(paletteFor(DEFAULT_THEME).thinking))
})

test('a colour never carries a canvas state alone: each state has a word drawn under the agent name', () => {
  for (const s of STATES) assert.ok(STATE_LABEL_SHORT[s], s)
  const draw = readFileSync(join(__dirname, '../web/components/agent-visualizer/canvas/draw-agents.ts'), 'utf8')
  assert.match(draw, /agent\.state === 'complete' \|\| agent\.archived\) \{\s*ctx\.setLineDash/, 'complete: dashed outline')
  assert.match(draw, /\} else if \(isWaiting\) \{\s*ctx\.setLineDash/, 'waiting: dashed ring')
})

test('the graph legend draws the canvas state colours of the active theme (same swatch as the node)', () => {
  const src = readFileSync(join(__dirname, '../web/components/agent-visualizer/graph-legend.tsx'), 'utf8')
  assert.match(src, /const \[theme\] = useTheme\(\)/, 'the legend re-renders on a theme switch')
  assert.match(src, /<Swatch color=\{stateColor\(state, theme\)\} \/>/)
  assert.match(src, /stroke=\{stateColor\('complete', theme\)\}/, 'the dashed outline of a finished agent')
  assert.doesNotMatch(src, /stateColor\(\w+\)/, 'no state colour without its theme')
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
  const tl = readFileSync(join(__dirname, '../web/components/agent-visualizer/timeline-panel.tsx'), 'utf8')
  assert.doesNotMatch(tl, /uiColor\(block\.color\)/, 'timeline blocks pass their state to uiColor')
  assert.match(tl, /uiColor\(block\.color, state\)/)
})

test('session list: a paused agent is not drawn with the idle colour (paused is its own state)', () => {
  for (const id of THEME_IDS) assert.notEqual(paletteFor(id).paused, paletteFor(id).idle, id)
  const src = readFileSync(join(__dirname, '../web/components/agent-visualizer/session-list-panel.tsx'), 'utf8')
  const marker = src.slice(src.indexOf('function StateMarker'), src.indexOf('function SessionMarker'))
  assert.match(marker, /state === 'paused' \? COLORS\.paused/, 'StateMarker paints paused with COLORS.paused')
})

// The canvas, the graph legend, the session list and the timeline legend draw the same state colours (#381): a panel state
// colour must not look like another state on the canvas, in any theme. Catppuccin Frappe is the one exception, kept as a
// todo: its official green (done) and yellow (tool call) are 0.089 apart, just under the threshold, on every surface (the
// panels share it); the role values are the official ones, unmodified (docs/reading-the-ui.md), and the word tells them apart.
const CROSS_SURFACE_KNOWN: ReadonlyMap<string, ReadonlyArray<readonly [string, string]>> = new Map([
  ['catppuccin-frappe', [['complete', 'tool_calling'], ['tool_calling', 'complete']]],
])
for (const id of THEME_IDS) {
  const known = CROSS_SURFACE_KNOWN.get(id) ?? []
  const isKnown = (x: string, y: string) => known.some(([a, b]) => a === x && b === y)
  const name = `${id}: no panel state colour looks like another state on the canvas (deltaE >= ${MIN_DELTA_E})`
  if (known.length) test.todo(`${name}: ${known.map(([a, b]) => `${a}/${b}`).join(', ')} below the threshold`)
  test(known.length ? `${name}, except the known pairs` : name, () => {
    const p = paletteFor(id)
    for (const x of STATES) {
      for (const y of STATES) {
        if (x === y || isKnown(x, y)) continue
        const d = deltaE(p[x], stateColor(y, id))
        assert.ok(d >= MIN_DELTA_E, `panel ${x} ${p[x]} vs canvas ${y} ${stateColor(y, id)}: deltaE ${d.toFixed(3)} < ${MIN_DELTA_E}`)
      }
    }
    for (const [x, y] of known) assert.ok(deltaE(p[x], stateColor(y, id)) >= 0.085, `${id} ${x}/${y}: known pair, must not get closer`)
  })
}

test('warnings that are not a permission wait (incomplete rollup, loop health) do not borrow the waiting colour', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../web/components/agent-visualizer', f), 'utf8')
  const sessions = read('session-list-panel.tsx')
  assert.doesNotMatch(sessions, /total\.known > 0 \? COLORS\.textMuted : COLORS\.waiting_permission/, 'rollup (incomplete)')
  assert.doesNotMatch(sessions, /data-testid="session-health" style=\{\{ color: COLORS\.waiting_permission/, 'session health')
  assert.doesNotMatch(read('agent-detail-card.tsx'), /loop \? COLORS\.waiting_permission/, 'inspector loop verdict')
})
