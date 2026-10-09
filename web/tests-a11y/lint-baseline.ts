// jsx-a11y lint gate with a per-violation baseline (issue #43).
//
//   pnpm --dir web run lint:a11y             fail on new violations and on fixed-but-still-listed ones
//   pnpm --dir web run lint:a11y -- --write  rewrite lint-baseline.json from the current results
//
// eslint.config.mjs enables the strict preset with no per-file overrides, so a new
// violation anywhere (including in a file that already has other violations) fails here.
import fs from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'
import {
  compareLint, rebuildBaseline, validateLintBaseline,
  type LintBaselineEntry, type LintFinding,
} from './lint-baseline-compare'

const webRoot = path.resolve(__dirname, '..')
const baselinePath = path.join(__dirname, 'lint-baseline.json')
const write = process.argv.includes('--write')

async function main() {
  const baseline: LintBaselineEntry[] = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))

  const eslint = new ESLint({ cwd: webRoot, overrideConfigFile: path.join(webRoot, 'eslint.config.mjs') })
  const results = await eslint.lintFiles(['.'])

  const fatal = results.flatMap(r => r.messages.filter(m => m.fatal).map(m => `${r.filePath}: ${m.message}`))
  if (fatal.length) {
    console.error(`ESLint could not parse some files:\n${fatal.join('\n')}`)
    process.exit(2)
  }

  const findings: LintFinding[] = results.flatMap(r =>
    r.messages
      .filter(m => m.ruleId?.startsWith('jsx-a11y/'))
      .map(m => ({ file: path.relative(webRoot, r.filePath).split(path.sep).join('/'), rule: m.ruleId as string })),
  )

  if (write) {
    const next = rebuildBaseline(findings, baseline)
    fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
    const missing = next.filter(e => e.issue <= 0)
    console.log(`lint-baseline.json rewritten: ${next.length} entries.`)
    if (missing.length) {
      console.log(`Set the "issue" field of: ${missing.map(e => `${e.file} ${e.rule}`).join('; ')}`)
    }
    return
  }

  const errors = validateLintBaseline(baseline, JSON.parse(fs.readFileSync(path.join(__dirname, 'open-baseline-issues.json'), 'utf8')).open)
  const { unexpected, stale } = compareLint(findings, baseline)
  if (!errors.length && !unexpected.length && !stale.length) {
    console.log(`jsx-a11y: ${findings.length} known violations, none new, none fixed-but-listed.`)
    return
  }
  if (errors.length) console.error(`lint-baseline.json is malformed:\n  ${errors.join('\n  ')}`)
  if (unexpected.length) {
    console.error(`New jsx-a11y violations (fix them; do not add them to the baseline unless an issue tracks them):\n  ${unexpected.join('\n  ')}`)
  }
  if (stale.length) {
    console.error(`Baseline entries that are fixed (or partly fixed):\n  ${stale.join('\n  ')}`)
  }
  console.error(
    '\nTo update web/tests-a11y/lint-baseline.json: fix the code, then run\n' +
    '  pnpm --dir web run lint:a11y -- --write\n' +
    'and review the diff (the baseline may only shrink unless a new issue number is added by hand).',
  )
  process.exit(1)
}

main().catch(err => { console.error(err); process.exit(2) })
