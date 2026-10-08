// Theme tokens: generated CSS in sync, neon pinned to the legacy look, mirrors between web and the bootstrap script.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DARK_THEMES, DEFAULT_THEME, ROLES, THEME_IDS, TOKENS, cssVar, extraVars, shadcnVars, themesCss } from '../web/lib/theme-tokens'
import { paletteFor } from '../web/lib/theme-palette'
import { COLORS, ROLE_COLORS, refreshColors, themed } from '../web/lib/colors'
import { THEME_STORAGE_KEY as WEB_KEY, readTokens, currentThemeId } from '../web/lib/theme-dom'
import {
  THEME_IDS as BOOT_IDS, DEFAULT_THEME as BOOT_DEFAULT, THEME_STORAGE_KEY as BOOT_KEY, LIGHT_THEMES,
} from '../extension/src/theme-bootstrap'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

afterEach(() => { refreshColors(DEFAULT_THEME) })

test('web/app/themes.css is the generated file (run `pnpm run gen:themes` after editing the tokens)', () => {
  assert.equal(read('web/app/themes.css'), themesCss())
})

test('every theme defines every role and every extra variable in the CSS', () => {
  const css = read('web/app/themes.css')
  for (const id of THEME_IDS) {
    const start = css.indexOf(`[data-theme="${id}"] {`)
    assert.ok(start >= 0, `${id}: block`)
    const block = css.slice(start, css.indexOf('}', start))
    for (const role of ROLES) assert.ok(block.includes(`${cssVar(role)}: ${TOKENS[id][role]};`), `${id} ${role}`)
    for (const name of Object.keys(extraVars(id))) assert.ok(block.includes(`${name}:`), `${id} ${name}`)
    for (const name of Object.keys(shadcnVars(id))) assert.ok(block.includes(`${name}:`), `${id} ${name}`)
  }
})

test('graphite is the default theme and also applies when no data-theme is set', () => {
  assert.equal(DEFAULT_THEME, 'graphite')
  assert.match(read('web/app/themes.css'), /:root:not\(\[data-theme\]\),\n\[data-theme="graphite"\] \{/)
})

test('neon design tokens are the documented values', () => {
  assert.deepEqual({ ...TOKENS.neon }, {
    void: '#050510', surface: '#0a0f1e', 'surface-raised': '#121a30', edge: '#1c3750', 'control-border': '#386e8e',
    ink: '#aaeeff', 'ink-muted': '#7fc3e0', accent: '#66ccff', 'on-accent': '#050510', focus: '#99e0ff',
    ok: '#66ffaa', warn: '#ffbb44', danger: '#ff6666', delegate: '#cc88ff', info: '#22d3ee', 'context-system': '#7777a0',
  })
})

test('neon reproduces the legacy COLORS palette key for key (the look must not move)', () => {
  const legacy = JSON.parse(read('scripts/fixtures/neon-colors.legacy.json')) as Record<string, string>
  const neon = paletteFor('neon') as Record<string, string>
  for (const [key, value] of Object.entries(legacy)) assert.equal(neon[key], value, key)
})

test('neon CSS keeps the legacy glass, ring, input and scrollbar values', () => {
  const v = extraVars('neon')
  assert.equal(v['--lens-glass-bg'], 'rgba(10, 15, 30, 0.7)')
  assert.equal(v['--lens-glass-border'], 'rgba(102, 204, 255, 0.22)')
  assert.equal(v['--lens-glass-blur'], 'blur(20px)')
  assert.equal(v['--lens-focus-ring'], '#aaeeff')
  assert.equal(v['--lens-input-border'], 'rgba(102, 204, 255, 0.5)')
  assert.equal(v['--lens-scrollbar-thumb'], 'rgba(102, 204, 255, 0.5)')
  assert.equal(shadcnVars('neon')['--background'], 'oklch(0.145 0 0)')
})

test('graphite and paper are flat: no blur, no glow', () => {
  for (const id of ['graphite', 'paper'] as const) {
    const v = extraVars(id)
    assert.equal(v['--lens-glass-blur'], 'none')
    assert.equal(v['--lens-glass-sheen'], 'none')
    assert.equal(v['--lens-input-focus-glow'], 'none')
    assert.ok(!v['--lens-shadow-card'].includes('inset'))
    assert.equal(paletteFor(id).playBtnGlow, 'none')
  }
})

test('shadcn variables follow the tokens in graphite and paper', () => {
  for (const id of ['graphite', 'paper'] as const) {
    const s = shadcnVars(id)
    assert.equal(s['--background'], 'var(--lens-void)')
    assert.equal(s['--card'], 'var(--lens-surface)')
    assert.equal(s['--border'], 'var(--lens-edge)')
    assert.equal(s['--ring'], 'var(--lens-focus)')
  }
})

test('the bootstrap script and the web theme module agree on ids, default, storage key and dark themes', () => {
  assert.deepEqual([...BOOT_IDS], [...THEME_IDS])
  assert.equal(BOOT_DEFAULT, DEFAULT_THEME)
  assert.equal(BOOT_KEY, WEB_KEY)
  assert.deepEqual(THEME_IDS.filter(id => !DARK_THEMES.includes(id)), [...LIGHT_THEMES])
})

test('COLORS follows refreshColors, and the tables built with themed()/ROLE_COLORS follow COLORS', () => {
  const table = themed(() => ({ ground: COLORS.void }))
  assert.equal(COLORS.void, TOKENS.graphite.void, 'graphite by default without a DOM')
  assert.equal(table.ground, TOKENS.graphite.void)
  assert.deepEqual(Object.keys(table), ['ground'])
  refreshColors('paper')
  assert.equal(COLORS.void, TOKENS.paper.void)
  assert.equal(table.ground, TOKENS.paper.void)
  assert.equal(ROLE_COLORS.user.text, COLORS.roleUserText)
  refreshColors('neon')
  assert.equal(COLORS.void, '#050510')
  assert.equal(COLORS.textDim, '#66ccffa0')
})

test('without a DOM the tokens fall back to the static table and the theme to the default', () => {
  assert.equal(currentThemeId(), DEFAULT_THEME)
  assert.deepEqual({ ...readTokens('paper') }, { ...TOKENS.paper })
})
