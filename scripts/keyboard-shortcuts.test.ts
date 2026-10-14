import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { shouldHandleShortcut, isPaletteShortcut } from '../web/hooks/use-keyboard-shortcuts'

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

test('plain keys on body are handled', () => {
  assert.equal(shouldHandleShortcut(ev('f'), true), true)
  assert.equal(shouldHandleShortcut(ev(' '), true), true)
})

test('Ctrl/Meta/Alt combos are ignored', () => {
  for (const m of ['ctrlKey', 'metaKey', 'altKey'] as const) {
    assert.equal(shouldHandleShortcut(ev('f', body, { [m]: true }), true), false)
    assert.equal(shouldHandleShortcut(ev('Escape', body, { [m]: true }), true), false)
  }
})

test('events from text fields and dialogs are ignored', () => {
  for (const sel of ['input', 'textarea', 'select', '[role="dialog"]']) {
    assert.equal(shouldHandleShortcut(ev('f', target('DIV', [sel])), true), false, sel)
  }
  assert.equal(shouldHandleShortcut(ev('f', target('DIV', [], true)), true), false)
  assert.equal(shouldHandleShortcut(ev('f', target('DIV', ['[contenteditable="true"]'])), true), false)
})

test('letters work with focus on a button, link or tab, e.g. right after Escape closed a panel (#376)', () => {
  for (const tag of ['button', 'a', '[role="tab"]']) {
    for (const k of ['p', 'l', 'y', 'f', 'F', '1']) {
      assert.equal(shouldHandleShortcut(ev(k, target('DIV', [tag])), true), true, `${k} on ${tag}`)
      assert.equal(shouldHandleShortcut(ev(k, target('DIV', [tag])), false), false, `${k} on ${tag}, preference off`)
    }
  }
})

test('Space and Enter on a button, link or tab keep activating it (#376)', () => {
  for (const tag of ['button', 'a', '[role="tab"]']) {
    for (const k of [' ', 'Enter']) {
      assert.equal(shouldHandleShortcut(ev(k, target('BUTTON', [tag])), true), false, `${JSON.stringify(k)} on ${tag}`)
    }
  }
})

test('Space is only handled on body', () => {
  assert.equal(shouldHandleShortcut(ev(' ', target('DIV', [])), true), false)
  assert.equal(shouldHandleShortcut(ev(' ', target('BODY', [])), true), true)
})

test('preference off disables single-key shortcuts but not Escape', () => {
  assert.equal(shouldHandleShortcut(ev('f'), false), false)
  assert.equal(shouldHandleShortcut(ev(' '), false), false)
  assert.equal(shouldHandleShortcut(ev('Escape'), false), true)
})

test('Escape works from a button but not from an input or dialog', () => {
  assert.equal(shouldHandleShortcut(ev('Escape', target('BUTTON')), true), true)
  assert.equal(shouldHandleShortcut(ev('Escape', target('INPUT')), true), false)
  assert.equal(shouldHandleShortcut(ev('Escape', target('DIV', ['[role="dialog"]'])), true), false)
})

test('? follows the single-key preference (WCAG 2.1.4), works from buttons, never from inputs or dialogs (#376)', () => {
  assert.equal(shouldHandleShortcut(ev('?'), false), false)
  assert.equal(shouldHandleShortcut(ev('?', target('BUTTON')), false), false)
  assert.equal(shouldHandleShortcut(ev('?'), true), true)
  assert.equal(shouldHandleShortcut(ev('?', target('BUTTON')), true), true)
  assert.equal(shouldHandleShortcut(ev('?', target('A')), true), true)
  assert.equal(shouldHandleShortcut(ev('?', target('INPUT')), true), false)
  assert.equal(shouldHandleShortcut(ev('?', target('DIV', ['[role="dialog"]'])), true), false)
  assert.equal(shouldHandleShortcut(ev('?', body, { ctrlKey: true }), true), false)
})

test('undo key is a single-key shortcut: needs the preference', () => {
  assert.equal(shouldHandleShortcut(ev('u'), true), true)
  assert.equal(shouldHandleShortcut(ev('u'), false), false)
  assert.equal(shouldHandleShortcut(ev('u', target('BUTTON')), false), false)
})

test('Ctrl+K and Cmd+K open the palette, other K combinations do not (#243)', () => {
  const k = (mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>, key = 'k') =>
    isPaletteShortcut({ key, target: body, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
  assert.equal(k({ ctrlKey: true }), true)
  assert.equal(k({ metaKey: true }), true)
  assert.equal(k({ ctrlKey: true }, 'K'), true, 'caps lock')
  assert.equal(k({}), false)
  assert.equal(k({ ctrlKey: true, altKey: true }), false)
  assert.equal(k({ ctrlKey: true, shiftKey: true }), false)
  assert.equal(k({ ctrlKey: true }, 'j'), false)
})

test('Ctrl+K is offered from a text field but not from another dialog (#243)', () => {
  const at = (t: unknown) => isPaletteShortcut({ key: 'k', target: t, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
  assert.equal(at(target('INPUT')), true)
  assert.equal(at(target('BUTTON')), true)
  assert.equal(at(target('DIV', ['[role="dialog"]'])), false)
})

test('Ctrl+K is not a single-key shortcut: shouldHandleShortcut still refuses modifier combos (#243)', () => {
  assert.equal(shouldHandleShortcut(ev('k', body, { ctrlKey: true }), true), false)
})
