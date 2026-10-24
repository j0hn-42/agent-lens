"use client"

import { COLORS } from "@/lib/colors"
import { FOCUS_RING } from "@/lib/focus-ring"
import { useTheme } from "@/lib/theme"
import { useT } from "@/lib/locale"
import { THEME_IDS, THEME_LABELS, isThemeId } from "@/lib/theme-tokens"

/**
 * Theme selector (three Catppuccin flavors, midnight, graphite, neon, ember, anthropic, high contrast). A native select: keyboard operable, announced with its name
 * ("Theme") and its current value by screen readers. The choice is persisted by setTheme (THEME_STORAGE_KEY).
 * The proper names (Catppuccin, Midnight, Graphite, Neon, Ember, Anthropic) stay as they are in every language;
 * High contrast says what the theme does, so it is translated (#373).
 */
export function ThemeSelect({ id }: { id?: string } = {}) {
  const [theme, setTheme] = useTheme()
  const t = useT()
  return (
    <select
      id={id}
      aria-label={t('settings.theme')}
      title={t('settings.theme.title')}
      value={theme}
      onChange={e => { if (isThemeId(e.target.value)) setTheme(e.target.value) }}
      className={`min-h-6 px-1.5 py-0.5 rounded text-2xs font-mono cursor-pointer ${FOCUS_RING}`}
      style={{
        background: COLORS.toggleInactive,
        border: `1px solid ${COLORS.controlBorder}`,
        color: COLORS.textPrimary,
        colorScheme: "inherit",
      }}
    >
      {THEME_IDS.map(id => (
        <option key={id} value={id} style={{ background: COLORS.surface, color: COLORS.ink }}>
          {id === 'contrast' ? t('theme.contrast') : THEME_LABELS[id]}
        </option>
      ))}
    </select>
  )
}
