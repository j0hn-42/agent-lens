// Le thème s'applique à l'interface et aux seules couleurs d'état des agents sur le canvas (#381) : le reste de la scène
// (fond de page, liens, halos, particules, cartes, libellés, grille) lit SCENE, figé en neon dans tous les thèmes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { COLORS, SCENE, refreshColors, getStateColor, getDiscoveryTypeColor, contextSegments, uiColor } from '../web/lib/colors'
import { NEON_COLORS, paletteFor } from '../web/lib/theme-palette'
import * as canvasConstants from '../web/lib/canvas-constants'
import { PERF_OVERLAY, ORCHESTRATOR_DRAW, FRESHNESS_DRAW } from '../web/lib/canvas-constants'
import { stateColor } from '../web/components/agent-visualizer/canvas/draw-misc'
import { THEME_IDS, TOKENS, extraVars } from '../web/lib/theme-tokens'
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
    assert.equal('STATE_COLOR_OVERRIDES' in canvasConstants, false, 'plus de couleurs d\'état figées en neon pour le canvas')
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

test('contrat (#381) : les couleurs d\'état du canvas suivent le thème passé explicitement, le reste de la scène reste neon', () => {
  const states = ['idle', 'thinking', 'tool_calling', 'complete', 'error', 'paused', 'waiting_permission'] as const
  for (const id of THEME_IDS) {
    refreshColors(id === 'neon' ? 'graphite' : 'neon') // le thème des panneaux n'entre pas en compte : seul le thème passé compte
    for (const s of states) assert.equal(stateColor(s, id), (paletteFor(id) as Record<string, string>)[s], `${id} ${s}`)
    assert.deepEqual({ ...SCENE }, { ...NEON_COLORS }, `${id}: SCENE reste neon`)
  }
  refreshColors('neon')
  assert.equal(stateColor('thinking', 'neon'), '#b79cff', 'Neon garde son violet')
  assert.equal(stateColor('waiting_permission', 'neon'), '#ff7ad9', 'Neon garde son rose')
})

test('l\'interface, elle, change avec le thème (graphite et les autres thèmes diffèrent de neon)', () => {
  refreshColors('neon')
  const neon = { ...COLORS }
  refreshColors('graphite')
  assert.notEqual(COLORS.void, neon.void)
  assert.notEqual(COLORS.panelBg, neon.panelBg)
  for (const id of THEME_IDS.filter(t => t !== 'neon' && t !== 'graphite')) {
    refreshColors(id)
    assert.notEqual(COLORS.void, SCENE.void, id)
    assert.notEqual(COLORS.panelBg, neon.panelBg, id)
  }
  refreshColors('contrast')
  assert.notEqual(COLORS.void, SCENE.void)
  assert.notEqual(COLORS.textPrimary, SCENE.textPrimary)
  assert.equal(getStateColor('complete'), COLORS.complete, 'l\'interface suit le thème par défaut')
  assert.notEqual(getStateColor('complete'), getStateColor('complete', SCENE))
  refreshColors('neon')
})

test('uiColor : une couleur d\'état stockée (timeline) devient le rôle du thème, une couleur d\'identité reste', () => {
  refreshColors('midnight')
  assert.equal(uiColor(SCENE.error), COLORS.error)
  assert.equal(uiColor(SCENE.tool), COLORS.tool)
  assert.equal(uiColor('#123456'), '#123456')
  refreshColors('neon')
  assert.equal(uiColor(SCENE.error), SCENE.error)
})

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
}

test('garde : le code du canvas, de la simulation et du fond n\'utilise jamais la palette thématisée ; le thème n\'y entre que par scene-state-colors', () => {
  const files = [
    ...walk(join(root, 'web/components/agent-visualizer/canvas')),
    ...walk(join(root, 'web/hooks')),
    join(root, 'web/components/agent-visualizer/background-layer.ts'),
    join(root, 'web/lib/canvas-constants.ts'),
  ].filter(f => /\.tsx?$/.test(f))
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /\bCOLORS\b/, `${f}: COLORS (thématisé) dans le code de la scène, utiliser SCENE`)
    assert.doesNotMatch(src, /theme-dom|currentThemeId|refreshColors|themed\(|theme-palette|paletteFor/, `${f}: la scène ne lit le thème que par scene-state-colors`)
    if (f.endsWith('use-canvas-draw-loop.ts')) continue
    assert.doesNotMatch(src, /\bsceneTheme\(/, `${f}: seule la boucle de dessin lit le thème actif (une fois par image)`)
  }
  // Le seul pont entre le thème et la scène : il ne donne que les couleurs des états d'agent
  const bridge = readFileSync(join(root, 'web/lib/scene-state-colors.ts'), 'utf8')
  assert.doesNotMatch(bridge, /\bCOLORS\b|\bSCENE\b/, 'scene-state-colors ne touche ni COLORS ni SCENE')
  const exported = [...bridge.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]).sort()
  assert.deepEqual(exported, ['sceneStateColor', 'sceneStateColors', 'sceneTheme'])
  const loop = readFileSync(join(root, 'web/hooks/use-canvas-draw-loop.ts'), 'utf8')
  assert.match(loop, /opts\.theme = theme/, 'la boucle passe le thème au dessin par les options')
  assert.match(loop, /keys: \[[^\]]*sceneTheme\(\)/, 'un changement de thème redessine une scène immobile')
})

