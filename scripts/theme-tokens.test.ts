// Theme tokens: generated CSS in sync, neon pinned to the legacy look, mirrors between web and the bootstrap script.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_THEME, LEGACY_THEME_IDS, THEME_LABELS, resolveThemeValue, ROLES, THEME_IDS, TOKENS, cssVar, extraVars, shadcnVars, themesCss } from '../web/lib/theme-tokens'
import { paletteFor } from '../web/lib/theme-palette'
import { COLORS, ROLE_COLORS, refreshColors, themed } from '../web/lib/colors'
import { THEME_STORAGE_KEY as WEB_KEY, readTokens, currentThemeId } from '../web/lib/theme-dom'
import {
  THEME_IDS as BOOT_IDS, DEFAULT_THEME as BOOT_DEFAULT, THEME_STORAGE_KEY as BOOT_KEY, LEGACY_THEME_IDS as BOOT_LEGACY,
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

test('catppuccin-macchiato is the default theme and also applies when no data-theme is set', () => {
  assert.equal(DEFAULT_THEME, 'catppuccin-macchiato')
  assert.match(read('web/app/themes.css'), /:root:not\(\[data-theme\]\),\n\[data-theme="catppuccin-macchiato"\] \{/)
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

test('the dark themes other than neon are flat: no blur, no glow', () => {
  for (const id of THEME_IDS.filter(t => t !== 'neon')) {
    const v = extraVars(id)
    assert.equal(v['--lens-glass-blur'], 'none')
    assert.equal(v['--lens-glass-sheen'], 'none')
    assert.equal(v['--lens-input-focus-glow'], 'none')
    assert.ok(!v['--lens-shadow-card'].includes('inset'))
    assert.equal(paletteFor(id).playBtnGlow, 'none')
  }
})

test('shadcn variables follow the tokens in the themes other than neon', () => {
  for (const id of THEME_IDS.filter(t => t !== 'neon')) {
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
  assert.deepEqual([...BOOT_LEGACY], [...LEGACY_THEME_IDS])
})

test('there are nine themes, all dark, with stable ids and a label each; paper is gone', () => {
  assert.deepEqual([...THEME_IDS], ['catppuccin-macchiato', 'catppuccin-mocha', 'catppuccin-frappe', 'midnight', 'graphite', 'neon', 'ember', 'anthropic', 'contrast'])
  assert.deepEqual(THEME_LABELS, {
    'catppuccin-macchiato': 'Catppuccin Macchiato', 'catppuccin-mocha': 'Catppuccin Mocha', 'catppuccin-frappe': 'Catppuccin Frappe',
    midnight: 'Midnight', graphite: 'Graphite', neon: 'Neon', ember: 'Ember', anthropic: 'Anthropic', contrast: 'High contrast',
  })
  const css = read('web/app/themes.css')
  assert.doesNotMatch(css, /paper|color-scheme: light/)
  assert.equal((css.match(/color-scheme: dark;/g) ?? []).length, THEME_IDS.length)
  assert.equal(JSON.stringify(Object.keys(TOKENS)), JSON.stringify([...THEME_IDS]))
})

test('migration: paper, light and dark resolve to catppuccin-macchiato (the default), graphite stays graphite, unknown values to nothing', () => {
  for (const old of ['paper', 'light', 'dark']) assert.equal(resolveThemeValue(old), 'catppuccin-macchiato', old)
  for (const id of THEME_IDS) assert.equal(resolveThemeValue(id), id, id)
  for (const bad of ['purple', 'Paper', '', null, undefined, 3]) assert.equal(resolveThemeValue(bad), null, String(bad))
})

test('High contrast has a thicker focus ring and a marked card boundary; the others keep 2px', () => {
  assert.equal(extraVars('contrast')['--lens-focus-width'], '3px')
  assert.equal(extraVars('contrast')['--lens-glass-border'], TOKENS.contrast['control-border'])
  for (const id of THEME_IDS.filter(t => t !== 'contrast')) assert.equal(extraVars(id)['--lens-focus-width'], '2px', id)
})

test('COLORS follows refreshColors, and the tables built with themed()/ROLE_COLORS follow COLORS', () => {
  const table = themed(() => ({ ground: COLORS.void }))
  assert.equal(COLORS.void, TOKENS['catppuccin-macchiato'].void, 'macchiato by default without a DOM')
  assert.equal(table.ground, TOKENS['catppuccin-macchiato'].void)
  assert.deepEqual(Object.keys(table), ['ground'])
  refreshColors('ember')
  assert.equal(COLORS.void, TOKENS.ember.void)
  assert.equal(table.ground, TOKENS.ember.void)
  assert.equal(ROLE_COLORS.user.text, COLORS.roleUserText)
  refreshColors('neon')
  assert.equal(COLORS.void, '#050510')
  assert.equal(COLORS.textDim, '#66ccffa0')
})

test('without a DOM the tokens fall back to the static table and the theme to the default', () => {
  assert.equal(currentThemeId(), DEFAULT_THEME)
  assert.deepEqual({ ...readTokens('ember') }, { ...TOKENS.ember })
})

test('Catppuccin themes use the official palette (palette.json 1.8.0) on the roles: crust / mantle / base, text, subtext0, mauve, blue, lavender...', () => {
  const official = {
    'catppuccin-mocha': { crust: '#11111b', mantle: '#181825', base: '#1e1e2e', surface1: '#45475a', overlay1: '#7f849c', text: '#cdd6f4', subtext0: '#a6adc8', mauve: '#cba6f7', blue: '#89b4fa', lavender: '#b4befe', green: '#a6e3a1', yellow: '#f9e2af', red: '#f38ba8', teal: '#94e2d5' },
    'catppuccin-macchiato': { crust: '#181926', mantle: '#1e2030', base: '#24273a', surface1: '#494d64', overlay1: '#8087a2', text: '#cad3f5', subtext0: '#a5adcb', mauve: '#c6a0f6', blue: '#8aadf4', lavender: '#b7bdf8', green: '#a6da95', yellow: '#eed49f', red: '#ed8796', teal: '#8bd5ca' },
    'catppuccin-frappe': { crust: '#232634', mantle: '#292c3c', base: '#303446', surface1: '#51576d', overlay1: '#838ba7', text: '#c6d0f5', subtext0: '#a5adce', mauve: '#ca9ee6', blue: '#8caaee', lavender: '#babbf1', green: '#a6d189', yellow: '#e5c890', red: '#e78284', teal: '#81c8be' },
  } as const
  for (const [id, c] of Object.entries(official) as Array<[keyof typeof official, (typeof official)[keyof typeof official]]>) {
    assert.deepEqual({ ...TOKENS[id] }, {
      void: c.crust, surface: c.mantle, 'surface-raised': c.base, edge: c.surface1, 'control-border': c.overlay1,
      ink: c.text, 'ink-muted': c.subtext0, accent: c.mauve, 'on-accent': c.crust, focus: c.blue,
      ok: c.green, warn: c.yellow, danger: c.red, delegate: c.lavender, info: c.teal, 'context-system': c.overlay1,
    }, id)
  }
  assert.ok(THEME_IDS.every(id => !/latte/.test(id)), 'Latte is light and is not offered')
})

test('Anthropic: a warm dark theme built on the public brand colours (colours only, no logo): Dark, Light, mid grey, orange accent', () => {
  const t = TOKENS.anthropic
  assert.equal(t.surface, '#141413', 'brand Dark')
  assert.equal(t.ink, '#faf9f5', 'brand Light')
  assert.equal(t['ink-muted'], '#b0aea5', 'brand mid grey')
  assert.equal(t.accent, '#d97757', 'brand orange')
  assert.equal(t['on-accent'], '#141413', 'dark text on the orange fill')
  assert.equal(t.delegate, '#6a9bcc', 'brand blue')
  assert.equal(THEME_LABELS.anthropic, 'Anthropic')
  assert.ok(!JSON.stringify(Object.values(THEME_LABELS)).toLowerCase().includes('official'), 'not presented as an official theme')
})
