// Structure du job e2e-a11y découpé en tranches (#611). La protection de branche exige un check nommé exactement
// `e2e-a11y` : il doit rester un job de ce nom, qui échoue dès qu'une tranche échoue, est annulée ou n'a pas tourné.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(__dirname, '..')
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

/** Text of a top-level job (2-space indent), up to the next job or the end of the file. */
function job(id: string): string {
  const m = ci.match(new RegExp(`^  ${id}:\\n((?:(?:    .*|\\s*)\\n)*)`, 'm'))
  assert.ok(m, `ci.yml defines the job ${id}`)
  return m[1]
}

test('e2e-a11y-shard runs the suite as a matrix of shards that do not cancel each other (#611)', () => {
  const shard = job('e2e-a11y-shard')
  const list = shard.match(/^\s+shard: \[([\d, ]+)\]$/m)
  assert.ok(list, 'matrix.shard is an inline list')
  const shards = list[1].split(',').map(s => Number(s.trim()))
  assert.deepEqual(shards, shards.map((_, i) => i + 1), 'shards are numbered 1..n')
  assert.ok(shards.length >= 2)
  assert.match(shard, /^\s+fail-fast: false$/m, 'a failing shard lets the others finish, so every failure is visible')
  assert.ok(shard.includes(`E2E_SHARD: \${{ matrix.shard }}/${shards.length}`), 'each shard runs i/n with n = the matrix length')
  assert.match(shard, /^\s+run: pnpm --dir web run test:e2e:shard$/m)
})

test('each shard uploads its demo server logs under its own name (#581, #611)', () => {
  const shard = job('e2e-a11y-shard')
  assert.match(shard, /uses: actions\/upload-artifact@v4/)
  assert.match(shard, /name: e2e-demo-server-log-shard-\$\{\{ matrix\.shard \}\}/)
  assert.match(shard, /path: web\/test-results\//)
})

test('the e2e-a11y check aggregates the shards and fails unless all succeeded (#611)', () => {
  const agg = job('e2e-a11y')
  assert.match(agg, /^    needs: e2e-a11y-shard$/m)
  // always(): a skipped required check would count as passed; it must run, and fail, when a shard did not succeed.
  assert.match(agg, /^    if: \$\{\{ always\(\) \}\}$/m)
  assert.match(agg, /\$\{\{ needs\.e2e-a11y-shard\.result \}\}/)
  assert.match(agg, /= success/)
  assert.ok(!/^\s+matrix:/m.test(agg), 'the aggregate is a single job, so its check name stays exactly e2e-a11y')
  assert.ok(!/^    name:/m.test(agg), 'no display name: the check name is the job id')
})

test('the shards cache the Playwright browser and the Turbopack dev cache, saved by one shard only (#611)', () => {
  const shard = job('e2e-a11y-shard')
  for (const p of ['~/.cache/ms-playwright', 'web/.next-e2e/dev/cache']) {
    assert.ok(shard.includes(`path: ${p}`), `caches ${p}`)
  }
  assert.equal((shard.match(/uses: actions\/cache\/restore@v4/g) ?? []).length, 2)
  const saves = [...shard.matchAll(/- (?:name: .*\n\s+)?if: (.*)\n\s+uses: actions\/cache\/save@v4/g)]
  assert.equal(saves.length, 2, 'two save steps')
  for (const s of saves) assert.match(s[1], /matrix\.shard == 1/, 'only shard 1 saves, so the shards never race for one key')
  assert.match(shard, /key: next-e2e-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('pnpm-lock\.yaml'\) \}\}-/)
  assert.match(shard, /key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('pnpm-lock\.yaml'\) \}\}/)
})
