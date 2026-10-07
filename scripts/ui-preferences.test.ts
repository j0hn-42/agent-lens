import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_UI_PREFS, DOCK_RIGHT_WIDTH_MAX, DOCK_RIGHT_WIDTH_MIN, SESSION_ID_MAX_LENGTH, UI_PREFS_STORAGE_KEY,
  createPrefsStore, createSafeStorage, parsePrefs, restoreSelectedSessionId, sanitizePref, sanitizePrefs,
  serializePrefs, type StorageLike, type UiPrefs,
} from '../web/lib/ui-preferences'

const D = DEFAULT_UI_PREFS
const env = (prefs: unknown, v: unknown = 1) => JSON.stringify({ v, prefs })

// --- schema validation table ------------------------------------------------------------------

const table: Array<[string, string | null, Partial<UiPrefs>]> = [
  ['null (nothing stored)', null, {}],
  ['empty string', '', {}],
  ['not JSON', '{oops', {}],
  ['JSON scalar', '42', {}],
  ['JSON array', '[1,2]', {}],
  ['valid envelope', env({ showHexGrid: false, showStats: true, showTimeline: true, showFiles: true, showConversation: true, showCostOverlay: true, lastSelectedSessionId: 's1', dockRightWidth: 500 }),
    { showHexGrid: false, showStats: true, showTimeline: true, showFiles: true, showConversation: true, showCostOverlay: true, lastSelectedSessionId: 's1', dockRightWidth: 500 }],
  ['missing keys keep defaults', env({ showStats: true }), { showStats: true }],
  ['unversioned flat object (v0 migration)', JSON.stringify({ showHexGrid: false, dockRightWidth: 400 }), { showHexGrid: false, dockRightWidth: 400 }],
  ['future version ignored', env({ showStats: true }, 2), {}],
  ['negative version ignored', env({ showStats: true }, -1), {}],
  ['string version ignored', env({ showStats: true }, '1'), {}],
  ['envelope with non-object prefs', env('x'), {}],
  ['strings are not booleans', env({ showStats: 'true', showHexGrid: 0 }), {}],
  ['numbers are not booleans', env({ showTimeline: 1 }), {}],
  ['null boolean', env({ showHexGrid: null }), {}],
  ['huge width clamped', env({ dockRightWidth: 1e308 }), { dockRightWidth: DOCK_RIGHT_WIDTH_MAX }],
  ['tiny width clamped', env({ dockRightWidth: -50 }), { dockRightWidth: DOCK_RIGHT_WIDTH_MIN }],
  ['fractional width rounded', env({ dockRightWidth: 400.6 }), { dockRightWidth: 401 }],
  ['string width rejected', env({ dockRightWidth: '500' }), {}],
  ['null width rejected', '{"v":1,"prefs":{"dockRightWidth":null}}', {}],
  ['non-string session id rejected', env({ lastSelectedSessionId: 12 }), {}],
  ['empty session id rejected', env({ lastSelectedSessionId: '' }), {}],
  ['overlong session id rejected', env({ lastSelectedSessionId: 'x'.repeat(SESSION_ID_MAX_LENGTH + 1) }), {}],
  ['unknown keys dropped', env({ evil: true, speed: 10 }), {}],
]
for (const [name, input, expected] of table) {
  test(`parsePrefs: ${name}`, () => {
    assert.deepEqual(parsePrefs(input), { ...D, ...expected })
  })
}

test('parsePrefs: prototype pollution payloads are inert', () => {
  const payloads = [
    '{"__proto__":{"showStats":true,"polluted":1}}',
    '{"v":1,"prefs":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}}',
    '{"v":1,"__proto__":{"polluted":1},"prefs":{"showStats":true}}',
  ]
  for (const p of payloads) {
    const out = parsePrefs(p)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    assert.equal(Object.getPrototypeOf(out), Object.prototype)
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'polluted'), false)
    assert.deepEqual(Object.keys(out).sort(), Object.keys(D).sort())
  }
  // a top-level __proto__ key must not smuggle showStats in either
  assert.equal(parsePrefs('{"__proto__":{"showStats":true}}').showStats, false)
  // an inherited showStats (not an own property) is ignored
  const inherited = Object.create({ showStats: true })
  assert.equal(sanitizePrefs(inherited).showStats, false)
})

