// Runs one shard of the e2e suite (#611): `E2E_SHARD=2/4 pnpm --dir web run test:e2e:shard`.
// Prints the files of the shard, runs them like `test:e2e` (one at a time, each starting its own demo server and
// writing test-results/demo-server-<file>.log, #581), then writes the shard's totals to the GitHub job summary.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assignShards, e2eFiles, loadWeights, parseShardSpec, shardTestArgs, summarizeTap } from './shards'

const WEB_DIR = path.resolve(__dirname, '..', '..')

const { index, total } = parseShardSpec(process.env.E2E_SHARD)
const files = assignShards(e2eFiles(), loadWeights(), total)[index - 1]
const tapFile = path.join('test-results', `e2e-shard-${index}.tap`)
fs.mkdirSync(path.join(WEB_DIR, 'test-results'), { recursive: true })

console.log(`e2e shard ${index}/${total}: ${files.length} file(s)\n${files.map(f => `  ${f}`).join('\n')}\n`)

const child = spawn(process.execPath, shardTestArgs(files, tapFile, process.stdout.isTTY ? 'spec' : 'tap'), {
  cwd: WEB_DIR,
  stdio: 'inherit',
})
child.on('exit', (code, signal) => {
  let tap = ''
  try { tap = fs.readFileSync(path.join(WEB_DIR, tapFile), 'utf8') } catch { /* no report: the run died first */ }
  const totals = summarizeTap(tap)
  const line = totals
    ? `tests ${totals.tests}, pass ${totals.pass}, fail ${totals.fail}, cancelled ${totals.cancelled}, skipped ${totals.skipped}, todo ${totals.todo}`
    : 'no totals: the test run ended before its report'
  console.log(`\ne2e shard ${index}/${total}: ${line}`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    fs.appendFileSync(summary, `### e2e shard ${index}/${total}\n\n${line}\n\n${files.map(f => `- \`${f}\``).join('\n')}\n`)
  }
  process.exit(code ?? (signal ? 1 : 0))
})
