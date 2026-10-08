import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ALL_SESSIONS_ID } from '../web/lib/bridge-types'
import {
  nextTabIndex, sessionTabIds, tabStopId, resolvePendingFocus, formatAllSummary, formatTruncatedHistory,
  formatDroppedMessages, labelAgentsWithSession, blurFlagAction, toastSettleTarget, pickRestoreTarget,
  undoShortcutAvailable,
} from '../web/lib/chrome-utils'
import { createPanelRegistry } from '../web/hooks/use-panel-registry'
import { shouldHandleShortcut } from '../web/hooks/use-keyboard-shortcuts'
import { SHORTCUTS, parseSingleKeyPreference } from '../web/lib/shortcuts'

function target(tagName: string, matches: string[] = [tagName.toLowerCase()], isContentEditable = false) {
  return {
    tagName,
    isContentEditable,
    closest: (sel: string) => (matches.some(m => sel.split(',').map(s => s.trim()).includes(m)) ? {} : null),
  }
}
const body = target('BODY', [])
const ev = (key: string, t: unknown = body, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key, target: t, ctrlKey: false, metaKey: false, altKey: false, ...mods })

// ─── Undo shortcut ───────────────────────────────────────────────────────────

test('undo key fires from buttons and tabs while an undo toast is visible', () => {
  const undo = { undoAvailable: true }
  assert.equal(shouldHandleShortcut(ev('u', target('BUTTON')), true, undo), true)
  assert.equal(shouldHandleShortcut(ev('U', target('BUTTON', ['[role="tab"]'])), true, undo), true)
  assert.equal(shouldHandleShortcut(ev('u', target('A')), true, undo), true)
  // never from text fields or dialogs, never with the preference off, never with modifiers
  assert.equal(shouldHandleShortcut(ev('u', target('INPUT')), true, undo), false)
  assert.equal(shouldHandleShortcut(ev('u', target('DIV', ['[role="dialog"]'])), true, undo), false)
  assert.equal(shouldHandleShortcut(ev('u', target('BUTTON')), false, undo), false)
  assert.equal(shouldHandleShortcut(ev('u', target('BUTTON'), { ctrlKey: true }), true, undo), false)
  // other single keys stay ignored on buttons even while a toast is visible
  assert.equal(shouldHandleShortcut(ev('f', target('BUTTON')), true, undo), false)
  assert.equal(shouldHandleShortcut(ev('u', target('BUTTON')), true, { undoAvailable: false }), false)
})

test('undo is announced and reachable only with the preference on and an actionable toast', () => {
  assert.equal(undoShortcutAvailable(true, [{ onAction: () => {} }]), true)
  assert.equal(undoShortcutAvailable(true, [{}, { onAction: undefined }]), false)
  assert.equal(undoShortcutAvailable(false, [{ onAction: () => {} }]), false)
  assert.equal(undoShortcutAvailable(true, []), false)
})

// ─── Single-key preference (#4) ──────────────────────────────────────────────

test('every single-key entry of the shortcuts table is gated by the preference, the others are not', () => {
  for (const def of SHORTCUTS) {
    if (def.group === 'Graph') continue // focus-scoped keys of the graph, not handled by the global hook
    assert.equal(shouldHandleShortcut(ev(def.key), false), !def.singleKey, `${def.key} with the preference off`)
    assert.equal(shouldHandleShortcut(ev(def.key), true), true, `${def.key} with the preference on`)
  }
})

test('the single-key preference is read from storage: only an explicit false disables it', () => {
  assert.equal(parseSingleKeyPreference('false'), false)
  for (const raw of ['true', null, undefined, '', 'garbage']) assert.equal(parseSingleKeyPreference(raw), true)
})

// ─── All tab ─────────────────────────────────────────────────────────────────

