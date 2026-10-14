/**
 * The decision channel of the operator control (#240, PR 3): fail closed, one decision per request, bound to
 * (session_id, tool_use_id, nonce), journalled before it is sent.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PermissionGate, canonicalJson, sha256Json, type PermissionRequestView, type GateClosed } from '../src/permission-gate'
import type { DecisionRecord } from '../src/decision-journal'

function setup(over: { enabled?: boolean; surface?: boolean; ttlMs?: number; maxPending?: number; journalOk?: boolean } = {}) {
  const records: DecisionRecord[] = []
  const state = { enabled: over.enabled ?? true, surface: over.surface ?? true, journalOk: over.journalOk ?? true }
  const gate = new PermissionGate({
    enabled: () => state.enabled,
    canDecide: () => state.surface,
    journal: { append: r => { if (!state.journalOk) return false; records.push(r); return true } },
    ttlMs: over.ttlMs ?? 5000,
    maxPending: over.maxPending ?? 4,
  })
  const shown: PermissionRequestView[] = []
  const closed: GateClosed[] = []
  gate.onRequest(v => shown.push(v))
  gate.onClosed(c => closed.push(c))
  return { gate, records, shown, closed, state }
}
const INPUT = { command: 'npm test', secret: 'sk-live-do-not-journal' }
const ask = (gate: PermissionGate, over: { sessionId?: string; toolUseId?: string | null; toolInput?: Record<string, unknown> } = {}) =>
  gate.request({ sessionId: over.sessionId ?? 's1', toolName: 'Bash', toolInput: over.toolInput ?? INPUT, toolUseId: over.toolUseId === undefined ? 'toolu_1' : over.toolUseId })

describe('canonicalJson / sha256Json', () => {
  it('does not depend on key order and hashes the canonical text', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}')
    assert.equal(sha256Json({ a: 1, b: 2 }), sha256Json({ b: 2, a: 1 }))
    assert.equal(sha256Json({ a: 1 }), createHash('sha256').update('{"a":1}').digest('hex'))
  })
})

describe('fail closed: no decision unless everything is in place', () => {
  it('control off: no decision, nothing shown, nothing journalled', async () => {
    const { gate, records, shown } = setup({ enabled: false })
    assert.equal(await ask(gate).decision, null)
    assert.equal(shown.length, 0)
    assert.equal(records.length, 0)
    assert.equal(gate.pending().length, 0)
  })
  it('no panel able to decide: no decision at once, so Claude Code is not kept waiting', async () => {
    const { gate, shown } = setup({ surface: false })
    assert.equal(await ask(gate).decision, null)
    assert.equal(shown.length, 0)
  })
  it('too many requests at once: the extra one gets no decision', async () => {
    const { gate } = setup({ maxPending: 2 })
    ask(gate, { toolUseId: 'a' }); ask(gate, { toolUseId: 'b' })
    assert.equal(await ask(gate, { toolUseId: 'c' }).decision, null)
    assert.equal(gate.pending().length, 2)
    gate.dispose()
  })
  it('expiry: no decision, journalled as expired, and the nonce is closed', async () => {
    const { gate, records, shown, closed } = setup({ ttlMs: 20 })
    const r = ask(gate)
    // The gate's TTL timer is unref'd on purpose (a pending request must not keep the extension host alive), so
    // nothing else holds the event loop while we wait for it; Node 22's runner then reports the test as unfinished.
    const keepAlive = setTimeout(() => {}, 5000)
    try { assert.equal(await r.decision, null) } finally { clearTimeout(keepAlive) }
    assert.equal(records.at(-1)?.outcome, 'expired')
    assert.equal(records.at(-1)?.decision, 'none')
    assert.deepEqual(closed.map(c => c.outcome), ['expired'])
    const out = gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'approve' })
    assert.deepEqual(out, { ok: false, reason: 'closed' })
  })
  it('the request is aborted (answered in the terminal): no decision, journalled, nonce closed', async () => {
    const { gate, records, shown } = setup()
    const r = ask(gate)
    r.abort('answered-elsewhere')
    assert.equal(await r.decision, null)
    assert.equal(records.at(-1)?.outcome, 'answered-elsewhere')
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'approve' }), { ok: false, reason: 'closed' })
  })
  it('dispose and a closed panel: every pending request ends with no decision', async () => {
    const { gate, records } = setup()
    const a = ask(gate, { toolUseId: 'a' }); const b = ask(gate, { toolUseId: 'b' })
    gate.cancelAll('surface-closed')
    assert.equal(await a.decision, null); assert.equal(await b.decision, null)
    assert.deepEqual(records.map(r => r.outcome), ['surface-closed', 'surface-closed'])
    const c = ask(gate, { toolUseId: 'c' })
    gate.dispose()
    assert.equal(await c.decision, null)
    assert.equal(records.at(-1)?.outcome, 'shutdown')
  })
})

describe('decide', () => {
  it('shows the panel what it needs, with a fresh nonce per request', () => {
    const { gate, shown } = setup()
    ask(gate, { toolUseId: 'a' }); ask(gate, { toolUseId: 'b' })
    assert.equal(shown.length, 2)
    const v = shown[0]
    assert.equal(v.sessionId, 's1'); assert.equal(v.toolUseId, 'a'); assert.equal(v.toolName, 'Bash')
    assert.match(v.nonce, /^[0-9a-f]{32}$/)
    assert.notEqual(v.nonce, shown[1].nonce)
    assert.equal(v.inputSha256, sha256Json(INPUT))
    assert.equal(JSON.parse(v.inputPreview).command, 'npm test')
    assert.equal(v.inputTruncated, false)
    assert.ok(v.expiresAt > v.requestedAt)
    gate.dispose()
  })

  it('approve: hands Claude Code an allow, and the journal gets the hash of the input, never the input', async () => {
    const { gate, records, shown, closed } = setup()
    const r = ask(gate)
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'approve' }), { ok: true })
    assert.deepEqual(await r.decision, { behavior: 'allow' })
    const rec = records.at(-1)!
    assert.equal(rec.decision, 'approve'); assert.equal(rec.outcome, 'sent'); assert.equal(rec.channel, 'vscode')
    assert.equal(rec.sessionId, 's1'); assert.equal(rec.toolUseId, 'toolu_1'); assert.equal(rec.tool, 'Bash')
    assert.equal(rec.inputSha256, sha256Json(INPUT))
    assert.doesNotMatch(JSON.stringify(records), /npm test|sk-live/)
    assert.deepEqual(closed.map(c => c.outcome), ['sent'])
  })

  it('deny: a deny with a default explanation; redirect: a deny that carries the operator text', async () => {
    const { gate, records, shown } = setup()
    const d = ask(gate, { toolUseId: 'd' })
    gate.decide({ sessionId: 's1', toolUseId: 'd', nonce: shown[0].nonce, action: 'deny' })
    const dec = await d.decision
    assert.equal(dec?.behavior, 'deny')
    assert.match(dec && dec.behavior === 'deny' ? dec.message : '', /denied .* Agent Lens/i)
    const r = ask(gate, { toolUseId: 'r' })
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'r', nonce: shown[1].nonce, action: 'redirect', message: '  use pnpm instead\u0007  ' }), { ok: true })
    assert.deepEqual(await r.decision, { behavior: 'deny', message: 'use pnpm instead' })
    assert.equal(records.at(-1)?.decision, 'redirect')
    assert.equal(records.at(-1)?.messageChars, 'use pnpm instead'.length)
    assert.doesNotMatch(JSON.stringify(records), /pnpm/)
  })

  it('redirect needs a non-empty text and keeps the request open when it is empty', async () => {
    const { gate, shown } = setup()
    const r = ask(gate)
    for (const message of [undefined, '', '   ', '\u0007\n']) {
      assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'redirect', message }), { ok: false, reason: 'message-required' })
    }
    assert.equal(gate.pending().length, 1)
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'redirect', message: 'x'.repeat(5000) }), { ok: true })
    const dec = await r.decision
    assert.ok(dec && dec.behavior === 'deny' && dec.message.length <= 2000)
  })

  it('a redirect text far past the cap is refused before any cleaning, and the request keeps waiting (#387)', () => {
    const { gate, shown } = setup()
    ask(gate)
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'redirect', message: 'x'.repeat(8001) }), { ok: false, reason: 'unknown' })
    assert.equal(gate.pending().length, 1)
    gate.dispose()
  })

  it('the cap never leaves half of a surrogate pair at the end of the text (#387)', async () => {
    const { gate, shown } = setup()
    const r = ask(gate)
    gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'redirect', message: 'x'.repeat(1999) + '😀' })
    const dec = await r.decision
    assert.ok(dec && dec.behavior === 'deny' && !/[\uD800-\uDBFF]$/.test(dec.message))
  })

  it('single use: the same decision a second time is refused and journalled as a replay', async () => {
    const { gate, records, shown } = setup()
    const r = ask(gate)
    const msg = { sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'approve' as const }
    assert.deepEqual(gate.decide(msg), { ok: true })
    await r.decision
    assert.deepEqual(gate.decide(msg), { ok: false, reason: 'closed' })
    assert.equal(records.at(-1)?.outcome, 'rejected-replay')
    assert.equal(records.filter(x => x.outcome === 'sent').length, 1)
  })

  it('an unknown nonce is refused and changes nothing', () => {
    const { gate, records } = setup()
    ask(gate)
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: 'f'.repeat(32), action: 'approve' }), { ok: false, reason: 'unknown' })
    assert.equal(gate.pending().length, 1)
    assert.equal(records.length, 0)
    gate.dispose()
  })

  it('bound to the session and the tool call: a wrong id is refused, journalled, and does not use up the nonce', async () => {
    const { gate, records, shown } = setup()
    const r = ask(gate)
    const nonce = shown[0].nonce
    assert.deepEqual(gate.decide({ sessionId: 'other', toolUseId: 'toolu_1', nonce, action: 'approve' }), { ok: false, reason: 'mismatch' })
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_2', nonce, action: 'approve' }), { ok: false, reason: 'mismatch' })
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: null, nonce, action: 'approve' }), { ok: false, reason: 'mismatch' })
    assert.equal(records.filter(x => x.outcome === 'rejected-mismatch').length, 3)
    assert.equal(gate.pending().length, 1)
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce, action: 'approve' }), { ok: true })
    assert.deepEqual(await r.decision, { behavior: 'allow' })
  })

  it('a request whose tool call cannot be identified is bound to null, and only null matches', async () => {
    const { gate, shown } = setup()
    const r = ask(gate, { toolUseId: null })
    assert.equal(shown[0].toolUseId, null)
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'approve' }), { ok: false, reason: 'mismatch' })
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: null, nonce: shown[0].nonce, action: 'deny' }), { ok: true })
    assert.equal((await r.decision)?.behavior, 'deny')
  })

  it('turned off while a request waits: the decision is refused and the request ends at once, journalled disabled', async () => {
    // A long TTL: the request must end because of the switch, not because it expired
    const { gate, state, shown, records, closed } = setup({ ttlMs: 5000 })
    const r = ask(gate)
    state.enabled = false
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'approve' }), { ok: false, reason: 'disabled' })
    assert.equal(await r.decision, null)
    assert.equal(gate.pending().length, 0)
    assert.equal(records.at(-1)?.outcome, 'disabled')
    assert.equal(records.at(-1)?.decision, 'none')
    assert.equal(closed.at(-1)?.outcome, 'disabled')
    assert.equal(records.some(x => x.outcome === 'sent'), false)
  })

  it('cancelAll("disabled") ends every waiting request at once without a decision', async () => {
    const { gate, state, records, closed } = setup({ ttlMs: 5000 })
    const a = ask(gate, { toolUseId: 'a' })
    const b = ask(gate, { toolUseId: 'b' })
    state.enabled = false
    gate.cancelAll('disabled')
    assert.equal(await a.decision, null)
    assert.equal(await b.decision, null)
    assert.equal(gate.pending().length, 0)
    assert.deepEqual(records.map(x => x.outcome), ['disabled', 'disabled'])
    assert.deepEqual(closed.map(x => x.outcome), ['disabled', 'disabled'])
  })

  it('a decision that cannot be journalled is not sent', async () => {
    const { gate, state, shown } = setup()
    const r = ask(gate)
    state.journalOk = false
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'approve' }), { ok: false, reason: 'journal-failed' })
    assert.equal(await r.decision, null)
    assert.equal(gate.pending().length, 0, 'the request is closed: Claude Code asks as usual')
  })

  it('a long tool input is cut for display only; the hash still covers all of it', () => {
    const { gate, shown } = setup()
    const big = { content: 'x'.repeat(200_000) }
    ask(gate, { toolInput: big })
    assert.equal(shown[0].inputTruncated, true)
    assert.ok(shown[0].inputPreview.length <= 64 * 1024)
    assert.equal(shown[0].inputSha256, sha256Json(big))
    gate.dispose()
  })

  it('rejects a malformed decision message', () => {
    const { gate } = setup()
    ask(gate)
    for (const bad of [null, 3, {}, { nonce: 'x' }, { sessionId: 's1', toolUseId: 'toolu_1', nonce: 'x', action: 'allow' }]) {
      assert.deepEqual(gate.decide(bad as never), { ok: false, reason: 'unknown' })
    }
    gate.dispose()
  })
})
