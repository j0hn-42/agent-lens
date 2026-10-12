/** Which arrow keys move a tablist: `horizontal` = Left/Right, `both` = Left/Right and Up/Down. Home/End always apply. */
export type TabOrientation = 'horizontal' | 'both'

/**
 * Roving-tabindex keyboard navigation for tablists: the index to focus (wrapping at both ends),
 * or null when the key is not ours. The single implementation for every tablist.
 */
export function nextTabIndex(
  current: number,
  key: string,
  count: number,
  orientation: TabOrientation = 'horizontal',
): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight': return (current + 1) % count
    case 'ArrowLeft': return (current - 1 + count) % count
    case 'ArrowDown': return orientation === 'both' ? (current + 1) % count : null
    case 'ArrowUp': return orientation === 'both' ? (current - 1 + count) % count : null
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}
