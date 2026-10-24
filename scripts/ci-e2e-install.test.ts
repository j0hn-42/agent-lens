// Étape d'installation de Chromium des tranches e2e-a11y (#440, #575): un miroir apt lent ne doit plus consommer
// le timeout du job ni annuler les tests. Le test lit le YAML, il ne lance rien.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(__dirname, '..')
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

function job(id: string): string {
  const m = ci.match(new RegExp(`^  ${id}:\\n((?:(?:    .*|\\s*)\\n)*)`, 'm'))
  assert.ok(m, `ci.yml defines the job ${id}`)
  return m[1]
}

/** Text of a step (6-space "- name:"), up to the next step or comment line at the same level. */
function step(jobText: string, name: string): string {
  const start = jobText.indexOf(`      - name: ${name}\n`)
  assert.ok(start >= 0, `step "${name}" exists`)
  const rest = jobText.slice(start + 1)
  const next = rest.search(/\n      (?:- |#)/)
  return next < 0 ? rest : rest.slice(0, next)
}

const shard = job('e2e-a11y-shard')
const install = step(shard, 'Install Chromium for Playwright')
const tests = step(shard, 'Browser accessibility tests (Playwright + axe-core)')

test('the system packages are installed only when ldd proves a library is missing (#440)', () => {
  assert.doesNotMatch(install, /install --with-deps/, 'no unconditional apt download on every run')
  assert.match(install, /playwright install chromium/)
  assert.match(install, /ldd /)
  assert.match(install, /not found/)
  assert.match(install, /playwright install-deps chromium/)
  assert.ok(install.indexOf('ldd ') < install.indexOf('install-deps chromium'), 'install-deps comes after the ldd check')
})

test('the install step has its own short timeout and exactly one new attempt (#440)', () => {
  const t = install.match(/^\s+timeout-minutes: (\d+)$/m)
  assert.ok(t, 'the install step has timeout-minutes')
  assert.ok(Number(t[1]) <= 5, 'short: a slow mirror is a readable install failure')
  assert.match(install, /for attempt in 1 2/, 'one retry, no more')
})

test('the tests step has its own timeout and both budgets fit in the job timeout (#440)', () => {
  const tt = tests.match(/^\s+timeout-minutes: (\d+)$/m)
  const it = install.match(/^\s+timeout-minutes: (\d+)$/m)
  const jt = shard.match(/^    timeout-minutes: (\d+)$/m)
  assert.ok(tt && it && jt, 'install, tests and job all have timeout-minutes')
  assert.ok(Number(it[1]) + Number(tt[1]) < Number(jt[1]), 'install + tests stay under the job timeout, with room for setup')
})

test('the install step logs its duration and what it decided, retry included (#440)', () => {
  assert.match(install, /SECONDS/, 'measures its duration')
  assert.match(install, /duration/i)
  assert.match(install, /missing librar/i, 'logs the ldd decision')
  assert.match(install, /attempt \$attempt/, 'logs each attempt, so a retry is visible')
})

test('the browser cache is still saved only by shard 1 after a successful install (#440)', () => {
  const save = step(shard, 'Save Playwright browser')
  assert.match(save, /matrix\.shard == 1/)
  assert.match(save, /steps\.playwright-install\.outcome == 'success'/)
  assert.match(save, /cache-hit != 'true'/)
  assert.match(install, /^\s+id: playwright-install$/m)
})

test('the step does not claim that ldd proves no apt package is needed: it only sees linked libraries (#440)', () => {
  const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8')
  const wrong = /ldd (proves|shows) that no (apt )?package|proves? (that )?no (apt )?package is needed|no system package is needed/i
  assert.doesNotMatch(install, wrong)
  assert.doesNotMatch(shard, wrong)
  assert.doesNotMatch(contributing, wrong)
  // what is true is said where the step is: only linked libraries are checked, fonts and xvfb are no longer installed
  const comment = shard.slice(shard.indexOf('# The apt packages'), shard.indexOf('      - name: Install Chromium for Playwright'))
  assert.match(comment, /only (checks|sees|verifies) the linked libraries/i, 'says what ldd covers')
  assert.match(comment, /fonts/i, 'says the font packages are no longer installed')
  assert.match(comment, /xvfb/i)
  const line = contributing.split('\n').find(l => l.includes('ms-playwright'))
  assert.ok(line, 'CONTRIBUTING describes the Playwright cache')
  assert.match(line, /fonts/i)
  assert.match(line, /xvfb/i)
})

test('the internal time limits add up to less than the timeout of the step, so the fallback error message is printed (#440)', () => {
  const stepMinutes = Number(install.match(/^\s+timeout-minutes: (\d+)$/m)![1])
  const limits = [...install.matchAll(/timeout (\d+) /g)].map(m => Number(m[1]))
  assert.ok(limits.length >= 2, 'install and install-deps both have a limit')
  // the install loop runs twice with the first limit; install-deps has the last one
  const total = limits[0] * 2 + limits[limits.length - 1]
  assert.ok(total < stepMinutes * 60, `${total} s of internal limits must stay under ${stepMinutes * 60} s of the step`)
})

test('a failing ldd is told apart from an absence of "not found" (#440)', () => {
  assert.match(install, /ldd failed|ldd could not/i, 'a failure of ldd is reported')
  assert.doesNotMatch(install, /ldd "\$bin" 2>&1 \| grep/, 'ldd output is not piped straight into grep (pipefail would hide its failure)')
})