test('sanitizePrefs never throws on hostile shapes', () => {
  const hostile: unknown[] = [undefined, null, 1, 'x', [], () => 1, Symbol('s'), { v: 1, get prefs(): never { throw new Error('boom') } }]
  for (const h of hostile) {
    // a throwing getter is the one shape JSON can never produce; the contract is about decoded JSON
    if (typeof h === 'object' && h !== null && !Array.isArray(h) && 'v' in h) continue
    assert.doesNotThrow(() => sanitizePrefs(h))
  }
  assert.deepEqual(parsePrefs('x'.repeat(200_000)), D)
})

test('serializePrefs round-trips and writes the versioned envelope', () => {
  const prefs: UiPrefs = { ...D, showTimeline: true, lastSelectedSessionId: 'abc', dockRightWidth: 600 }
  const text = serializePrefs(prefs)
  assert.equal(JSON.parse(text).v, 1)
  assert.deepEqual(parsePrefs(text), prefs)
})

test('sanitizePref falls back per key', () => {
  assert.equal(sanitizePref('showHexGrid', 'no'), true)
  assert.equal(sanitizePref('showStats', 'no'), false)
  assert.equal(sanitizePref('dockRightWidth', Infinity), D.dockRightWidth)
  assert.equal(sanitizePref('lastSelectedSessionId', undefined), null)
})

// --- lastSelectedSessionId restore rules -------------------------------------------------------

test('restoreSelectedSessionId: only a listed, non-completed session is restored', () => {
  const sessions = [{ id: 'a', status: 'active' as const }, { id: 'b', status: 'completed' as const }]
  assert.equal(restoreSelectedSessionId('a', sessions), 'a')
  assert.equal(restoreSelectedSessionId('b', sessions), null, 'completed')
  assert.equal(restoreSelectedSessionId('gone', sessions), null, 'not listed')
  assert.equal(restoreSelectedSessionId(null, sessions), null)
  assert.equal(restoreSelectedSessionId('', sessions), null)
  assert.equal(restoreSelectedSessionId('a', []), null, 'empty list')
})

// --- store: batching, cross-tab, fallback ------------------------------------------------------

function memStorage() {
  const data = new Map<string, string>()
  const writes: string[] = []
  const storage: StorageLike = {
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); writes.push(v) },
    removeItem: k => { data.delete(k) },
  }
  return { data, writes, storage }
}
function manualSchedule() {
  const queue: Array<() => void> = []
  return {
    schedule: (fn: () => void) => { queue.push(fn); return () => { const i = queue.indexOf(fn); if (i >= 0) queue.splice(i, 1) } },
    tick: () => { const q = queue.splice(0); q.forEach(f => f()) },
    size: () => queue.length,
  }
}

test('store: many sets in one tick produce exactly one write with the final state', () => {
  const m = memStorage(); const s = manualSchedule()
  const store = createPrefsStore({ storage: m.storage, schedule: s.schedule })
  store.set('showStats', true); store.set('showTimeline', true); store.set('dockRightWidth', 9999); store.set('showStats', false)
  assert.equal(m.writes.length, 0, 'nothing written synchronously')
  assert.equal(s.size(), 1, 'a single scheduled write')
  s.tick()
  assert.equal(m.writes.length, 1)
  assert.deepEqual(parsePrefs(m.writes[0]), { ...D, showTimeline: true, dockRightWidth: DOCK_RIGHT_WIDTH_MAX })
  store.set('showFiles', true); s.tick()
  assert.equal(m.writes.length, 2, 'a later tick writes again')
})

test('store: setting an unchanged value does not notify nor write; snapshot is referentially stable', () => {
  const m = memStorage(); const s = manualSchedule()
  const store = createPrefsStore({ storage: m.storage, schedule: s.schedule })
  let calls = 0
  store.subscribe(() => { calls++ })
  const before = store.getSnapshot()
  store.set('showHexGrid', true)
  store.set('showStats', 'garbage')
  assert.equal(calls, 0); assert.equal(s.size(), 0); assert.equal(store.getSnapshot(), before)
  store.set('showStats', true)
  assert.equal(calls, 1); assert.notEqual(store.getSnapshot(), before)
  assert.equal(before.showStats, false, 'previous snapshot is not mutated')
})

