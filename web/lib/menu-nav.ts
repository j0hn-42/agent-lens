/** Pure helpers for the context menu (roving tabindex + viewport clamping). */

/** Next focused index for a menu with `count` items; null when the key is not a navigation key. */
export function nextMenuIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown': return (current + 1 + count) % count
    case 'ArrowUp': return (current - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}

/** Clamp a menu's top-left corner so the whole menu stays inside the viewport. */
export function clampMenuPosition(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin)
  const maxTop = Math.max(margin, viewport.height - size.height - margin)
  return {
    left: Math.min(Math.max(margin, pos.x), maxLeft),
    top: Math.min(Math.max(margin, pos.y), maxTop),
  }
}
