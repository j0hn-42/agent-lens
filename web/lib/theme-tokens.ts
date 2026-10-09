/**
 * Theme tokens: the single source of truth of the three themes (neon, graphite, paper).
 *
 * - The role values come from `theme-tokens.json`, a verbatim copy of the design system data
 *   (color + shadow). To update a colour, edit that file, then run `pnpm run gen:themes`.
 * - `themesCss()` turns them into `web/app/themes.css` (`--lens-<role>` custom properties per
 *   `[data-theme]`, plus the shadcn variables). A test fails when the committed CSS is stale.
 * - The canvas cannot read var(): `lib/theme.ts` reads these properties from :root with
 *   getComputedStyle and `lib/theme-palette.ts` derives the COLORS palette from them.
 *
 * Pure module (no DOM, no React) so scripts and node:test can import it.
 */

import data from './theme-tokens.json'

export const THEME_IDS = ['neon', 'graphite', 'paper'] as const
export type ThemeId = (typeof THEME_IDS)[number]

/** Theme applied when nothing is stored and no `?theme=` is given. Mirrors extension/src/theme-bootstrap.ts (a test compares them). */
export const DEFAULT_THEME: ThemeId = 'graphite'

/** Human labels of the selector. Neon, graphite and paper are proper names, kept as is. */
export const THEME_LABELS: Record<ThemeId, string> = {
  neon: 'Neon',
  graphite: 'Graphite',
  paper: 'Paper',
}

/** Themes drawn on a dark ground (they keep the `dark` class); paper is the only light one. */
export const DARK_THEMES: readonly ThemeId[] = ['neon', 'graphite']

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

export const ROLES = [
  'void', 'surface', 'surface-raised', 'edge', 'control-border', 'ink', 'ink-muted',
  'accent', 'on-accent', 'focus', 'ok', 'warn', 'danger', 'delegate', 'info', 'context-system',
] as const
export type Role = (typeof ROLES)[number]
export type ThemeTokens = Record<Role, string>

type RawToken = { name: string; value: Record<ThemeId, string> }

