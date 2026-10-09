/**
 * Theme tokens: the single source of truth of the nine themes (three Catppuccin flavors, midnight, graphite, neon, ember, anthropic, contrast), all dark.
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

export const THEME_IDS = ['catppuccin-macchiato', 'catppuccin-mocha', 'catppuccin-frappe', 'midnight', 'graphite', 'neon', 'ember', 'anthropic', 'contrast'] as const
export type ThemeId = (typeof THEME_IDS)[number]

/** Theme applied when nothing is stored and no `?theme=` is given. Mirrors extension/src/theme-bootstrap.ts (a test compares them). */
export const DEFAULT_THEME: ThemeId = 'catppuccin-macchiato'

/**
 * Human labels of the selector. Midnight, Graphite, Neon and Ember are proper names, kept as is; the Catppuccin flavors carry the name of the palette;
 * `contrast` is shown as "High contrast" (its purpose, which is what a low-vision user looks for).
 */
export const THEME_LABELS: Record<ThemeId, string> = {
  'catppuccin-macchiato': 'Catppuccin Macchiato',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'catppuccin-frappe': 'Catppuccin Frappe',
  midnight: 'Midnight',
  graphite: 'Graphite',
  neon: 'Neon',
  ember: 'Ember',
  anthropic: 'Anthropic',
  contrast: 'High contrast',
}

/** Themes that stored values of earlier versions (and the removed `paper`) resolve to. Mirrored by the bootstrap script. */
export const LEGACY_THEME_IDS: readonly string[] = ['dark', 'light', 'paper']

/** Theme a stored or URL value resolves to: a known id as is, a legacy value (dark, light, paper) -> the default, else null. */
export function resolveThemeValue(value: unknown): ThemeId | null {
  if (isThemeId(value)) return value
  return typeof value === 'string' && LEGACY_THEME_IDS.includes(value) ? DEFAULT_THEME : null
}

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
 * (its glass, its cyan focus ring, its blur); the other themes follow the README: flat surface, 1px edge,
 * no backdrop blur, no glow.
 */
export function extraVars(id: ThemeId): Record<string, string> {
  return { ...baseExtraVars(id), ...panelExtraVars(id), ...ansiVars(id) }
}

/**
 * ANSI palette of Bash output (web/lib/ansi.ts, #152): 16 colours + default fg + the background they are checked against (the theme's void).
 * Neon keeps the values of develop; graphite and midnight are the same palette with a brighter red (dimmed text stays >= 4.5:1 on its surface);
 * contrast reuses it as is (a black background: every colour only gains contrast); ember warms the blue, purple
 * and cyan slots (less blue light) and keeps their luminance.
 * Checked in scripts/ansi.test.ts: >= 4.5:1, even dimmed (opacity .8).
 */
const ANSI_DARK = [
  '#9aa0b4', '#ff6b7a', '#5fdc8f', '#f0c24b', '#6fa8ff', '#d68cff', '#4fd8e0', '#d8dbe6',
  '#b0b6c8', '#ff8e9a', '#86efac', '#ffd866', '#93bfff', '#e3a9ff', '#7ae8ee', '#ffffff',
]
/** Anthropic: warm neutral greys and the brand orange, blue and green, lightened where needed (see docs/reading-the-ui.md). */
const ANSI_ANTHROPIC = [
  '#a8a59b', '#e8777f', '#9bb67f', '#e3b341', '#7fa9d3', '#c79bd0', '#7fb5a8', '#e8e6dc',
  '#bfbcb2', '#f08f96', '#b2cb98', '#efc968', '#9bc0e4', '#d9b3e0', '#9bcabd', '#faf9f5',
]
const ANSI_EMBER = [
  '#aa9d8f', '#f48a78', '#a8d68c', '#f0c860', '#93b0dc', '#d79bc5', '#8fd0c0', '#e3d7c7',
  '#bfb2a2', '#f8a898', '#bfe6a8', '#ffd97a', '#adc4ea', '#e7b5d6', '#a9e2d4', '#ffffff',
]
/**
 * Catppuccin: the official ANSI colours of the palette (normal 0-7, bright 8-15; palette.json 1.8.0), checked against the flavor's mantle
 * (our `surface`). The ones that fall under 4.5:1 once dimmed are lightened toward white, just enough: black and bright black (0 and 8:
 * surface1 / surface2 sit next to the background) on every flavor, bright red (9) on Macchiato, and on Frappe red (1), blue (4), bright
 * red (9) and bright blue (12). Listed in docs/reading-the-ui.md.
 */
