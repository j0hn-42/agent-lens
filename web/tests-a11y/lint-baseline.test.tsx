// Unit tests for the lint baseline comparison (issue #43). The ESLint run itself is
// `pnpm --dir web run lint:a11y`; these cover the allow-list logic.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { compareLint, rebuildBaseline, validateLintBaseline, type LintBaselineEntry } from './lint-baseline-compare'

const R = 'jsx-a11y/no-noninteractive-tabindex'
const base: LintBaselineEntry[] = [{ file: 'a.tsx', rule: R, count: 1, issue: 13 }]

test('the committed lint baseline is well formed', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'lint-baseline.json'), 'utf8'))
  assert.deepEqual(validateLintBaseline(real), [])
})

test('every lint baseline entry cites an open issue', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'lint-baseline.json'), 'utf8'))
  const { open } = JSON.parse(fs.readFileSync(path.join(__dirname, 'open-baseline-issues.json'), 'utf8'))
  assert.deepEqual(validateLintBaseline(real, open), [])
})

test('validateLintBaseline rejects an issue that is not in the open list', () => {
  assert.equal(validateLintBaseline(base, [1]).length, 1)
  assert.deepEqual(validateLintBaseline(base, [13]), [])
})

test('a second violation of a listed rule in the same file is new', () => {
  const r = compareLint([{ file: 'a.tsx', rule: R }, { file: 'a.tsx', rule: R }], base)
  assert.equal(r.unexpected.length, 1)
  assert.deepEqual(r.stale, [])
})

test('a violation in an unlisted file or of an unlisted rule is new', () => {
  assert.equal(compareLint([{ file: 'a.tsx', rule: R }, { file: 'b.tsx', rule: R }], base).unexpected.length, 1)
  assert.equal(compareLint([{ file: 'a.tsx', rule: R }, { file: 'a.tsx', rule: 'jsx-a11y/x' }], base).unexpected.length, 1)
})

test('a fixed violation makes its entry stale', () => {
  const r = compareLint([], base)
  assert.deepEqual(r.unexpected, [])
  assert.equal(r.stale.length, 1)
  assert.equal(compareLint([{ file: 'a.tsx', rule: R }], base).stale.length, 0)
})

test('rebuildBaseline keeps issues, drops fixed entries and flags new ones with issue 0', () => {
  const next = rebuildBaseline([{ file: 'a.tsx', rule: R }, { file: 'b.tsx', rule: R }], base)
  assert.deepEqual(next.map(e => [e.file, e.issue]), [['a.tsx', 13], ['b.tsx', 0]])
  assert.equal(validateLintBaseline(next).length, 1)
  assert.deepEqual(rebuildBaseline([], base), [])
})

test('validateLintBaseline rejects bad counts, issues and duplicates', () => {
  assert.equal(validateLintBaseline([{ file: 'a', rule: 'r', count: 0, issue: 1 }]).length, 1)
  assert.equal(validateLintBaseline([{ file: 'a', rule: 'r', count: 1, issue: 0 }]).length, 1)
  const dup = { file: 'a', rule: 'r', count: 1, issue: 1 }
  assert.equal(validateLintBaseline([dup, dup]).length, 1)
})
