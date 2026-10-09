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
  group: 'Panels' | 'Playback' | 'View' | 'General' | 'Graph'
  /** True when the shortcut is a plain character key subject to the "single-key shortcuts" preference */
  singleKey: boolean
  /** Graph entries only: the KeyboardEvent.key values that canvas/keyboard-nav.ts maps to this entry */
  handles?: readonly string[]
  /** Graph entries only: how the keys are read aloud (defaults to `display`) */
  spoken?: string
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
  { key: 'p', display: 'P', description: `Toggle ${PANEL_NAMES.context} panel (project CLAUDE.md, memory, issues)`, group: 'Panels', singleKey: true },
  { key: 's', display: 'S', description: `Toggle ${PANEL_NAMES.stats} panel`, group: 'Panels', singleKey: true },
  { key: '$', display: '$', description: `Toggle ${PANEL_NAMES.cost} overlay`, group: 'Panels', singleKey: true },
  { key: 'F', display: 'Shift+F', description: 'Zoom to fit all agents', group: 'View', singleKey: true },
  { key: 'g', display: 'G', description: 'Toggle hex grid', group: 'View', singleKey: true },
  { key: 'u', display: 'U', description: 'Undo the latest action shown in a notification', group: 'General', singleKey: true },
  { key: 'Escape', display: 'Esc', description: 'Close the most recently opened panel, then clear the selection', group: 'General', singleKey: false },
  { key: '?', display: '?', description: 'Show this keyboard shortcuts dialog', group: 'General', singleKey: false },
  // Graph navigation, active while the graph has focus (not subject to the single-key preference).
  // `key` is an identifier here: the real keys are in `handles` (kept in sync with canvas/keyboard-nav.ts by a test).
  { key: 'graph:step', display: 'Arrow keys', description: 'Move between nodes; Right opens a folded branch, Left folds it or goes to the parent', group: 'Graph', singleKey: false, handles: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] },
  { key: 'graph:pan', display: 'Shift+Arrows', description: 'Pan the view', group: 'Graph', singleKey: false, handles: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], spoken: 'Shift with arrow keys' },
  { key: 'graph:zoom', display: '+ / -', description: 'Zoom in / out', group: 'Graph', singleKey: false, handles: ['+', '=', '-', '_'], spoken: 'Plus and minus' },
  { key: 'graph:fit', display: '0', description: 'Zoom to fit the graph', group: 'Graph', singleKey: false, handles: ['0'], spoken: 'Zero' },
  { key: 'graph:open', display: 'Enter / Space', description: 'Open details of the focused node', group: 'Graph', singleKey: false, handles: ['Enter', ' '] },
  { key: 'graph:menu', display: 'Menu / Shift+F10', description: 'Open the context menu of the focused node', group: 'Graph', singleKey: false, handles: ['ContextMenu', 'F10'], spoken: 'The context menu key or Shift F10' },
]

export const SHORTCUT_GROUPS = ['Playback', 'Panels', 'View', 'Graph', 'General'] as const

/** Screen-reader description of the graph keyboard navigation, generated from the same table as the help dialog. */
export function graphKeyboardHelp(): string {
  return SHORTCUTS.filter(s => s.group === 'Graph').map(s => `${s.spoken ?? s.display}: ${s.description}.`).join(' ')
}

/** localStorage key of the "single-key shortcuts" preference (WCAG 2.1.4) */
export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = 'agent-lens:single-key-shortcuts'

/** Stored preference -> enabled flag. Anything but an explicit 'false' keeps the shortcuts on. */
export function parseSingleKeyPreference(raw: string | null | undefined): boolean {
  return raw !== 'false'
}
