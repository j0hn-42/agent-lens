// Tranches de la suite e2e (#611) : la CI répartit les fichiers *.e2e.ts sur plusieurs jobs. Aucun fichier ne
// doit être perdu ni lancé deux fois, la répartition doit être stable et équilibrée par les durées mesurées.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { assignShards, e2eFiles, loadWeights, parseShardSpec, shardTestArgs, summarizeTap } from './e2e/shards'

const E2E_DIR = path.join(__dirname, 'e2e')
const SHARDS = 4

test('parseShardSpec reads "i/n" and rejects anything else (#611)', () => {
  assert.deepEqual(parseShardSpec('2/4'), { index: 2, total: 4 })
  assert.deepEqual(parseShardSpec(' 1/1 '), { index: 1, total: 1 })
  for (const bad of [undefined, '', '0/4', '5/4', '1/0', 'a/b', '1.5/4', '2', '2/4/1', '-1/4'])
    assert.throws(() => parseShardSpec(bad), /shard/i, `rejects ${String(bad)}`)
})

test('assignShards is a partition: every file once, in exactly one shard (#611)', () => {
  const files = ['a.e2e.ts', 'b.e2e.ts', 'c.e2e.ts', 'd.e2e.ts', 'e.e2e.ts', 'f.e2e.ts']
  const shards = assignShards(files, { 'a.e2e.ts': 50, 'b.e2e.ts': 10, 'c.e2e.ts': 30 }, 3)
  assert.equal(shards.length, 3)
  const all = shards.flat()
  assert.deepEqual([...all].sort(), [...files].sort())
  assert.equal(new Set(all).size, all.length)
  assert.deepEqual(assignShards([...files].reverse(), { 'a.e2e.ts': 50, 'b.e2e.ts': 10, 'c.e2e.ts': 30 }, 3), shards, 'independent of the input order')
})

test('a file without a measured duration still runs (#611)', () => {
  const shards = assignShards(['known.e2e.ts', 'new.e2e.ts'], { 'known.e2e.ts': 100 }, 2)
  assert.ok(shards.flat().includes('new.e2e.ts'))
})

test('assignShards balances by weight (#611)', () => {
  const shards = assignShards(['a', 'b', 'c', 'd'], { a: 9, b: 5, c: 4, d: 1 }, 2)
  const sums = shards.map(s => s.reduce((n, f) => n + ({ a: 9, b: 5, c: 4, d: 1 } as Record<string, number>)[f], 0))
  assert.deepEqual([...sums].sort((x, y) => x - y), [9, 10])
})

test('every e2e file on disk lands in exactly one of the CI shards (#611)', () => {
  const onDisk = fs.readdirSync(E2E_DIR).filter(f => f.endsWith('.e2e.ts')).sort()
  assert.ok(onDisk.length >= 30, 'the suite is read from the real directory')
  assert.deepEqual(e2eFiles(), onDisk)
  // Same glob as `test:e2e`: the shards run exactly what the whole suite runs.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.match(pkg.scripts['test:e2e'], /tests-a11y\/e2e\/\*\.e2e\.ts/)
  const shards = assignShards(onDisk, loadWeights(), SHARDS)
  assert.equal(shards.length, SHARDS)
  for (const s of shards) assert.ok(s.length > 0, 'no empty shard')
  const all = shards.flat()
  assert.deepEqual([...all].sort(), onDisk)
  assert.equal(new Set(all).size, all.length)
})

test('the CI shards stay balanced: none exceeds the mean by more than its largest file (#611)', () => {
  const weights = loadWeights()
  const files = e2eFiles()
  const w = (f: string) => weights[f] ?? 0
  const shards = assignShards(files, weights, SHARDS)
  const total = files.reduce((n, f) => n + w(f), 0)
  const largest = Math.max(...files.map(w))
  for (const s of shards) assert.ok(s.reduce((n, f) => n + w(f), 0) <= total / SHARDS + largest)
})

test('the agent picker e2e (83 agents of the Conversation panel) has a weight and runs in exactly one shard', () => {
  const f = 'conversation-agent-picker.e2e.ts'
  assert.ok(e2eFiles().includes(f), `${f} is on disk`)
  assert.ok((loadWeights()[f] ?? 0) > 0, `${f} has a weight`)
  assert.equal(assignShards(e2eFiles(), loadWeights(), SHARDS).filter(s => s.includes(f)).length, 1)
})

test('the weight table names only existing e2e files, with positive seconds (#611)', () => {
  const weights = loadWeights()
  const files = new Set(e2eFiles())
  assert.ok(Object.keys(weights).length >= 30)
  for (const [f, s] of Object.entries(weights)) {
    assert.ok(files.has(f), `${f} exists`)
    assert.ok(Number.isFinite(s) && s > 0, `${f} has a positive duration`)
  }
})

test('a shard runs its files one at a time, so one demo server at a time, like test:e2e (#611)', () => {
  const args = shardTestArgs(['b.e2e.ts', 'a.e2e.ts'], 'test-results/e2e-shard-2.tap')
  assert.ok(args.includes('--test'))
  assert.ok(args.includes('--test-concurrency=1'))
  assert.deepEqual(args.slice(-2), ['tests-a11y/e2e/b.e2e.ts', 'tests-a11y/e2e/a.e2e.ts'])
  // Second reporter: a TAP file the runner reads for the totals of the shard.
  const i = args.indexOf('--test-reporter=tap')
  assert.ok(i >= 0 && args.includes('--test-reporter-destination=test-results/e2e-shard-2.tap'))
})

test('summarizeTap reads the totals of a node --test TAP run, or nothing (#611)', () => {
  const tap = 'TAP version 13\nok 1 - x\n  ---\n  duration_ms: 3\n  ...\n1..1\n# tests 57\n# suites 2\n# pass 55\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 1\n# duration_ms 300.5\n'
  assert.deepEqual(summarizeTap(tap), { tests: 57, pass: 55, fail: 1, cancelled: 0, skipped: 0, todo: 1 })
  assert.equal(summarizeTap('ok 1 - x\n'), null)
})
