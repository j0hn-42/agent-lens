// The one place that spells the keyboard focus ring (issue #222). Every interactive control composes one of
// these constants instead of copying the utilities inline. The colour is always the `--lens-focus` theme
// token (web/lib/theme-tokens.json); the width follows the theme through the global `:focus-visible` rule.

const RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--lens-focus)]'

/** Visible keyboard focus ring drawn outside the control. */
export const FOCUS_RING = `${RING} focus-visible:outline-offset-2`

/** Same ring drawn inside the control, for controls clipped by a scroll container or flush with their parent. */
export const FOCUS_RING_INSET = `${RING} focus-visible:-outline-offset-2`

/** Outer ring in the high-contrast link colour (white in the High contrast theme), for links on tinted surfaces. */
export const FOCUS_RING_STRONG =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lens-focus-strong)]'