test('garde : le bloom reste actif sur le canvas quel que soit le thème, le fond de page est celui de la scène', () => {
  const loop = readFileSync(join(root, 'web/hooks/use-canvas-draw-loop.ts'), 'utf8')
  assert.match(loop, /bloomRef\.current && !calmOf\('effects'\)\)/)
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

test('le focus reste >= 3:1 sur les surfaces du thème ET sur la scène sombre, dans tous les thèmes', () => {
  const css = readFileSync(join(root, 'web/app/globals.css'), 'utf8')
  assert.doesNotMatch(css, /data-theme="paper"/, 'plus de réglage propre au thème clair')
  for (const id of THEME_IDS) {
    const t = TOKENS[id]
    for (const bg of [t.void, t.surface, t['surface-raised']]) assert.ok(ratio(t.focus, bg) >= 3, `${id}: focus sur ${bg}`)
    assert.ok(ratio(t.focus, SCENE.void) >= 3, `${id}: focus sur la scène`)
  }
})

test('les éléments d\'interface posés sur la scène restent lisibles dans tous les thèmes (barre : texte >= 4,5:1 sur sa surface, bordure >= 3:1)', () => {
  for (const id of THEME_IDS) {
    if (id === 'neon') continue // la barre y est transparente sur la scène (couleurs de la scène, vérifiées plus haut)
    const t = TOKENS[id]
    const bar = extraVars(id)['--lens-bar-bg']
    assert.equal(bar, t.surface, `${id}: la barre porte la surface du thème`)
    assert.ok(ratio(t.ink, bar) >= 4.5 && ratio(t['ink-muted'], bar) >= 4.5, `${id}: texte de la barre`)
    assert.ok(ratio(t['control-border'], bar) >= 3, `${id}: bordure des contrôles de la barre`)
    assert.ok(ratio(t.focus, bar) >= 3, `${id}: focus dans la barre`)
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

// ─── Carte de découverte (#438 : les cartes de fichier listées par Grep deviennent visibles) ───

/** [r, g, b, a] d'une couleur #rrggbb[aa] ou rgba(r, g, b, a) */
const rgba = (c: string): [number, number, number, number] => {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(c)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  const a = c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), a]
}
/** La couleur `fg`, peinte avec l'opacité globale `alpha`, composée sur le fond opaque `bg` (#rrggbb) */
const over = (fg: string, bg: string, alpha: number): string => {
  const [r, g, b, a] = rgba(fg)
  const [R, G, B] = rgba(bg)
  const k = a * alpha
  return '#' + [[r, R], [g, G], [b, B]].map(([f, d]) => Math.round(f * k + d * (1 - k)).toString(16).padStart(2, '0')).join('')
}

test('carte de découverte : libellé et chemin >= 4,5:1 à l\'opacité 0.9, sur la carte composée sur la scène, dans tous les thèmes', () => {
  const CARD_OPACITY = 0.9 // plafond du fondu (animateDiscoveries)
  for (const id of THEME_IDS) {
    refreshColors(id)
    for (const bg of [SCENE.cardBg, SCENE.cardBgSelected]) {
      const card = over(bg, SCENE.void, CARD_OPACITY)
      for (const type of ['file', 'pattern', 'finding', 'code']) {
        const label = over(getDiscoveryTypeColor(type, SCENE), card, CARD_OPACITY)
        assert.ok(ratio(label, card) >= 4.5, `${id}: libellé ${type} sur ${bg} (${ratio(label, card).toFixed(2)}:1)`)
      }
      const path = over(SCENE.textMuted, card, CARD_OPACITY)
      assert.ok(ratio(path, card) >= 4.5, `${id}: chemin (textMuted) sur ${bg} (${ratio(path, card).toFixed(2)}:1)`)
    }
  }
})

test('carte de découverte : la barre de couleur est décorative, le type est dit en texte', () => {
  const src = readFileSync(join(root, 'web/components/agent-visualizer/canvas/draw-discoveries.ts'), 'utf8')
  assert.match(src, /decorative/, 'draw-discoveries le dit à côté de la barre')
})