const ANSI_CATPPUCCIN: Record<'catppuccin-mocha' | 'catppuccin-macchiato' | 'catppuccin-frappe', string[]> = {
  'catppuccin-mocha': [
    '#9b9ca6', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8',
    '#999ba8', '#f37799', '#89d88b', '#ebd391', '#74a8fc', '#f2aede', '#6bd7ca', '#bac2de',
  ],
  'catppuccin-macchiato': [
    '#9fa1ad', '#ed8796', '#a6da95', '#eed49f', '#8aadf4', '#f5bde6', '#8bd5ca', '#a5adcb',
    '#9ea1af', '#ee8191', '#8ccf7f', '#e1c682', '#78a1f6', '#f2a9dd', '#63cbc0', '#b8c0e0',
  ],
  'catppuccin-frappe': [
    '#aaadb7', '#eb9799', '#a6d189', '#e5c890', '#8fadef', '#f4b8e4', '#81c8be', '#a5adce',
    '#aaadba', '#ed9697', '#8ec772', '#d9ba73', '#8fadf2', '#f2a4db', '#5abfb5', '#b5bfe2',
  ],
}
/** Default foreground of Bash output. The background it is checked against is the theme's surface (neon keeps its legacy value). */
function ansiFg(id: ThemeId): string {
  if (id === 'ember') return '#f1e7db'
  if (id === 'contrast') return '#ffffff'
  if (id === 'anthropic') return '#faf9f5'
  return id in ANSI_CATPPUCCIN ? TOKENS[id].ink : '#e6e9f2'
}
function ansiVars(id: ThemeId): Record<string, string> {
  const palette = id in ANSI_CATPPUCCIN ? ANSI_CATPPUCCIN[id as keyof typeof ANSI_CATPPUCCIN]
    : id === 'anthropic' ? ANSI_ANTHROPIC : id === 'ember' ? ANSI_EMBER : id === 'graphite' || id === 'midnight' ? ANSI_DARK.map((c, i) => (i === 1 ? '#ff7886' : c)) : ANSI_DARK
  const out: Record<string, string> = {}
  palette.forEach((c, i) => { out[`--ansi-${i}`] = c })
  out['--ansi-fg'] = ansiFg(id)
  out['--ansi-bg'] = id === 'neon' ? '#07080f' : TOKENS[id].surface
  return out
}

function baseExtraVars(id: ThemeId): Record<string, string> {
  const t = TOKENS[id]
  if (id === 'neon') {
    return {
      '--lens-shadow-card': SHADOW_CARD.neon,
      '--lens-focus-ring': '#aaeeff',
      '--lens-focus-width': '2px',
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
  // Card and bar boundary: the decorative edge, except in High contrast where it is the marked control border
  const boundary = id === 'contrast' ? t['control-border'] : t.edge
  return {
    // Top bar band: the scene behind it stays dark in every theme, so the bar carries its own opaque surface
    // (its controls use translucent tints of the theme that only read on that surface)
    '--lens-bar-bg': t.surface,
    '--lens-bar-shadow': `inset 0 0 0 1px ${boundary}`,
    '--lens-bar-pad': '6px 8px',
    '--lens-shadow-card': SHADOW_CARD[id],
    '--lens-focus-ring': t.focus,
    '--lens-focus-width': id === 'contrast' ? '3px' : '2px',
    '--lens-glass-bg': t.surface,
    '--lens-glass-border': boundary,
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
    '--lens-scrim': id === 'contrast' ? 'rgba(0, 0, 0, 0.75)' : 'rgba(0, 0, 0, 0.5)',
    '--lens-live-halo': 'none',
  }
}

/**
 * Extras of the side panels and the feed: hover tints of rows and a high-contrast focus ring for links.
 * Neon keeps the white tints and the white ring it always had; the other themes derive from the tokens.
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
 * shadcn variables. The other themes map onto the tokens so shadcn components follow the theme.
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

/** Selector of a theme block. The default theme is also the fallback when no data-theme is set. */
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
    lines.push('  color-scheme: dark;')
    for (const role of ROLES) lines.push(`  ${cssVar(role)}: ${TOKENS[id][role]};`)
    for (const [k, val] of Object.entries(extraVars(id))) lines.push(`  ${k}: ${val};`)
    for (const [k, val] of Object.entries(shadcnVars(id))) lines.push(`  ${k}: ${val};`)
    lines.push('}', '')
  }
  return lines.join('\n')
}
