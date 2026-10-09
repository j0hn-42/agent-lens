// Le thème ne s'applique qu'à l'interface : la scène (fond de page + canvas) garde les couleurs neon dans les trois thèmes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { COLORS, SCENE, refreshColors, getStateColor, getDiscoveryTypeColor, contextSegments, uiColor } from '../web/lib/colors'
import { NEON_COLORS } from '../web/lib/theme-palette'
import { PERF_OVERLAY, STATE_COLOR_OVERRIDES, ORCHESTRATOR_DRAW, FRESHNESS_DRAW } from '../web/lib/canvas-constants'
import { THEME_IDS, TOKENS } from '../web/lib/theme-tokens'
import { sessionColor, SESSION_PALETTE } from '../web/components/agent-visualizer/canvas/cluster-model'
import { TEAM_DEFAULT_COLOR, teammateAccent } from '../web/components/agent-visualizer/canvas/team-style'

const root = join(__dirname, '..')
const legacy = JSON.parse(readFileSync(join(__dirname, 'fixtures/neon-colors.legacy.json'), 'utf8')) as Record<string, string>

for (const id of THEME_IDS) {
  test(`${id}: la scène est identique à neon (valeurs d'avant les thèmes)`, () => {
    refreshColors(id)
    assert.deepEqual({ ...SCENE }, { ...NEON_COLORS })
    for (const [k, v] of Object.entries(legacy)) assert.equal((SCENE as Record<string, string>)[k], v, `SCENE.${k}`)
    assert.equal(SCENE.void, '#050510')
    assert.equal(Object.isFrozen(SCENE), true)
  })

  test(`${id}: les constantes et helpers du canvas gardent leurs valeurs neon`, () => {
    refreshColors(id)
    assert.equal(PERF_OVERLAY.bgColor, 'rgba(0, 0, 0, 0.75)')
    assert.equal(PERF_OVERLAY.fpsGoodColor, '#44ff44')
    assert.equal(STATE_COLOR_OVERRIDES.thinking, '#b79cff')
    assert.equal(STATE_COLOR_OVERRIDES.waiting_permission, '#ff7ad9')
    assert.equal(ORCHESTRATOR_DRAW.accent, '#ffd166')
    assert.equal(FRESHNESS_DRAW.staleColor, '#8a94a0')
    assert.equal(FRESHNESS_DRAW.staleTextColor, '#c5ced8')
    assert.equal(TEAM_DEFAULT_COLOR, '#b794f6')
    assert.deepEqual([...SESSION_PALETTE], ['#66ccff', '#7ee0a8', '#ffcc66', '#ff9ec7', '#b79cff', '#9ad0ff', '#ffa978', '#8de3de'])
    assert.ok(SESSION_PALETTE.includes(sessionColor('any-session')))
    assert.equal(teammateAccent({ teamColor: '#eab308' }), '#eab308', 'une couleur d\'identité n\'est jamais modifiée')
    const neonStates = ['idle', 'thinking', 'tool_calling', 'complete', 'error', 'paused', 'waiting_permission'] as const
    for (const s of neonStates) assert.equal(getStateColor(s, SCENE), (NEON_COLORS as Record<string, string>)[s])
    assert.equal(getDiscoveryTypeColor('file', SCENE), '#66ccff')
    const bd = { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 }
    assert.equal(contextSegments(bd, SCENE)[2].color, '#ffbb44')
  })
}

test('l\'interface, elle, change avec le thème (graphite et paper diffèrent de neon)', () => {
  refreshColors('neon')
  const neon = { ...COLORS }
  refreshColors('graphite')
  assert.notEqual(COLORS.void, neon.void)
  assert.notEqual(COLORS.panelBg, neon.panelBg)
  refreshColors('paper')
  assert.notEqual(COLORS.void, SCENE.void)
  assert.notEqual(COLORS.textPrimary, SCENE.textPrimary)
  assert.equal(getStateColor('complete'), COLORS.complete, 'l\'interface suit le thème par défaut')
  assert.notEqual(getStateColor('complete'), getStateColor('complete', SCENE))
  refreshColors('neon')
})

