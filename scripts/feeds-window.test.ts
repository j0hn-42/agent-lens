import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRenderWindow, VIRTUALIZE_THRESHOLD, truncateLines, truncateWithMarker, markUnread, activeTabIndexOf,
} from '../web/lib/feed-utils'

test('resolveRenderWindow renders small lists in full', () => {
  assert.deepEqual(resolveRenderWindow(VIRTUALIZE_THRESHOLD - 1, 5, 10, -1), {
    start: 0, end: VIRTUALIZE_THRESHOLD - 1, virtualized: false,
  })
})

test('resolveRenderWindow windows large lists', () => {
  assert.deepEqual(resolveRenderWindow(500, 100, 130, -1), { start: 100, end: 130, virtualized: true })
})

test('resolveRenderWindow keeps the focused item mounted (above and below window)', () => {
  assert.deepEqual(resolveRenderWindow(500, 100, 130, 40), { start: 40, end: 130, virtualized: true })
  assert.deepEqual(resolveRenderWindow(500, 100, 130, 300), { start: 100, end: 301, virtualized: true })
  assert.deepEqual(resolveRenderWindow(500, 100, 130, 110), { start: 100, end: 130, virtualized: true })
})

test('resolveRenderWindow clamps out-of-range input', () => {
  assert.deepEqual(resolveRenderWindow(300, -5, 999, 999), { start: 0, end: 300, virtualized: true })
})

test('truncateLines reports hidden lines', () => {
  assert.deepEqual(truncateLines('a\nb\nc', 2), { lines: ['a', 'b'], hidden: 1 })
  assert.deepEqual(truncateLines('a\nb', Infinity), { lines: ['a', 'b'], hidden: 0 })
})

test('truncateWithMarker: the full text is recoverable (Show all)', () => {
  const full = 'x'.repeat(50)
  const t = truncateWithMarker(full, 10)
  assert.equal(t.hidden, 40)
  assert.equal(t.marker, '… (+40 chars)')
  assert.equal(t.text + 'x'.repeat(t.hidden), full)
})

test('markUnread skips the active tab and the all tab', () => {
  assert.deepEqual([...markUnread(new Set(), ['a', 'b'], 'a')], ['b'])
  assert.deepEqual([...markUnread(new Set(['z']), ['a'], 'all')], ['z'])
  assert.deepEqual([...markUnread(new Set(['z']), ['a'], 'b')].sort(), ['a', 'z'])
})

test('activeTabIndexOf falls back to the first tab so a tab is always tabbable', () => {
  assert.equal(activeTabIndexOf(['all', 'a', 'b'], 'b'), 2)
  assert.equal(activeTabIndexOf(['all', 'a'], 'gone'), 0)
})