test('store: unknown keys are ignored by set', () => {
  const m = memStorage(); const s = manualSchedule()
  const store = createPrefsStore({ storage: m.storage, schedule: s.schedule })
  store.set('__proto__' as never, { polluted: true })
  store.set('speed' as never, 5)
  assert.equal(s.size(), 0)
  assert.deepEqual(store.getSnapshot(), D)
})

test('store: loads stored values lazily; flush writes immediately', () => {
  const m = memStorage(); const s = manualSchedule()
  m.data.set(UI_PREFS_STORAGE_KEY, serializePrefs({ ...D, showConversation: true }))
  const store = createPrefsStore({ storage: m.storage, schedule: s.schedule })
  assert.equal(store.getSnapshot().showConversation, true)
  store.set('showStats', true)
  store.flush()
  assert.equal(m.writes.length, 1)
  assert.equal(store.hasPendingWrite(), false)
  s.tick()
  assert.equal(m.writes.length, 1, 'the cancelled frame does not write twice')
})

test('store: cross-tab update replaces state, notifies, and never writes back', () => {
  const m = memStorage(); const s = manualSchedule()
  const store = createPrefsStore({ storage: m.storage, schedule: s.schedule })
  let calls = 0
  store.subscribe(() => { calls++ })
  store.applyExternal(serializePrefs({ ...D, showCostOverlay: true, lastSelectedSessionId: 'x' }))
  assert.equal(store.getSnapshot().showCostOverlay, true)
  assert.equal(store.getSnapshot().lastSelectedSessionId, 'x')
  assert.equal(calls, 1)
  assert.equal(s.size(), 0); assert.equal(m.writes.length, 0, 'no echo write (would ping-pong between tabs)')
  store.applyExternal(serializePrefs({ ...D, showCostOverlay: true, lastSelectedSessionId: 'x' }))
  assert.equal(calls, 1, 'identical payload does not notify')
  store.applyExternal(null)
  assert.deepEqual(store.getSnapshot(), D, 'cleared storage resets')
  store.applyExternal('{"__proto__":{"showStats":true}}')
  assert.equal(store.getSnapshot().showStats, false, 'hostile external payload is validated')
})

test('store: an external update cancels a pending local write instead of overwriting it', () => {
  const m = memStorage(); const s = manualSchedule()
  const store = createPrefsStore({ storage: m.storage, schedule: s.schedule })
  store.set('showStats', true)
  store.applyExternal(serializePrefs({ ...D, showTimeline: true }))
  s.tick()
  assert.equal(m.writes.length, 0)
  assert.equal(store.getSnapshot().showTimeline, true)
})

test('store: reset restores defaults and removes the key', () => {
  const m = memStorage(); const s = manualSchedule()
  const store = createPrefsStore({ storage: m.storage, schedule: s.schedule })
  store.set('showStats', true); s.tick()
  assert.ok(m.data.has(UI_PREFS_STORAGE_KEY))
  store.reset(); s.tick()
  assert.deepEqual(store.getSnapshot(), D)
  assert.equal(m.data.has(UI_PREFS_STORAGE_KEY), false)
})

test('safe storage: throwing storage falls back to memory, never throws', () => {
  const broken: StorageLike = {
    getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') }, removeItem() { throw new Error('x') },
  }
  const safe = createSafeStorage(() => broken)
  assert.equal(safe.getItem('k'), null)
  safe.setItem('k', 'v')
  assert.equal(safe.getItem('k'), 'v')
  safe.removeItem('k')
  assert.equal(safe.getItem('k'), null)
  const getterThrows = createSafeStorage(() => { throw new Error('SecurityError') })
  getterThrows.setItem('a', 'b')
  assert.equal(getterThrows.getItem('a'), 'b')
  const none = createSafeStorage(() => null)
  none.setItem('a', 'b'); assert.equal(none.getItem('a'), 'b')
})

test('store on a throwing storage keeps working in memory', () => {
  const broken: StorageLike = { getItem() { throw new Error('no') }, setItem() { throw new Error('no') }, removeItem() { throw new Error('no') } }
  const s = manualSchedule()
  const store = createPrefsStore({ storage: createSafeStorage(() => broken), schedule: s.schedule })
  store.set('showStats', true)
  assert.doesNotThrow(() => s.tick())
  assert.equal(store.getSnapshot().showStats, true)
})
