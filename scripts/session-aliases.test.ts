import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SessionInfo } from '../web/lib/bridge-types'
import {
  ALIAS_MAX_LENGTH, applyAliases, parseAliases, sanitizeAlias, serializeAliases, setAlias,
} from '../web/lib/session-aliases'

const session = (id: string, label: string): SessionInfo => ({ id, label, status: 'active', startTime: 0, lastActivityTime: 0 })

test('sanitizeAlias trims, collapses whitespace, strips control characters and caps the length', () => {
  assert.equal(sanitizeAlias('  my   session \n'), 'my session')
  assert.equal(sanitizeAlias('a\u0000b‮c'), 'abc')
  assert.equal(sanitizeAlias('x'.repeat(ALIAS_MAX_LENGTH + 20))!.length, ALIAS_MAX_LENGTH)
  assert.equal(sanitizeAlias('   '), null)
  assert.equal(sanitizeAlias(42), null)
})

test('parseAliases never throws and drops everything that is not a string pair', () => {
  assert.deepEqual([...parseAliases('not json')], [])
  assert.deepEqual([...parseAliases(null)], [])
  assert.deepEqual([...parseAliases('[1,2]')], [])
  const parsed = parseAliases(JSON.stringify({ s1: ' Front ', s2: 3, '': 'x', s3: '   ', ['y'.repeat(300)]: 'long' }))
  assert.deepEqual([...parsed], [['s1', 'Front']])
})

test('setAlias adds, replaces and removes (empty alias restores the original label); input is not mutated', () => {
  const base = new Map([['s1', 'A']])
  const added = setAlias(base, 's2', ' B ')
  assert.deepEqual([...added], [['s1', 'A'], ['s2', 'B']])
  assert.deepEqual([...base], [['s1', 'A']])
  assert.deepEqual([...setAlias(added, 's1', '')], [['s2', 'B']])
})

test('serialize then parse round-trips', () => {
  const m = new Map([['s1', 'Front'], ['s2', 'Back']])
  assert.deepEqual([...parseAliases(serializeAliases(m))], [...m])
})

test('applyAliases replaces the label, keeps the original one, and leaves other sessions untouched', () => {
  const sessions = [session('s1', 'abc123'), session('s2', 'def')]
  const out = applyAliases(sessions, new Map([['s1', 'Front'], ['gone', 'Ghost']]))
  assert.equal(out[0].label, 'Front')
  assert.equal(out[0].originalLabel, 'abc123')
  assert.equal(out[1], sessions[1])
  assert.equal(applyAliases(sessions, new Map()), sessions)
})
