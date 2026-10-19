/**
 * The shortcuts dialog in the interface language (#588). The table (shortcuts.ts) stays the single source of the
 * keys and of the English texts; this module only says them in a locale. The English catalog texts equal the table's
 * descriptions (scripts/chrome-i18n.test.ts), so the two cannot drift apart. Pure: no React, no DOM.
 */
import { translate, type Locale, type MessageKey } from './messages'
import { panelName } from './command-palette'
import type { ShortcutDef } from './shortcuts'
import { formatSpeed } from './chrome-utils'

type PanelId = Parameters<typeof panelName>[1]

/** Panel toggled by a shortcut, with the catalog template of its description (placeholder {name}). */
const PANEL_SHORTCUTS: Readonly<Record<string, { id: PanelId; template: MessageKey }>> = {
  f: { id: 'files', template: 'palette.panel.toggle' },
  c: { id: 'conversation', template: 'palette.panel.toggle' },
  t: { id: 'timeline', template: 'palette.panel.toggle' },
  p: { id: 'context', template: 'shortcut.panel.context' },
  s: { id: 'stats', template: 'palette.panel.toggle' },
  y: { id: 'system', template: 'shortcut.panel.system' },
  $: { id: 'cost', template: 'palette.panel.toggleOverlay' },
}

const DESCRIPTION_KEY: Readonly<Record<string, MessageKey>> = {
  ' ': 'shortcut.play',
  m: 'shortcut.mute',
  F: 'shortcut.fitAll',
  z: 'shortcut.fullscreen',
  v: 'shortcut.presentation',
  g: 'shortcut.grid',
  u: 'shortcut.undo',
  ',': 'shortcut.settings',
  'Ctrl+K': 'shortcut.palette',
  Escape: 'shortcut.escape',
  '?': 'shortcut.help',
  'graph:step': 'shortcut.graph.step',
  'graph:pan': 'shortcut.graph.pan',
  'graph:zoom': 'shortcut.graph.zoom',
  'graph:fit': 'shortcut.graph.fit',
  'graph:open': 'shortcut.graph.open',
  'graph:menu': 'shortcut.graph.menu',
}

const KEY_CAP_KEY: Readonly<Record<string, MessageKey>> = {
  ' ': 'shortcut.key.space',
  F: 'shortcut.key.shiftF',
  Escape: 'shortcut.key.escape',
  'graph:step': 'shortcut.key.arrows',
  'graph:pan': 'shortcut.key.shiftArrows',
  'graph:open': 'shortcut.key.enterSpace',
  'graph:menu': 'shortcut.key.menu',
}

/** What the shortcut does, in the language. */
export function shortcutDescription(def: ShortcutDef, locale: Locale): string {
  if (def.key === 'l') return translate(locale, 'palette.panel.toggleList', { name: translate(locale, 'sessions.title') })
  const panel = PANEL_SHORTCUTS[def.key]
  if (panel) return translate(locale, panel.template, { name: panelName(locale, panel.id) })
  if (/^[1-4]$/.test(def.key)) return translate(locale, 'shortcut.speed', { n: formatSpeed(({ '1': 0.5, '2': 1, '3': 2, '4': 4 } as const)[def.key as '1' | '2' | '3' | '4'], locale) })
  const key = DESCRIPTION_KEY[def.key]
  return key ? translate(locale, key) : def.description
}

/** The key cap: a key name stays as it is, only the words of it (Space, Esc, Shift, Arrow keys) are translated. */
export function shortcutKeyCap(def: ShortcutDef, locale: Locale): string {
  const key = KEY_CAP_KEY[def.key]
  return key ? translate(locale, key) : def.display
}

export function shortcutGroupName(group: ShortcutDef['group'], locale: Locale): string {
  return translate(locale, `shortcut.group.${group}` as MessageKey)
}
