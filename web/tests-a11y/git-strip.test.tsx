// Git strip of the agent card (#386): branch, commits and PR states in words, each from an observed output,
// reachable by keyboard, axe-clean; nothing rendered when nothing was observed.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within } from '@testing-library/react'
import axe from 'axe-core'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'
import type { GitState } from '@/lib/git-state'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })
const base = { id: 's1:main', name: 'Main', state: 'idle' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 3, timeAlive: 100, spawnTime: 10, lastEventAt: NOW, freshnessSource: 'live' as const }
const noop = () => {}

const git: GitState = {
  head: { ref: { kind: 'branch', name: 'feat/386-git-strip' }, source: 'commit', callId: 'c2', time: 72 },
  commits: [
    { sha: 'abc1234', branch: 'feat/386-git-strip', message: 'test: git strip (#386)', amend: false, callId: 'c2', toolUseId: 'u2', time: 72 },
    { sha: 'def5678', branch: 'feat/386-git-strip', message: 'feat: git strip (#386)', amend: true, callId: 'c3', time: 80 },
  ],
  omittedCommits: 3,
  prs: [
    { number: 12, repo: 'o/r', url: 'https://github.com/o/r/pull/12', state: 'merged', callId: 'c4', time: 130 },
    { number: 13, repo: null, state: 'closed', callId: 'c5', time: 140 },
  ],
  omittedPrs: 0,
  seen: ['c2', 'c3', 'c4', 'c5'],
}

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('nothing observed: no git strip at all (no default branch)', () => {
  const v = render(<AgentDetailCard agent={base} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.queryByTestId('git-strip'), null)
})

test('the strip names itself, says the branch in words and where it was seen', () => {
  const v = render(<AgentDetailCard agent={{ ...base, git }} onClose={noop} freshnessClock={clock} />)
  const strip = within(v.getByRole('region', { name: 'Git (observed)' }))
  const branch = strip.getByTestId('git-branch').textContent ?? ''
  assert.match(branch, /feat\/386-git-strip/)
  assert.match(branch, /git commit/)
  assert.match(branch, /\+1:02/)
})

test('a detached HEAD is said in words', () => {
  const v = render(<AgentDetailCard agent={{ ...base, git: { ...git, head: { ref: { kind: 'detached' }, source: 'status', callId: 'c1', time: 20 } } }} onClose={noop} freshnessClock={clock} />)
  assert.match(v.getByTestId('git-branch').textContent ?? '', /detached HEAD/)
})

test('commits sit in a native disclosure (keyboard), with the count including the ones not kept', () => {
  const v = render(<AgentDetailCard agent={{ ...base, git }} onClose={noop} freshnessClock={clock} />)
  const summary = v.getByText(/5 commits observed/)
  assert.equal(summary.tagName, 'SUMMARY')
  const list = v.getByRole('list', { name: 'Commits observed' })
  const items = within(list).getAllByRole('listitem').map(li => li.textContent)
  assert.match(items[0] ?? '', /abc1234 test: git strip/)
  assert.match(items[1] ?? '', /def5678.*amended/)
  assert.match(v.getByTestId('git-commits').textContent ?? '', /3 earlier commits not kept/)
})

test('PR states are words, the PR link has an accessible name; a PR without URL is plain text', () => {
  const v = render(<AgentDetailCard agent={{ ...base, git }} onClose={noop} freshnessClock={clock} />)
  const link = v.getByRole('link', { name: /PR #12 \(o\/r\) merged/ })
  assert.equal(link.getAttribute('href'), 'https://github.com/o/r/pull/12')
  const prs = within(v.getByRole('list', { name: 'Pull requests observed' })).getAllByRole('listitem').map(li => li.textContent)
  assert.match(prs[1] ?? '', /PR #13.*closed/)
})

test('the strip is axe-clean', async () => {
  const v = render(<AgentDetailCard agent={{ ...base, git }} onClose={noop} freshnessClock={clock} />)
  assert.deepEqual(await violations(v.getByTestId('git-strip')), [])
})
