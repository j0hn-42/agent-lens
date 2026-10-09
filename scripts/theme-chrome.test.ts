// Zone « barre d'outils, menus, dialogues et shells » : aucune couleur en dur, les variables de chrome existent dans les trois thèmes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_IDS, TOKENS, extraVars } from '../web/lib/theme-tokens'

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const CHROME_FILES = [
  'web/components/agent-visualizer/shared-ui.tsx',
  'web/components/agent-visualizer/control-bar.tsx',
  'web/components/agent-visualizer/canvas-controls.tsx',
  'web/components/agent-visualizer/glass-context-menu.tsx',
  'web/components/agent-visualizer/shortcuts-dialog.tsx',
  'web/lib/chrome-utils.ts',
]

test('les fichiers de chrome n\'ont plus de couleur en dur (hex, rgba, white, black)', () => {
  for (const f of CHROME_FILES) {
    const code = read(f).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b(?![\w-])(?<!\w#\d{2,3}\))/, `${f}: hex`)
    assert.doesNotMatch(code, /rgba?\(/, `${f}: rgba`)
    assert.doesNotMatch(code, /(?:bg|outline|text|border)-(?:white|black)\b/, `${f}: couleur nommée Tailwind`)
  }
})

test('neon garde les lavis d\'avant, graphite et paper sont plats', () => {
  const neon = extraVars('neon')
  assert.equal(neon['--lens-hover'], 'rgba(255, 255, 255, 0.1)')
  assert.equal(neon['--lens-hover-subtle'], 'rgba(255, 255, 255, 0.05)')
  assert.equal(neon['--lens-grip'], 'rgba(255, 255, 255, 0.3)')
  assert.equal(neon['--lens-grip-hover'], 'rgba(255, 255, 255, 0.6)')
  assert.equal(neon['--lens-scrim'], 'rgba(0, 0, 0, 0.5)')
  assert.match(neon['--lens-live-halo'], /255, 68, 68, 0\.3/)
  for (const id of ['graphite', 'paper'] as const) {
    assert.equal(extraVars(id)['--lens-live-halo'], 'none')
    assert.equal(extraVars(id)['--lens-hover'], TOKENS[id]['surface-raised'])
  }
})

test('le texte du chrome reste lisible au survol dans graphite et paper', () => {
  for (const id of ['graphite', 'paper'] as const) {
    const t = TOKENS[id]
    assert.ok(contrast(t.ink, t['surface-raised']) >= 4.5, `${id}: ink sur survol`)
    assert.ok(contrast(t['control-border'], t.surface) >= 3, `${id}: poignée de redimensionnement`)
  }
})

test('le shell de développement garde le fond de la scène (la page ne suit pas le thème)', () => {
  const c = read('extension/src/constants.ts')
  assert.match(c, /WEBVIEW_BG_COLOR = '#050510'/)
  assert.ok(THEME_IDS.includes('graphite'))
})
