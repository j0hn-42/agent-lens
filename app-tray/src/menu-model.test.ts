// #335, increment 1: pure menu logic of the tray icon. No GUI, no network.
import '../../scripts/all-locales' // #662: both languages are loaded before the tests
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LOCALES, translate } from '../../web/lib/messages'
import { deriveMenu, STALE_AFTER_MS, type MenuInput, type StatusProbe } from './menu-model'

const NOW = 1_000_000
const ok = (body: unknown, receivedAt = NOW): StatusProbe => ({ kind: 'ok', body, receivedAt })
const valid = (extra: object = {}) => ok({ relayVersion: '0.10.0', sessionCount: 2, ...extra })
const input = (probe: StatusProbe, over: Partial<MenuInput> = {}): MenuInput => ({
  probe, now: NOW, port: 3001, ownsRelay: true, t: (k, p) => translate('fr', k, p), ...over,
})
const label = (m: ReturnType<typeof deriveMenu>, id: string) => m.items.find(i => i.id === id)?.label
// Read in the tests, once the French table is loaded (all-locales, #662)
const unknown = () => translate('fr', 'tray.sessions.unknown')

describe('deriveMenu: state is proven or unknown (#335)', () => {
  it('says unknown, never a number, when the probe did not succeed', () => {
    for (const kind of ['unreachable', 'timeout', 'http-error', 'invalid-json', 'not-started'] as const) {
      const m = deriveMenu(input({ kind }))
      assert.equal(label(m, 'state'), unknown(), kind)
      assert.equal(m.items.some(i => i.id === 'skipped'), false, kind)
      assert.ok(m.tooltip.includes(unknown()), kind)
    }
  })
  it('says unknown when sessionCount is not a non-negative integer', () => {
    for (const bad of [undefined, -1, 1.5, '2', NaN, null]) {
      assert.equal(label(deriveMenu(input(ok({ relayVersion: '0.10.0', sessionCount: bad }))), 'state'), unknown(), String(bad))
    }
    assert.equal(label(deriveMenu(input(ok(null))), 'state'), unknown())
  })
  it('says unknown when relayVersion is missing or not a version (not Agent Lens)', () => {
    for (const v of [undefined, '', 'hello', 3, '1.2']) {
      assert.equal(label(deriveMenu(input(ok({ relayVersion: v, sessionCount: 2 }))), 'state'), unknown(), String(v))
    }
    assert.notEqual(label(deriveMenu(input(ok({ relayVersion: '1.2.3-beta.1', sessionCount: 2 }))), 'state'), unknown())
  })
  it('does not show a stale value as current', () => {
    const fresh = deriveMenu(input(valid(), { now: NOW + STALE_AFTER_MS }))
    assert.notEqual(label(fresh, 'state'), unknown())
    const stale = deriveMenu(input(valid(), { now: NOW + STALE_AFTER_MS + 1 }))
    assert.equal(label(stale, 'state'), unknown())
    assert.equal(JSON.stringify(stale).includes('2 sessions'), false)
  })
  it('a receivedAt in the future is not proof either', () => {
    assert.equal(label(deriveMenu(input(valid(), { now: NOW - 1 })), 'state'), unknown())
  })
  it('shows the count with the right singular and plural', () => {
    assert.equal(label(deriveMenu(input(valid({ sessionCount: 0 }))), 'state'), '0 sessions suivies')
    assert.equal(label(deriveMenu(input(valid({ sessionCount: 1 }))), 'state'), '1 session suivie')
    assert.equal(label(deriveMenu(input(valid({ sessionCount: 5 }))), 'state'), '5 sessions suivies')
  })
})

describe('deriveMenu: skipped sessions (#335)', () => {
  it('adds an "at least k" line from the sum of the per-reason counts', () => {
    const m = deriveMenu(input(valid({ skippedSessions: { watchLimit: 2, sizeLimit: 1, fileLimit: 0 } })))
    assert.equal(label(m, 'skipped'), translate('fr', 'tray.skipped', { k: 3 }))
  })
  it('is absent when k is 0 or the field is invalid', () => {
    for (const bad of [{ watchLimit: 0, sizeLimit: 0, fileLimit: 0 }, undefined, null, 'x', { watchLimit: -1 }, { watchLimit: 1.5 }, { watchLimit: '2' }]) {
      assert.equal(deriveMenu(input(valid({ skippedSessions: bad }))).items.some(i => i.id === 'skipped'), false, JSON.stringify(bad))
    }
  })
})

describe('deriveMenu: actions (#335)', () => {
  it('disables open and copy-url when there is no port, and for a port that is not a valid integer', () => {
    for (const port of [null, 0, -1, 70000, 3001.5, NaN]) {
      const m = deriveMenu(input(valid(), { port }))
      assert.equal(m.items.find(i => i.id === 'open')?.enabled, false, String(port))
      assert.equal(m.items.find(i => i.id === 'copyUrl')?.enabled, false, String(port))
    }
    const m = deriveMenu(input(valid()))
    assert.equal(m.items.find(i => i.id === 'open')?.enabled, true)
    assert.equal(m.items.find(i => i.id === 'copyUrl')?.enabled, true)
  })
  it('quit says whether the relay stops: only when the icon owns it', () => {
    assert.equal(label(deriveMenu(input(valid(), { ownsRelay: true })), 'quit'), translate('fr', 'tray.quit.stopRelay'))
    assert.equal(label(deriveMenu(input(valid(), { ownsRelay: false })), 'quit'), translate('fr', 'tray.quit.closeIcon'))
  })
  it('the state line is read-only, the others can be activated, and quit is always last', () => {
    const m = deriveMenu(input(valid()))
    assert.equal(m.items.find(i => i.id === 'state')?.enabled, false)
    assert.equal(m.items[m.items.length - 1].id, 'quit')
    assert.equal(m.items[m.items.length - 1].enabled, true)
  })
})

describe('deriveMenu: accessibility and safety (#335)', () => {
  const probes: StatusProbe[] = [{ kind: 'timeout' }, valid(), valid({ skippedSessions: { watchLimit: 4 } })]
  it('has a non-empty tooltip, no empty label, unique ids, for every probe and both locales', () => {
    for (const l of LOCALES) for (const p of probes) for (const ownsRelay of [true, false]) {
      const m = deriveMenu(input(p, { ownsRelay, t: (k, q) => translate(l, k, q) }))
      assert.ok(m.tooltip.trim().length > 0)
      assert.ok(m.items.every(i => i.label.trim().length > 0))
      assert.equal(new Set(m.items.map(i => i.id)).size, m.items.length)
    }
  })
  it('the tooltip repeats the state in text, in both locales', () => {
    for (const l of LOCALES) {
      const m = deriveMenu(input(valid(), { t: (k, q) => translate(l, k, q) }))
      assert.ok(m.tooltip.includes(m.items.find(i => i.id === 'state')!.label), l)
    }
  })
  it('puts no URL in the output: the click carries an id, the driver builds the URL', () => {
    const m = deriveMenu(input(valid()))
    assert.equal(/https?:|127\.0\.0\.1|localhost/.test(JSON.stringify(m)), false)
  })
})