test('the All tab comes first and owns the tab stop when nothing else is selected', () => {
  const ids = sessionTabIds([{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(ids, [ALL_SESSIONS_ID, 'a', 'b'])
  assert.equal(tabStopId(ids, 'b'), 'b')
  assert.equal(tabStopId(ids, ALL_SESSIONS_ID), ALL_SESSIONS_ID)
  assert.equal(tabStopId(ids, 'gone'), ALL_SESSIONS_ID)
  assert.equal(tabStopId(ids, null), ALL_SESSIONS_ID)
  // arrows wrap through the All tab
  assert.equal(nextTabIndex(0, 'ArrowLeft', ids.length), 2)
  assert.equal(nextTabIndex(2, 'ArrowRight', ids.length), 0)
})

test('All mode summary and truncation markers', () => {
  assert.equal(formatAllSummary(3, 12, 1.234), '3 sessions - 12 agents - $1.23')
  assert.equal(formatAllSummary(1, 1, 0), '1 session - 1 agent - $0.00')
  assert.equal(formatTruncatedHistory(0), null)
  assert.equal(formatTruncatedHistory(1), 'History truncated: 1 older event dropped')
  assert.equal(formatTruncatedHistory(250), 'History truncated: 250 older events dropped')
  assert.equal(formatDroppedMessages(0), null)
  assert.equal(formatDroppedMessages(12), '... 12 older messages dropped')
})

test('agents get their session label and the session runtime unless they carry their own', () => {
  type A = { sessionId: string; sessionLabel?: string; runtime?: 'claude' | 'codex' }
  const c: A = { sessionId: 'unknown' }
  const agents = new Map<string, A>([['a', { sessionId: 's1' }], ['b', { sessionId: 's2', runtime: 'claude' }], ['c', c]])
  const sessions = [
    { id: 's1', label: 'Fix bug', runtime: 'codex' as const },
    { id: 's2', label: 'Refactor', runtime: 'codex' as const },
  ]
  const out = labelAgentsWithSession(agents, sessions)
  assert.equal(out.get('a')!.sessionLabel, 'Fix bug')
  assert.equal(out.get('a')!.runtime, 'codex')
  assert.equal(out.get('b')!.runtime, 'claude', 'own runtime wins')
  assert.equal(out.get('c'), c, 'unknown session leaves the agent untouched')
  assert.equal(agents.get('a')!.sessionLabel, undefined, 'input is not mutated')
  assert.equal(labelAgentsWithSession(out, sessions), out, 'stable reference when nothing changes')
})

// ─── Focus management ────────────────────────────────────────────────────────

test('pending tab focus only moves once the closed tab is gone', () => {
  const pending = { closedId: 'b', focusId: 'c' }
  assert.deepEqual(resolvePendingFocus(null, ['a']), { focusId: null, keep: null })
  assert.deepEqual(resolvePendingFocus(pending, ['a', 'b', 'c']), { focusId: null, keep: pending }, 'no-op close keeps waiting')
  assert.deepEqual(resolvePendingFocus(pending, ['a', 'c']), { focusId: 'c', keep: null })
  assert.deepEqual(resolvePendingFocus(pending, ['a']), { focusId: null, keep: null })
  assert.deepEqual(
    resolvePendingFocus({ closedId: 'a', focusId: ALL_SESSIONS_ID }, [ALL_SESSIONS_ID]),
    { focusId: ALL_SESSIONS_ID, keep: null },
    'the All tab catches focus when the last session closes',
  )
})

test('control bar focus flag survives a mode swap but not a click on empty space', () => {
  assert.equal(blurFlagAction(true, false), 'keep')
  assert.equal(blurFlagAction(false, false), 'clear')
  assert.equal(blurFlagAction(false, true), 'check')
})

test('toast focus settles on the previous element only when it is still mounted', () => {
  assert.equal(toastSettleTarget(true), 'previous')
  assert.equal(toastSettleTarget(false), 'none')
})

test('panel focus returns to the opener, else to the top-bar fallback, else nowhere', () => {
  const live = { isConnected: true }
  const gone = { isConnected: false }
  assert.equal(pickRestoreTarget(live, null), live)
  assert.equal(pickRestoreTarget(gone, live), live)
  assert.equal(pickRestoreTarget(null, live), live)
  assert.equal(pickRestoreTarget(gone, gone), null)
  assert.equal(pickRestoreTarget(null, null), null)
})

// ─── Panel registry ──────────────────────────────────────────────────────────

test('panel registry: newest first, stops at the first handler that closes, re-register replaces', () => {
  const reg = createPanelRegistry()
  const calls: string[] = []
  const offFeed = reg.register('message-feed', () => { calls.push('feed'); return true })
  reg.register('other', () => { calls.push('other'); return false })
  assert.deepEqual(reg.ids(), ['message-feed', 'other'])
  assert.equal(reg.escape(), true)
  assert.deepEqual(calls, ['other', 'feed'])
  // an expanded feed collapses on Escape, a collapsed one lets Escape fall through
  let expanded = true
  reg.register('message-feed', () => { if (!expanded) return false; expanded = false; return true })
  assert.deepEqual(reg.ids(), ['other', 'message-feed'])
  assert.equal(reg.escape(), true)
  assert.equal(expanded, false)
  assert.equal(reg.escape(), false)
  // unregistering the replaced registration does not remove the new handler
  offFeed()
  assert.deepEqual(reg.ids(), ['other', 'message-feed'])
})