test('uiColor : une couleur d\'état stockée (timeline) devient le rôle du thème, une couleur d\'identité reste', () => {
  refreshColors('paper')
  assert.equal(uiColor(SCENE.error), COLORS.error)
  assert.equal(uiColor(SCENE.tool), COLORS.tool)
  assert.equal(uiColor('#123456'), '#123456')
  refreshColors('neon')
  assert.equal(uiColor(SCENE.error), SCENE.error)
})

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
}

test('garde : le code du canvas, de la simulation et du fond n\'utilise jamais la palette thématisée', () => {
  const files = [
    ...walk(join(root, 'web/components/agent-visualizer/canvas')),
    ...walk(join(root, 'web/hooks')),
    join(root, 'web/components/agent-visualizer/background-layer.ts'),
    join(root, 'web/lib/canvas-constants.ts'),
  ].filter(f => /\.tsx?$/.test(f))
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /\bCOLORS\b/, `${f}: COLORS (thématisé) dans le code de la scène, utiliser SCENE`)
    assert.doesNotMatch(src, /theme-dom|currentThemeId|refreshColors|themed\(/, `${f}: la scène ne dépend pas du thème`)
  }
})

test('garde : le bloom reste actif sur le canvas quel que soit le thème, le fond de page est celui de la scène', () => {
  const loop = readFileSync(join(root, 'web/hooks/use-canvas-draw-loop.ts'), 'utf8')
  assert.match(loop, /bloomRef\.current && !reducedMotion\)/)
  const css = readFileSync(join(root, 'web/app/globals.css'), 'utf8')
  assert.match(css, /--scene-void: #050510/)
  assert.match(css, /html, body \{ background: var\(--scene-void\); \}/)
})

// ─── Interface au-dessus de la scène sombre ──────────────────────────────────

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

test('le focus reste >= 3:1 sur les surfaces du thème ET sur la scène sombre, dans les trois thèmes', () => {
  const css = readFileSync(join(root, 'web/app/globals.css'), 'utf8')
  const halo = /:where\(html\[data-theme="paper"\]\) :where\(:focus-visible\) \{\s*box-shadow: 0 0 0 6px (#[0-9a-f]{6});/.exec(css)
  assert.ok(halo, 'paper: halo clair autour de l\'anneau de focus')
  for (const id of THEME_IDS) {
    const t = TOKENS[id]
    assert.ok(ratio(t.focus, t.surface) >= 3, `${id}: focus sur surface`)
    if (id === 'paper') {
      assert.ok(ratio(t.focus, halo![1]) >= 3, 'paper: anneau sur halo')
      assert.ok(ratio(halo![1], SCENE.void) >= 3, 'paper: halo sur la scène')
    } else {
      assert.ok(ratio(t.focus, SCENE.void) >= 3, `${id}: focus sur la scène`)
    }
  }
})

test('le texte posé directement sur le fond de la scène (état vide) utilise les couleurs de la scène, >= 4,5:1', () => {
  const src = readFileSync(join(root, 'web/components/agent-visualizer/index.tsx'), 'utf8')
  const empty = src.slice(src.indexOf('Empty state when no demo'), src.indexOf('Canvas fills everything'))
  assert.doesNotMatch(empty, /\bCOLORS\./, 'état vide : SCENE uniquement')
  for (const k of ['textPrimary', 'textMuted'] as const) assert.ok(ratio('#' + SCENE[k].slice(1, 7), SCENE.void) >= 4.5, k)
  const top = readFileSync(join(root, 'web/components/agent-visualizer/top-bar.tsx'), 'utf8')
  assert.match(top, /var\(--lens-bar-bg\)/, 'la barre d\'outils porte sa propre surface')
})
