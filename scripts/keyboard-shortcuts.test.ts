import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { shouldHandleShortcut } from '../web/hooks/use-keyboard-shortcuts'

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

test('events from interactive elements are ignored', () => {
  for (const sel of ['input', 'textarea', 'select', 'button', 'a', '[role="tab"]', '[role="dialog"]']) {
    assert.equal(shouldHandleShortcut(ev('f', target('DIV', [sel])), true), false, sel)
  }
  assert.equal(shouldHandleShortcut(ev('f', target('DIV', [], true)), true), false)
  assert.equal(shouldHandleShortcut(ev('f', target('DIV', ['[contenteditable="true"]'])), true), false)
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
