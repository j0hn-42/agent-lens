import type { ComponentProps } from "react"
import type { GlassContextMenu } from "./glass-context-menu"
import { translate, type Locale } from "../../lib/messages"

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
  /** Agent menu only: open the right-clicked agent's detail card (#377) */
  showAgentDetails?: (() => void) | null
}

/** Items of the menu, worded in `locale` (#586); English when omitted. */
export function contextMenuItems(onAgent: boolean, a: ContextMenuActions, locale: Locale = 'en'): ComponentProps<typeof GlassContextMenu>['items'] {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key)
  if (onAgent) return [
    ...(a.showAgentDetails ? [{ icon: 'ℹ', label: t('menu.showDetails'), onClick: a.showAgentDetails }] : []),
    { icon: '🔍', label: t('menu.zoomFit'), onClick: a.zoomToFit },
    { icon: '📊', label: t('menu.toggleStats'), checked: a.showStats, onClick: a.toggleStats },
  ]
  return [
    { icon: '🔍', label: t('menu.zoomFit'), onClick: a.zoomToFit },
    { icon: '📊', label: t('menu.toggleStats'), checked: a.showStats, onClick: a.toggleStats },
    { icon: '⬡', label: t('menu.toggleGrid'), checked: a.showGrid, onClick: a.toggleGrid },
    { label: '', onClick: () => {}, separator: true },
    { icon: '⟲', label: t('menu.clear'), confirmLabel: t('menu.clear.confirm'), onClick: a.clearHistory },
    ...(a.reloadSessionEvents ? [{ icon: '↻', label: t('menu.reload'), onClick: a.reloadSessionEvents }] : []),
  ]
}
