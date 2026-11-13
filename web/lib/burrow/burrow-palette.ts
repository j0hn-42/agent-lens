/**
 * The burrow's paper, ink and shadow: the `--lens-burrow-*` theme tokens (web/lib/theme-tokens.json).
 * The HTML overlays use them as is; the canvas cannot read var(), so it reads the computed values once per render setup.
 * Pure (no DOM): `style` is a CSSStyleDeclaration or anything with getPropertyValue.
 */
import { BURROW_VARS, DEFAULT_THEME } from '../theme-tokens'

export interface BurrowPalette { paper: string; ink: string; shadow: string; letterReturn: string; letterMessage: string; seal: string }

const NAMES: Record<keyof BurrowPalette, string> = {
  paper: '--lens-burrow-bubble', ink: '--lens-burrow-ink', shadow: '--lens-burrow-shadow',
  letterReturn: '--lens-burrow-letter-return', letterMessage: '--lens-burrow-letter-message', seal: '--lens-burrow-seal',
}

/** The palette of the container's computed style; a variable that is missing or empty falls back to the default theme's value */
export function readBurrowPalette(style: { getPropertyValue(name: string): string }): BurrowPalette {
  const out = {} as BurrowPalette
  for (const key of Object.keys(NAMES) as (keyof BurrowPalette)[]) {
    out[key] = style.getPropertyValue(NAMES[key]).trim() || BURROW_VARS[DEFAULT_THEME][NAMES[key]]
  }
  return out
}

export interface OverlayColors { paper: string; ink: string; shadow: string }

/** Colours of the bubbles and name tags: the theme tokens as var() (they follow a theme change), or the system colours under forced colours (the browser keeps those readable) */
export function overlayColors(forcedColors: boolean): OverlayColors {
  return forcedColors
    ? { paper: 'Canvas', ink: 'CanvasText', shadow: 'transparent' }
    : { paper: 'var(--lens-burrow-bubble)', ink: 'var(--lens-burrow-ink)', shadow: 'var(--lens-burrow-shadow)' }
}
