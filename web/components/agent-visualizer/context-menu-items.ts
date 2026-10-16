import type { ComponentProps } from "react"
import type { GlassContextMenu } from "./glass-context-menu"

export interface ContextMenuActions {
  /** Current state of the two overlays the menu toggles, so the menu items can say it */
  showStats: boolean
  showGrid: boolean
  toggleStats: () => void
  zoomToFit: () => void
  toggleGrid: () => void
  clearHistory: () => void
  /** Only offered on a real session */
  reloadSessionEvents: (() => void) | null
}

export function contextMenuItems(onAgent: boolean, a: ContextMenuActions): ComponentProps<typeof GlassContextMenu>['items'] {
  if (onAgent) return [{ icon: '📊', label: 'Toggle Stats', checked: a.showStats, onClick: a.toggleStats }]
  return [
    { icon: '🔍', label: 'Zoom to Fit', onClick: a.zoomToFit },
    { icon: '📊', label: 'Toggle Stats', checked: a.showStats, onClick: a.toggleStats },
    { icon: '⬡', label: 'Toggle Grid', checked: a.showGrid, onClick: a.toggleGrid },
    { label: '', onClick: () => {}, separator: true },
    { icon: '⟲', label: 'Clear history', confirmLabel: 'Confirm clear history', onClick: a.clearHistory },
    ...(a.reloadSessionEvents ? [{ icon: '↻', label: 'Reload session events', onClick: a.reloadSessionEvents }] : []),
  ]
}
