"use client"

import { COLORS } from "@/lib/colors"
import { FOCUS_RING } from "@/lib/chrome-utils"
import { useTheme } from "@/lib/theme"
import { THEME_IDS, THEME_LABELS, isThemeId } from "@/lib/theme-tokens"

/**
 * Theme selector (neon | graphite | paper). A native select: keyboard operable, announced with its name
 * ("Theme") and its current value by screen readers. The choice is persisted by setTheme (THEME_STORAGE_KEY).
 */
export function ThemeSelect() {
  const [theme, setTheme] = useTheme()
  return (
    <select
      aria-label="Theme"
      title="Theme: neon, graphite or paper"
      value={theme}
      onChange={e => { if (isThemeId(e.target.value)) setTheme(e.target.value) }}
      className={`min-h-6 px-1.5 py-0.5 rounded text-[11px] font-mono cursor-pointer ${FOCUS_RING}`}
      style={{
        background: COLORS.toggleInactive,
        border: `1px solid ${COLORS.controlBorder}`,
        color: COLORS.textPrimary,
        colorScheme: "inherit",
      }}
    >
      {THEME_IDS.map(id => (
        <option key={id} value={id} style={{ background: COLORS.surface, color: COLORS.ink }}>
          {THEME_LABELS[id]}
        </option>
      ))}
    </select>
  )
}
