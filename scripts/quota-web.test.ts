import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuotaMessage, quotaGaugeState, acceptQuota, quotaStreamActive, type QuotaSnapshotView } from '../web/lib/quota'

const NOW = 1_790_000_000_000
const MIN = 60_000
const raw = (over: Record<string, unknown> = {}) => ({
  fiveHour: { usedPercentage: 62, resetsAt: NOW / 1000 + 3600 },
  sevenDay: { usedPercentage: 10, resetsAt: NOW / 1000 + 86400 },
  receivedAt: NOW,
  ...over,
})
const snap = (over: Partial<QuotaSnapshotView> = {}): QuotaSnapshotView => ({
  fiveHour: { remainingPercent: 38, resetsAt: NOW / 1000 + 3600 },
  sevenDay: { remainingPercent: 90, resetsAt: NOW / 1000 + 86400 },
  receivedAt: NOW,
  ...over,
})

test('parseQuotaMessage : remainingPercent = 100 - usedPercentage', () => {
  const out = parseQuotaMessage(raw())
  assert.equal(out?.fiveHour?.remainingPercent, 38)
  assert.equal(out?.sevenDay?.remainingPercent, 90)
  assert.equal(out?.fiveHour?.resetsAt, NOW / 1000 + 3600)
  assert.equal(out?.receivedAt, NOW)
})

test('parseQuotaMessage : bornes 0 et 100 acceptées', () => {
  assert.equal(parseQuotaMessage(raw({ fiveHour: { usedPercentage: 0, resetsAt: 1 } }))?.fiveHour?.remainingPercent, 100)
  assert.equal(parseQuotaMessage(raw({ fiveHour: { usedPercentage: 100, resetsAt: 1 } }))?.fiveHour?.remainingPercent, 0)
})

test('parseQuotaMessage : forme invalide = null', () => {
  for (const bad of [null, undefined, 'x', 3, [], raw({ receivedAt: 'x' }), raw({ receivedAt: -1 }), raw({ receivedAt: NaN }), raw({ receivedAt: Infinity }), raw({ receivedAt: undefined })]) {
    assert.equal(parseQuotaMessage(bad), null)
  }
})

test('parseQuotaMessage : fenêtre invalide = null pour cette fenêtre, jamais bornée', () => {
  const badWindows: unknown[] = [
    { usedPercentage: 101, resetsAt: 5 }, { usedPercentage: -1, resetsAt: 5 }, { usedPercentage: NaN, resetsAt: 5 },
    { usedPercentage: '50', resetsAt: 5 }, { usedPercentage: 50, resetsAt: 5.5 }, { usedPercentage: 50, resetsAt: -1 },
    { usedPercentage: 50, resetsAt: 8.64e12 + 1 }, { usedPercentage: 50, resetsAt: NaN }, { usedPercentage: 50 },
    null, 'x', [],
  ]
  for (const w of badWindows) {
    const out = parseQuotaMessage(raw({ fiveHour: w }))
    assert.equal(out?.fiveHour, null)
    assert.equal(out?.sevenDay?.remainingPercent, 90)
  }
  assert.equal(parseQuotaMessage(raw({ sevenDay: undefined }))?.sevenDay, null)
  assert.equal(parseQuotaMessage(raw({ fiveHour: { usedPercentage: 50, resetsAt: 8.64e12 } }))?.fiveHour?.remainingPercent, 50)
})

test('quotaGaugeState : claude avec données récentes, âge null', () => {
  assert.deepEqual(quotaGaugeState('claude', snap(), NOW), {
    kind: 'claude', fiveHour: snap().fiveHour, sevenDay: snap().sevenDay, ageMinutes: null,
  })
})

test('quotaGaugeState : âge null à exactement 5 min, minutes entières au-delà', () => {
  const at = (age: number) => quotaGaugeState('claude', snap(), NOW + age) as { kind: 'claude'; ageMinutes: number | null }
  assert.equal(at(5 * MIN).ageMinutes, null)
  assert.equal(at(5 * MIN + 1).ageMinutes, 5)
  assert.equal(at(7 * MIN + 59_000).ageMinutes, 7)
  assert.equal(at(30 * MIN).ageMinutes, 30)
})

test('quotaGaugeState : plus de 30 min sans mise à jour = unknown', () => {
  assert.equal(quotaGaugeState('claude', snap(), NOW + 30 * MIN).kind, 'claude')
  assert.deepEqual(quotaGaugeState('claude', snap(), NOW + 30 * MIN + 1), { kind: 'unknown' })
})

test('quotaGaugeState : horloge en retard sur receivedAt = âge null, pas négatif', () => {
  const s = quotaGaugeState('claude', snap(), NOW - 10 * MIN) as { kind: 'claude'; ageMinutes: number | null }
  assert.equal(s.kind, 'claude')
  assert.equal(s.ageMinutes, null)
})

test('acceptQuota : un snapshot valide remplace le courant', () => {
  const a = snap(), b = snap({ receivedAt: NOW + 1 })
  assert.equal(acceptQuota(a, b), b)
  assert.equal(acceptQuota(null, b), b)
})

