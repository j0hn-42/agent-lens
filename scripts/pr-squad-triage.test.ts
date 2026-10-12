// #329: the PR squad sorts open PRs by what they wait on, from facts only.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { classifyPr, renderReport, type GhPr } from './pr-squad-triage'

const green = [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const pr = (over: Partial<GhPr> = {}): GhPr => ({
  number: 1,
  title: 't',
  isDraft: false,
  headRefName: 'feat/x',
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  labels: [],
  statusCheckRollup: green,
  ...over,
})

test('running or queued checks: waiting on CI', () => {
  for (const status of ['IN_PROGRESS', 'QUEUED', 'PENDING']) {
    const r = classifyPr(pr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status, conclusion: '' }] }))
    assert.equal(r.state, 'waiting-ci')
    assert.equal(r.waitingOn, 'ci')
  }
})

test('a cancelled run is not red: wait, do not ask for a fix', () => {
  const r = classifyPr(pr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'CANCELLED' }] }))
  assert.equal(r.state, 'waiting-ci')
})

test('failed check, failed status context, conflicts or requested changes: needs a fix', () => {
  const failed = classifyPr(pr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }))
  assert.equal(failed.state, 'needs-fix')
  assert.match(failed.reason, /ci/)
  assert.equal(classifyPr(pr({ statusCheckRollup: [{ __typename: 'StatusContext', context: 'x', state: 'ERROR' }] })).state, 'needs-fix')
  assert.equal(classifyPr(pr({ mergeable: 'CONFLICTING' })).state, 'needs-fix')
  assert.equal(classifyPr(pr({ reviewDecision: 'CHANGES_REQUESTED' })).state, 'needs-fix')
  assert.equal(failed.waitingOn, 'author')
})

test('a failure outranks pending checks', () => {
  const r = classifyPr(pr({ statusCheckRollup: [
    { __typename: 'CheckRun', name: 'a', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'FAILURE' },
  ] }))
  assert.equal(r.state, 'needs-fix')
})

test('green draft: review by the squad; green ready PR: a human decides', () => {
  assert.equal(classifyPr(pr({ isDraft: true })).state, 'draft-review')
  assert.equal(classifyPr(pr({ isDraft: true })).waitingOn, 'squad')
  assert.equal(classifyPr(pr()).state, 'awaiting-review')
  assert.equal(classifyPr(pr({ reviewDecision: 'APPROVED' })).state, 'ready-for-human')
  assert.equal(classifyPr(pr({ reviewDecision: 'APPROVED' })).waitingOn, 'human')
})

test('no checks reported: unknown, never called green', () => {
  const r = classifyPr(pr({ statusCheckRollup: [] }))
  assert.equal(r.state, 'no-checks')
  assert.equal(r.waitingOn, 'human')
})

test('agent label is carried over, absent when missing', () => {
  assert.equal(classifyPr(pr({ labels: [{ name: 'agent:qa-engineer' }] })).role, 'qa-engineer')
  assert.equal(classifyPr(pr()).role, undefined)
})

test('report groups PRs by who they wait on and lists nothing it did not read', () => {
  const md = renderReport([
    pr({ number: 7, title: 'mine', reviewDecision: 'APPROVED' }),
    pr({ number: 8, title: 'broken', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }),
  ])
  assert.match(md, /Waiting on you/)
  assert.match(md, /#7/)
  assert.match(md, /Waiting on the PR author/)
  assert.match(md, /#8/)
  assert.doesNotMatch(md, /Waiting on CI/)
  assert.match(renderReport([]), /No open PR/)
})
