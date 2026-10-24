import type { ButtonHTMLAttributes, CSSProperties, Ref } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { TOUCH_TARGET } from '@/lib/mobile-view'

/**
 * The shared button of the canvas chrome (#508, #382). Each variant is one of the looks the five surfaces used to
 * spell by hand; none adds a look. Every variant carries the same three guarantees: a 24 px minimum target (44 px
 * below 768 px), the theme focus ring (FOCUS_RING) and `type="button"`. Colours come from COLORS (theme tokens).
 *
 * - control: canvas controls and motion-layer toggles. `active` fills it with the toggle colour.
 * - tour: guided tour card. Disabled is `aria-disabled` there (a disabled button would drop the focus to <body>).
 * - bar: playback bar. Box only; each use draws its own fill, border and colour through `style`.
 * - decision: permission request actions. Transparent; a use adds its own border shape through `style`.
 */
export type ButtonVariant = 'control' | 'tour' | 'bar' | 'decision'

const BASE_CLASS: Record<ButtonVariant, string> = {
  control:
    'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-2 py-1 text-2xs font-mono '
    + `${TOUCH_TARGET} ${FOCUS_RING} disabled:opacity-60`,
  tour:
    'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-3 py-1 text-xs font-mono aria-disabled:opacity-50 '
    + FOCUS_RING,
  bar: `min-h-6 min-w-6 ${TOUCH_TARGET} rounded font-mono text-2xs ${FOCUS_RING}`,
  decision: `text-2xs font-mono px-2 min-h-6 min-w-6 ${TOUCH_TARGET} rounded motion-safe:transition-colors ${FOCUS_RING}`,
}

/** Built when used: COLORS follows the theme, so a table made at module load would keep the default theme's colours. */
function baseStyle(variant: ButtonVariant): CSSProperties | undefined {
  switch (variant) {
    case 'control':
    case 'tour':
      return { background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }
    case 'decision':
      return { color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}`, background: 'transparent' }
    default:
      return undefined
  }
}

/** The class of a variant, for the rare element that must look like the button without being one (a label). */
export const buttonClass = (variant: ButtonVariant) => BASE_CLASS[variant]
/** The inline style of a variant (same use). */
export const buttonStyle = (variant: ButtonVariant) => baseStyle(variant)

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant: ButtonVariant
  /** control only: the toggle fill (the pressed/open state itself stays on aria-pressed / aria-expanded) */
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant, active, className, style, ref, ...rest }: ButtonProps) {
  const base = baseStyle(variant)
  const merged: CSSProperties | undefined = base || style
    ? { ...base, ...(active && variant === 'control' ? { background: COLORS.toggleActive } : null), ...style }
    : undefined
  return <button ref={ref} type="button" className={className ? `${BASE_CLASS[variant]} ${className}` : BASE_CLASS[variant]} style={merged} {...rest} />
}