test('acceptQuota : un message invalide (null) garde le courant', () => {
  const a = snap()
  assert.equal(acceptQuota(a, null), a)
  assert.equal(acceptQuota(null, null), null)
})

test('acceptQuota : un receivedAt plus petit remplace quand même (horloge du relais reculée)', () => {
  const older = snap({ receivedAt: NOW - 3_600_000 })
  assert.equal(acceptQuota(snap(), older), older)
})

test('parseQuotaMessage : receivedAt 0 accepté', () => {
  assert.equal(parseQuotaMessage(raw({ receivedAt: 0 }))?.receivedAt, 0)
})

test('quotaGaugeState : fenêtre dont resetsAt est passé ou égal à maintenant = null', () => {
  const nowS = NOW / 1000
  const s = snap({ fiveHour: { remainingPercent: 38, resetsAt: nowS }, sevenDay: { remainingPercent: 90, resetsAt: nowS + 1 } })
  const out = quotaGaugeState('claude', s, NOW) as { kind: 'claude'; fiveHour: unknown; sevenDay: unknown }
  assert.equal(out.fiveHour, null)
  assert.deepEqual(out.sevenDay, { remainingPercent: 90, resetsAt: nowS + 1 })
  const past = snap({ fiveHour: { remainingPercent: 38, resetsAt: nowS - 100 } })
  assert.equal((quotaGaugeState('claude', past, NOW) as { fiveHour: unknown }).fiveHour, null)
})

test('quotaGaugeState : resetsAt au-delà de now + 8 jours = null (non crédible)', () => {
  const limit = (NOW + 8 * 86_400_000) / 1000
  const s = snap({ fiveHour: { remainingPercent: 38, resetsAt: limit }, sevenDay: { remainingPercent: 90, resetsAt: limit + 1 } })
  const out = quotaGaugeState('claude', s, NOW) as { kind: 'claude'; fiveHour: unknown; sevenDay: unknown }
  assert.notEqual(out.fiveHour, null)
  assert.equal(out.sevenDay, null)
})

test('quotaGaugeState : deux fenêtres null après filtrage = unknown', () => {
  assert.deepEqual(quotaGaugeState('claude', snap({ fiveHour: null, sevenDay: null }), NOW), { kind: 'unknown' })
  const expired = snap({ fiveHour: { remainingPercent: 1, resetsAt: 1 }, sevenDay: { remainingPercent: 1, resetsAt: 1 } })
  assert.deepEqual(quotaGaugeState('claude', expired, NOW), { kind: 'unknown' })
})

test('quotaGaugeState : une seule fenêtre connue reste claude', () => {
  const out = quotaGaugeState('claude', snap({ sevenDay: null }), NOW) as { kind: string; sevenDay: unknown }
  assert.equal(out.kind, 'claude')
  assert.equal(out.sevenDay, null)
})

test('quotaGaugeState : claude sans snapshot = unknown', () => {
  assert.deepEqual(quotaGaugeState('claude', null, NOW), { kind: 'unknown' })
})

test('quotaGaugeState : copilot et opencode n utilisent jamais le snapshot', () => {
  for (const s of [snap(), null]) {
    assert.deepEqual(quotaGaugeState('copilot', s, NOW), { kind: 'unavailable', runtime: 'copilot' })
    assert.deepEqual(quotaGaugeState('opencode', s, NOW), { kind: 'no-subscription', runtime: 'opencode' })
  }
  assert.equal(quotaGaugeState('copilot', snap(), NOW + 99 * MIN).kind, 'unavailable')
})

test('quotaGaugeState : autres runtimes = hidden', () => {
  for (const r of ['codex', 'pi', 'gemini', 'cursor', '', 'Claude']) {
    assert.deepEqual(quotaGaugeState(r, snap(), NOW), { kind: 'hidden' })
  }
})

test('quotaGaugeState : runtime undefined (aucune session) : snapshot récent = claude, sans = hidden, périmé = unknown', () => {
  assert.equal(quotaGaugeState(undefined, snap(), NOW).kind, 'claude')
  assert.equal((quotaGaugeState(undefined, snap(), NOW + 6 * MIN) as { ageMinutes: number }).ageMinutes, 6)
  assert.deepEqual(quotaGaugeState(undefined, null, NOW), { kind: 'hidden' })
  assert.deepEqual(quotaGaugeState(undefined, snap(), NOW + 31 * MIN), { kind: 'unknown' })
})

test('quotaStreamActive : seul le flux du relais est une source (ni VS Code, ni démo, ni visite guidée)', () => {
  const relay = { relayOrigin: 'http://127.0.0.1:3001', isVSCode: false, useMockData: false }
  assert.equal(quotaStreamActive(relay), true)
  assert.equal(quotaStreamActive({ ...relay, relayOrigin: '' }), true, 'relais sur la même origine')
  assert.equal(quotaStreamActive({ ...relay, relayOrigin: null }), false)
  assert.equal(quotaStreamActive({ ...relay, isVSCode: true }), false)
  assert.equal(quotaStreamActive({ ...relay, useMockData: true }), false)
  assert.equal(quotaStreamActive({ ...relay, tourActive: true }), false)
})
