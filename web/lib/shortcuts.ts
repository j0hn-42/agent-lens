import { PANEL_NAMES } from './ui-glossary'

/**
 * Single source of truth for the keyboard shortcuts shown in the help dialog.
 * `key` is the KeyboardEvent.key value and must be unique within the table.
 * Keep in sync with hooks/use-keyboard-shortcuts.ts.
 */
export interface ShortcutDef {
  /** KeyboardEvent.key value (unique) */
  key: string
  /** Human-readable key cap */
  display: string
  description: string
  group: 'Panels' | 'Playback' | 'View' | 'General'
  /** True when the shortcut is a plain character key subject to the "single-key shortcuts" preference */
  singleKey: boolean
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { key: ' ', display: 'Space', description: 'Play / pause', group: 'Playback', singleKey: true },
  { key: '1', display: '1', description: 'Speed 0.5x', group: 'Playback', singleKey: true },
  { key: '2', display: '2', description: 'Speed 1x', group: 'Playback', singleKey: true },
  { key: '3', display: '3', description: 'Speed 2x', group: 'Playback', singleKey: true },
  { key: '4', display: '4', description: 'Speed 4x', group: 'Playback', singleKey: true },
  { key: 'm', display: 'M', description: 'Mute / unmute audio', group: 'Playback', singleKey: true },
  { key: 'l', display: 'L', description: 'Toggle Sessions and agents list', group: 'Panels', singleKey: true },
  { key: 'f', display: 'F', description: `Toggle ${PANEL_NAMES.files} panel`, group: 'Panels', singleKey: true },
  { key: 'c', display: 'C', description: `Toggle ${PANEL_NAMES.conversation} panel`, group: 'Panels', singleKey: true },
  { key: 't', display: 'T', description: `Toggle ${PANEL_NAMES.timeline} panel`, group: 'Panels', singleKey: true },
  { key: 's', display: 'S', description: 'Toggle Stats panel', group: 'Panels', singleKey: true },
  { key: '$', display: '$', description: `Toggle ${PANEL_NAMES.cost} overlay`, group: 'Panels', singleKey: true },
  { key: 'F', display: 'Shift+F', description: 'Zoom to fit all agents', group: 'View', singleKey: true },
  { key: 'g', display: 'G', description: 'Toggle hex grid', group: 'View', singleKey: true },
  { key: 'u', display: 'U', description: 'Undo the latest action shown in a notification', group: 'General', singleKey: true },
  { key: 'Escape', display: 'Esc', description: 'Close the most recently opened panel, then clear the selection', group: 'General', singleKey: false },
  { key: '?', display: '?', description: 'Show this keyboard shortcuts dialog', group: 'General', singleKey: false },
]

export const SHORTCUT_GROUPS = ['Playback', 'Panels', 'View', 'General'] as const

/** localStorage key of the "single-key shortcuts" preference (WCAG 2.1.4) */
export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = 'agent-lens:single-key-shortcuts'

/** Stored preference -> enabled flag. Anything but an explicit 'false' keeps the shortcuts on. */
export function parseSingleKeyPreference(raw: string | null | undefined): boolean {
  return raw !== 'false'
}
