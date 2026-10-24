/**
 * A #rrggbb colour with a two-digit hex alpha ('80' is about 50 %), for the canvas and inline styles.
 * Replaces the `color + '80'` concatenation (#509). A colour that is not #rrggbb (rgba(), var(), #rgb) is returned
 * unchanged: the concatenation produced an invalid string for it, which throws in addColorStop.
 */
export function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color + alpha : color
}
