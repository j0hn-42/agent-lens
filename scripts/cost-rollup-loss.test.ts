// #366: the totals of the Sessions panel (an agent, a branch, a session, a team family) are lower bounds when the relay
// could not replay events of a session they count: flagged incomplete ("≥", "(incomplete)"), never presented as complete.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { AgentLike, AgentNode, SessionRow } from '../web/lib/session-tree'
import { rollupBranch, rollupRows, rollupUnderLoss, branchReplayLost, ROLLUP_INCOMPLETE_HELP } from '../web/lib/cost-rollup'

type A = AgentLike & { model?: string }
const agent = (id: string, parentKey: string | null, over: Partial<A> = {}): A => ({
  id, sessionId: id.split(':')[0], parentKey, name: id, state: 'idle', tokensUsed: 1000, tokenStatus: 'available', spawnTime: 0, ...over,
})
const node = (a: A, children: AgentNode<A>[] = []): AgentNode<A> => ({ agent: a, children })
const session = (id: string, teamName?: string) => ({ id, label: id, status: 'active' as const, startTime: 0, lastActivityTime: 0, teamName })

test('rollupUnderLoss: nothing lost keeps the total as it is, a loss flags it incomplete without changing the sums', () => {
  const t = rollupBranch(node(agent('s1:main', null)))
  assert.equal(rollupUnderLoss(t, 0), t)
  const lossy = rollupUnderLoss(t, 3)
  assert.equal(lossy.complete, false)
  assert.equal(lossy.replayLoss, true, 'the cause is kept: the token sum is then no lower bound')
  assert.equal(t.replayLoss, undefined)
  assert.equal(lossy.tokens, t.tokens)
  assert.equal(lossy.cost, t.cost)
  assert.equal(t.complete, true, 'the input is not mutated')
})

test('branchReplayLost: the sessions of every agent of the branch, each counted once; other sessions are not', () => {
  const branch = node(agent('s1:main', null), [node(agent('s1:a', 's1:main')), node(agent('s2:b', 's1:main'))])
  assert.equal(branchReplayLost(branch, new Map([['s1', 4]])), 4, 's1 once, though two agents belong to it')
  assert.equal(branchReplayLost(branch, new Map([['s1', 4], ['s2', 1]])), 5)
  assert.equal(branchReplayLost(branch, new Map([['s9', 7]])), 0)
  assert.equal(branchReplayLost(branch, undefined), 0)
})

test('rollupRows: a session row and the family of its team are incomplete when that session lost events', () => {
  const s1 = [node(agent('s1:main', null))]
  const s2 = [node(agent('s2:main', null))]
  const rows: SessionRow[] = [
    { kind: 'team', id: 'team:T', teamName: 'T', roots: [] } as unknown as SessionRow,
    { kind: 'session', id: 's1', teamName: 'T', roots: s1 } as unknown as SessionRow,
    { kind: 'session', id: 's2', teamName: 'T', roots: s2 } as unknown as SessionRow,
  ]
  const whole = { sessions: [session('s1', 'T'), session('s2', 'T')], forests: new Map([['s1', s1], ['s2', s2]]) }
  const plain = rollupRows(rows, whole)
  assert.equal(plain.get('s1')!.complete, true)
  assert.equal(plain.get('team:T')!.complete, true)
  const lossy = rollupRows(rows, whole, new Map([['s2', 3]]))
  assert.equal(lossy.get('s1')!.complete, true, 'the loss of s2 is not s1\'s')
  assert.equal(lossy.get('s2')!.complete, false)
  assert.equal(lossy.get('team:T')!.complete, false, 'the family counts s2')
  assert.equal(lossy.get('team:T')!.cost, plain.get('team:T')!.cost)
})

test('the incomplete explanation names the replay loss among its causes, and claims no direction', () => {
  assert.match(ROLLUP_INCOMPLETE_HELP, /could not replay/)
  assert.match(ROLLUP_INCOMPLETE_HELP, /may differ/)
  assert.doesNotMatch(ROLLUP_INCOMPLETE_HELP, /is higher/)
})
