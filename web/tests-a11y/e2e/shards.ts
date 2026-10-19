// Splits the e2e suite (`tests-a11y/e2e/*.e2e.ts`, the glob of `test:e2e`) into shards the CI runs as parallel
// jobs (#611). The split is a partition: every file runs once, in exactly one shard, whatever its weight.
import fs from 'node:fs'
import path from 'node:path'

export const E2E_DIR = __dirname
const WEIGHTS_FILE = path.join(__dirname, 'shard-weights.json')

/** Weight given to a file the table does not know yet (a new test file): it still runs, in the lightest shard. */
export const DEFAULT_WEIGHT_S = 30

/** The e2e files, sorted: exactly what `node --test "tests-a11y/e2e/*.e2e.ts"` runs. */
export function e2eFiles(dir = E2E_DIR): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.e2e.ts')).sort()
}

/** Measured seconds per file (median of CI runs, see `_source` in shard-weights.json). */
export function loadWeights(file = WEIGHTS_FILE): Record<string, number> {
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { seconds: Record<string, number> }
  return json.seconds
}

/** Reads `i/n` (1 <= i <= n). Anything else throws, so a typo in the CI never runs an empty or partial shard. */
export function parseShardSpec(spec: string | undefined): { index: number; total: number } {
  const m = (spec ?? '').trim().match(/^(\d+)\/(\d+)$/)
  const index = m ? Number(m[1]) : NaN
  const total = m ? Number(m[2]) : NaN
  if (!m || total < 1 || index < 1 || index > total) throw new Error(`invalid shard "${String(spec)}": expected i/n with 1 <= i <= n (E2E_SHARD=2/4)`)
  return { index, total }
}

/**
 * Longest-first greedy split: files sorted by weight (then name, so the input order does not matter) each go to
 * the shard with the least weight so far (lowest index on a tie). Every file lands in exactly one shard.
 */
export function assignShards(files: string[], weights: Record<string, number>, total: number): string[][] {
  const w = (f: string) => weights[f] ?? DEFAULT_WEIGHT_S
  const sorted = [...new Set(files)].sort((a, b) => w(b) - w(a) || (a < b ? -1 : a > b ? 1 : 0))
  const shards: string[][] = Array.from({ length: total }, () => [])
  const sums = new Array<number>(total).fill(0)
  for (const f of sorted) {
    let best = 0
    for (let i = 1; i < total; i++) if (sums[i] < sums[best]) best = i
    shards[best].push(f)
    sums[best] += w(f)
  }
  return shards
}

/**
 * Arguments of the `node` process that runs one shard: the same runner as `test:e2e` (one file at a time, so one
 * demo server at a time), the usual stdout report, and a TAP copy for the totals.
 */
export function shardTestArgs(files: string[], tapFile: string, stdoutReporter = 'tap'): string[] {
  return [
    '--import', 'tsx', '--test', '--test-concurrency=1',
    `--test-reporter=${stdoutReporter}`, '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
    ...files.map(f => `tests-a11y/e2e/${f}`),
  ]
}

export type TapTotals = Record<'tests' | 'pass' | 'fail' | 'cancelled' | 'skipped' | 'todo', number>

/** Totals printed at the end of a `node --test` TAP report, or null when the report has none (the run died). */
export function summarizeTap(tap: string): TapTotals | null {
  const keys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const
  const out: Partial<TapTotals> = {}
  for (const k of keys) {
    const m = tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))
    if (!m) return null
    out[k] = Number(m[1])
  }
  return out as TapTotals
}