function build(): Record<ThemeId, ThemeTokens> {
  const out = {} as Record<ThemeId, ThemeTokens>
  for (const id of THEME_IDS) out[id] = {} as ThemeTokens
  for (const token of data.color.tokens as RawToken[]) {
    if (!(ROLES as readonly string[]).includes(token.name)) throw new Error(`Unknown theme role: ${token.name}`)
    for (const id of THEME_IDS) out[id][token.name as Role] = token.value[id]
  }
  for (const role of ROLES) {
    for (const id of THEME_IDS) {
      if (!/^#[0-9a-f]{6}$/i.test(out[id][role] ?? '')) throw new Error(`Theme ${id}: role ${role} is not a #rrggbb colour`)
    }
  }
  return out
}

/** Role values per theme, exactly as in the design tokens. */
export const TOKENS: Readonly<Record<ThemeId, Readonly<ThemeTokens>>> = build()

/** `shadow-card` per theme. */
export const SHADOW_CARD: Readonly<Record<ThemeId, string>> = (() => {
  const token = (data.shadow.tokens as RawToken[]).find(t => t.name === 'shadow-card')
  if (!token) throw new Error('shadow-card token missing')
  return token.value
})()

/** CSS custom property of a role, e.g. 'surface-raised' -> '--lens-surface-raised'. */
export function cssVar(role: string): string {
  return `--lens-${role}`
}

/**
 * Extra custom properties that are not design roles. Neon pins the exact values the app has always used
 * (its glass, its cyan focus ring, its blur); graphite and paper follow the README: flat surface, 1px edge,
 * no backdrop blur, no glow.
 */
export function extraVars(id: ThemeId): Record<string, string> {
  return { ...baseExtraVars(id), ...panelExtraVars(id), ...ansiVars(id) }
}

/**
 * ANSI palette of Bash output (web/lib/ansi.ts, #152): 16 colours + default fg + the background they are checked against.
 * Neon keeps the values of develop (dark palette); graphite is the same palette with a brighter red (dimmed text stays >= 4.5:1
 * on its surface); paper uses the dark-ink palette, a touch deeper on green/amber/purple/teal/red for the same reason.
 * Checked in scripts/ansi.test.ts: >= 4.5:1, even dimmed (opacity .8).
 */
const ANSI_DARK = [
  '#9aa0b4', '#ff6b7a', '#5fdc8f', '#f0c24b', '#6fa8ff', '#d68cff', '#4fd8e0', '#d8dbe6',
  '#b0b6c8', '#ff8e9a', '#86efac', '#ffd866', '#93bfff', '#e3a9ff', '#7ae8ee', '#ffffff',
]
const ANSI_PAPER = [
  '#2d3340', '#9f1128', '#085226', '#664200', '#1a3fb0', '#721fa5', '#07505f', '#374151',
  '#374151', '#a80f2d', '#14532d', '#5f3d00', '#1b3a99', '#6b21a8', '#0a4f5f', '#1f2937',
]
function ansiVars(id: ThemeId): Record<string, string> {
  const palette = id === 'paper' ? ANSI_PAPER : id === 'graphite' ? ANSI_DARK.map((c, i) => (i === 1 ? '#ff7886' : c)) : ANSI_DARK
  const fg = id === 'paper' ? '#111827' : '#e6e9f2'
  const bg = id === 'neon' ? '#07080f' : id === 'graphite' ? '#1b1b1c' : '#f2f2f0'
  const out: Record<string, string> = {}
  palette.forEach((c, i) => { out[`--ansi-${i}`] = c })
  out['--ansi-fg'] = fg
  out['--ansi-bg'] = bg
  return out
}

function baseExtraVars(id: ThemeId): Record<string, string> {
  const t = TOKENS[id]
  if (id === 'neon') {
    return {
      '--lens-shadow-card': SHADOW_CARD.neon,
      '--lens-focus-ring': '#aaeeff',
      '--lens-glass-bg': 'rgba(10, 15, 30, 0.7)',
      '--lens-glass-border': 'rgba(102, 204, 255, 0.22)',
      '--lens-glass-blur': 'blur(20px)',
      '--lens-glass-sheen': 'linear-gradient(90deg, transparent, rgba(100, 200, 255, 0.15), transparent)',
      '--lens-input-bg': 'rgba(100, 200, 255, 0.05)',
      '--lens-input-border': 'rgba(102, 204, 255, 0.5)',
      '--lens-input-color': '#aaeeff',
      '--lens-input-placeholder': 'rgba(102, 204, 255, 0.69)',
      '--lens-input-focus-border': '#aaeeff',
      '--lens-input-focus-glow': '0 0 8px rgba(102, 204, 255, 0.1)',
      '--lens-scrollbar-thumb': 'rgba(102, 204, 255, 0.5)',
      '--lens-scrollbar-thumb-hover': 'rgba(102, 204, 255, 0.7)',
      // Chrome (zone 3): hover washes, resize grip, modal scrim, live-dot halo
      '--lens-hover': 'rgba(255, 255, 255, 0.1)',
      '--lens-hover-subtle': 'rgba(255, 255, 255, 0.05)',
      '--lens-grip': 'rgba(255, 255, 255, 0.3)',
      '--lens-grip-hover': 'rgba(255, 255, 255, 0.6)',
      '--lens-scrim': 'rgba(0, 0, 0, 0.5)',
      '--lens-live-halo': '0 0 8px #ff4444, 0 0 16px rgba(255, 68, 68, 0.3)',
      // Top bar band: neon keeps the transparent strip over the scene; the other themes give it a surface (see below)
      '--lens-bar-bg': 'transparent',
      '--lens-bar-shadow': 'none',
      '--lens-bar-pad': '0px',
    }
  }
  return {
    // Top bar band: the scene behind it stays dark in every theme, so the bar carries its own opaque surface
    // (its controls use translucent tints of the theme that only read on that surface)
    '--lens-bar-bg': t.surface,
    '--lens-bar-shadow': `inset 0 0 0 1px ${t.edge}`,
    '--lens-bar-pad': '6px 8px',
    '--lens-shadow-card': SHADOW_CARD[id],
    '--lens-focus-ring': t.focus,
    '--lens-glass-bg': t.surface,
    '--lens-glass-border': t.edge,
    '--lens-glass-blur': 'none',
    '--lens-glass-sheen': 'none',
    '--lens-input-bg': t['surface-raised'],
    '--lens-input-border': t['control-border'],
    '--lens-input-color': t.ink,
    '--lens-input-placeholder': t['ink-muted'],
    '--lens-input-focus-border': t.focus,
    '--lens-input-focus-glow': 'none',
    '--lens-scrollbar-thumb': t['control-border'],
    '--lens-scrollbar-thumb-hover': t['ink-muted'],
    // Chrome (zone 3): flat hover on surface-raised, grip on control-border, no halo
    '--lens-hover': t['surface-raised'],
    '--lens-hover-subtle': t['surface-raised'],
    '--lens-grip': t['control-border'],
    '--lens-grip-hover': t['ink-muted'],
    '--lens-scrim': id === 'paper' ? 'rgba(26, 26, 26, 0.45)' : 'rgba(0, 0, 0, 0.5)',
    '--lens-live-halo': 'none',
  }
}

/**
 * Extras of the side panels and the feed: hover tints of rows and a high-contrast focus ring for links.
 * Neon keeps the white tints and the white ring it always had; graphite and paper derive from the tokens.
 */
function panelExtraVars(id: ThemeId): Record<string, string> {
  if (id === 'neon') {
    return {
      '--lens-hover-05': 'rgba(255, 255, 255, 0.05)',
      '--lens-hover-10': 'rgba(255, 255, 255, 0.1)',
      '--lens-focus-strong': '#ffffff',
    }
  }
  return {
    '--lens-hover-05': 'color-mix(in srgb, var(--lens-ink) 8%, transparent)',
    '--lens-hover-10': 'color-mix(in srgb, var(--lens-ink) 12%, transparent)',
    '--lens-focus-strong': TOKENS[id].focus,
  }
}

/**
 * shadcn variables. Graphite and paper map onto the tokens so shadcn components follow the theme.
 * Neon keeps the neutral values the app shipped with (its look must not move).
 */
export function shadcnVars(id: ThemeId): Record<string, string> {
  if (id === 'neon') {
    return {
      '--background': 'oklch(0.145 0 0)',
      '--foreground': 'oklch(0.985 0 0)',
      '--card': 'oklch(0.145 0 0)',
      '--card-foreground': 'oklch(0.985 0 0)',
      '--popover': 'oklch(0.145 0 0)',
      '--popover-foreground': 'oklch(0.985 0 0)',
      '--primary': 'oklch(0.985 0 0)',
      '--primary-foreground': 'oklch(0.205 0 0)',
      '--secondary': 'oklch(0.269 0 0)',
      '--secondary-foreground': 'oklch(0.985 0 0)',
      '--muted': 'oklch(0.269 0 0)',
      '--muted-foreground': 'oklch(0.708 0 0)',
      '--accent': 'oklch(0.269 0 0)',
      '--accent-foreground': 'oklch(0.985 0 0)',
      '--destructive': 'oklch(0.396 0.141 25.723)',
      '--destructive-foreground': 'oklch(0.637 0.237 25.331)',
      '--border': 'oklch(0.269 0 0)',
      '--input': 'oklch(0.269 0 0)',
      '--ring': 'oklch(0.439 0 0)',
      '--chart-1': 'oklch(0.488 0.243 264.376)',
      '--chart-2': 'oklch(0.696 0.17 162.48)',
      '--chart-3': 'oklch(0.769 0.188 70.08)',
      '--chart-4': 'oklch(0.627 0.265 303.9)',
      '--chart-5': 'oklch(0.645 0.246 16.439)',
      '--sidebar': 'oklch(0.205 0 0)',
      '--sidebar-foreground': 'oklch(0.985 0 0)',
      '--sidebar-primary': 'oklch(0.488 0.243 264.376)',
      '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
      '--sidebar-accent': 'oklch(0.269 0 0)',
      '--sidebar-accent-foreground': 'oklch(0.985 0 0)',
      '--sidebar-border': 'oklch(0.269 0 0)',
      '--sidebar-ring': 'oklch(0.439 0 0)',
    }
  }
  const v = (role: Role) => `var(${cssVar(role)})`
  return {
    '--background': v('void'),
    '--foreground': v('ink'),
    '--card': v('surface'),
    '--card-foreground': v('ink'),
    '--popover': v('surface'),
    '--popover-foreground': v('ink'),
    '--primary': v('accent'),
    '--primary-foreground': v('on-accent'),
    '--secondary': v('surface-raised'),
    '--secondary-foreground': v('ink'),
    '--muted': v('surface-raised'),
    '--muted-foreground': v('ink-muted'),
    '--accent': v('surface-raised'),
    '--accent-foreground': v('ink'),
    '--destructive': v('danger'),
    '--destructive-foreground': v('danger'),
    '--border': v('edge'),
    '--input': v('control-border'),
    '--ring': v('focus'),
    '--chart-1': v('accent'),
    '--chart-2': v('ok'),
    '--chart-3': v('warn'),
    '--chart-4': v('delegate'),
    '--chart-5': v('info'),
    '--sidebar': v('surface'),
    '--sidebar-foreground': v('ink'),
    '--sidebar-primary': v('accent'),
    '--sidebar-primary-foreground': v('on-accent'),
    '--sidebar-accent': v('surface-raised'),
    '--sidebar-accent-foreground': v('ink'),
    '--sidebar-border': v('edge'),
    '--sidebar-ring': v('focus'),
  }
}

/** Selector of a theme block. Graphite is also the fallback when no data-theme is set. */
function selector(id: ThemeId): string {
  return id === DEFAULT_THEME ? `:root:not([data-theme]),\n[data-theme="${id}"]` : `[data-theme="${id}"]`
}

/** Full text of web/app/themes.css. */
export function themesCss(): string {
  const lines: string[] = [
    '/* GENERATED by `pnpm run gen:themes` from web/lib/theme-tokens.json (see web/lib/theme-tokens.ts). Do not edit by hand. */',
    '',
  ]
  for (const id of THEME_IDS) {
    lines.push(`${selector(id)} {`)
    lines.push(`  color-scheme: ${DARK_THEMES.includes(id) ? 'dark' : 'light'};`)
    for (const role of ROLES) lines.push(`  ${cssVar(role)}: ${TOKENS[id][role]};`)
    for (const [k, val] of Object.entries(extraVars(id))) lines.push(`  ${k}: ${val};`)
    for (const [k, val] of Object.entries(shadcnVars(id))) lines.push(`  ${k}: ${val};`)
    lines.push('}', '')
  }
  return lines.join('\n')
}
