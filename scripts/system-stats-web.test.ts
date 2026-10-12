import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSystemSample, pushSample, severity, ratio, summarise, SYSTEM_HISTORY } from '../web/lib/system-stats'

const base = { ts: 1, cpu: { total: 0.5, perCore: [0.5] }, mem: { total: 100, used: 50 }, swap: null, disk: null, load: [1, 1, 1], uptime: 5, platformNote: null }

test('parseSystemSample : accepte un échantillon valide', () => {
  assert.deepEqual(parseSystemSample(base)?.cpu.total, 0.5)
})

test('parseSystemSample : rejette ou borne le hostile', () => {
  assert.equal(parseSystemSample(null), null)
  assert.equal(parseSystemSample({ ...base, ts: 'x' }), null)
  assert.equal(parseSystemSample({ ...base, cpu: { total: NaN, perCore: [] } })?.cpu.total, null)
  assert.equal(parseSystemSample({ ...base, cpu: { total: 7, perCore: [] } })?.cpu.total, null)
  assert.equal(parseSystemSample({ ...base, mem: { total: -1, used: 5 } })?.mem, null)
  assert.equal(parseSystemSample({ ...base, mem: { total: 10, used: 99 } })?.mem, null)
  assert.equal(parseSystemSample({ ...base, cpu: { total: 0.1, perCore: new Array(5000).fill(0.1) } })?.cpu.perCore.length, 256)
})

test('pushSample : buffer circulaire borné, immuable', () => {
  let b: ReturnType<typeof pushSample> = []
  const frozen = Object.freeze([] as never[])
  assert.doesNotThrow(() => pushSample(frozen, parseSystemSample(base)!))
  for (let i = 0; i < SYSTEM_HISTORY + 10; i++) b = pushSample(b, { ...parseSystemSample(base)!, ts: i })
  assert.equal(b.length, SYSTEM_HISTORY)
  assert.equal(b[b.length - 1].ts, SYSTEM_HISTORY + 9)
})

test('severity : bornes 0,85 et 0,95, null = unknown', () => {
  assert.equal(severity(0.849), 'normal')
  assert.equal(severity(0.85), 'warm')
  assert.equal(severity(0.949), 'warm')
  assert.equal(severity(0.95), 'critical')
  assert.equal(severity(null), 'unknown')
})

test('ratio : null si total nul', () => {
  assert.equal(ratio({ total: 0, used: 0 }), null)
  assert.equal(ratio({ total: 100, used: 25 }), 0.25)
  assert.equal(ratio(null), null)
})

test('summarise : ignore les null, max récent', () => {
  const s = (v: number | null, ts: number) => ({ ...parseSystemSample(base)!, ts, cpu: { total: v, perCore: [] } })
  const out = summarise([s(0.2, 1), s(null, 2), s(0.9, 3), s(null, 4)], x => x.cpu.total)
  assert.deepEqual(out, { current: null, max: 0.9 })
})
