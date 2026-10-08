import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildAgentForests, buildSessionRows, type AgentLike, type AgentNode } from '../web/lib/session-tree'
import { agentCost } from '../web/lib/cost'
import { usageFromAgent } from '../web/lib/usage'
import {
  rollupBranch, rollupFamily, rollupRows, formatRollup, ROLLUP_MAX_DEPTH, ROLLUP_UNKNOWN_TEXT, ROLLUP_INCOMPLETE_TEXT,
} from '../web/lib/cost-rollup'

type A = AgentLike & { model?: string }
const agent = (id: string, parentKey: string | null, tokensUsed: unknown, over: Partial<A> = {}): A => ({
  id, sessionId: id.split(':')[0], parentKey, name: id, state: 'idle', tokensUsed: tokensUsed as number, tokenStatus: 'available', spawnTime: 0, ...over,
})
const node = (a: A, children: AgentNode<A>[] = []): AgentNode<A> => ({ agent: a, children })
const session = (id: string, teamName?: string) => ({ id, label: id, status: 'active' as const, startTime: 0, lastActivityTime: 0, teamName })

test('branch total adds the orchestrator and every sub-agent once, each priced with its own model', () => {
  const tree = node(agent('s:main', null, 1_000_000, { model: 'claude-opus-4-6' }), [
    node(agent('s:a', 's:main', 500_000, { model: 'claude-haiku-4-5' })),
    node(agent('s:b', 's:main', 250_000)),
  ])
  const t = rollupBranch(tree)
  assert.equal(t.tokens, 1_750_000)
  assert.equal(t.agents, 3)
  assert.equal(t.cost, agentCost(1_000_000, 'claude-opus-4-6') + agentCost(500_000, 'claude-haiku-4-5') + agentCost(250_000))
  assert.equal(t.complete, true)
  assert.equal(t.unknown, 0)
})

test('deep chains are summed without recursion limits up to the depth bound, then flagged incomplete', () => {
  // chain of `n` nodes, built bottom-up (no recursion)
  const chain = (n: number) => {
    let top = node(agent(`s:${n - 1}`, n > 1 ? `s:${n - 2}` : null, 1))
    for (let i = n - 2; i >= 0; i--) top = node(agent(`s:${i}`, i ? `s:${i - 1}` : null, 1), [top])
    return top
  }
  const ok = rollupBranch(chain(ROLLUP_MAX_DEPTH))
  assert.equal(ok.tokens, ROLLUP_MAX_DEPTH)
  assert.equal(ok.complete, true)
  const deep = rollupBranch(chain(ROLLUP_MAX_DEPTH + 50_000))
  assert.equal(deep.complete, false, 'the cut-off is never presented as a full total')
  assert.equal(deep.agents, ROLLUP_MAX_DEPTH)
})

test('a cycle in the tree is counted once and flagged incomplete', () => {
  const a = node(agent('s:a', null, 10)), b = node(agent('s:b', 's:a', 20))
  a.children.push(b)
  b.children.push(a)
  const t = rollupBranch(a)
  assert.equal(t.tokens, 30)
  assert.equal(t.agents, 2)
  assert.equal(t.complete, false)
})

test('an agent present under two branches (background agent) is counted once in the family', () => {
  const shared = agent('s:bg', 's:main', 400)
  const family = rollupFamily([
    node(agent('s:main', null, 100), [node(shared)]),
    node(agent('s:other', null, 50), [node(shared)]),
    node(shared),
  ])
  assert.equal(family.tokens, 550)
  assert.equal(family.agents, 3)
  assert.equal(family.complete, true, 'skipping a duplicate loses nothing')
})

test('unknown token counts are not zero: they are skipped, counted and propagate to every ancestor', () => {
  const tree = node(agent('s:main', null, 100), [
    node(agent('s:mid', 's:main', 50), [node(agent('s:leaf', 's:mid', undefined))]),
    node(agent('s:nan', 's:main', NaN)),
    node(agent('s:null', 's:main', null)),
    node(agent('s:neg', 's:main', -5)),
  ])
  const t = rollupBranch(tree)
  assert.equal(t.tokens, 150)
  assert.equal(t.unknown, 4)
  assert.equal(t.complete, false)
  const mid = rollupBranch(tree.children[0])
  assert.equal(mid.complete, false, 'the sub-branch with the gap is incomplete too')
  assert.equal(rollupBranch(tree.children[0].children[0]).known, 0)
})

test('a branch with only unknown data reads unknown, not 0', () => {
  const t = rollupBranch(node(agent('s:x', null, undefined)))
  assert.equal(t.known, 0)
  assert.equal(formatRollup(t), ROLLUP_UNKNOWN_TEXT)
  assert.notEqual(formatRollup(rollupBranch(node(agent('s:z', null, 0)))), ROLLUP_UNKNOWN_TEXT, 'a real zero stays a number')
})

test('formatRollup shows cost and tokens, and the incomplete badge', () => {
  const full = rollupBranch(node(agent('s:m', null, 1_000_000)))
  assert.equal(formatRollup(full), '$6.00 · 1M')
  const partial = rollupBranch(node(agent('s:m', null, 1_000_000), [node(agent('s:u', 's:m', null))]))
  assert.equal(formatRollup(partial), `$6.00 · 1M ${ROLLUP_INCOMPLETE_TEXT}`)
})

test('family: a root whose parent is not in the data marks the family incomplete', () => {
  const forests = buildAgentForests([agent('s:main', null, 10), agent('s:orphan', 's:gone', 5)])
  const t = rollupFamily(forests.get('s')!)
  assert.equal(t.tokens, 15)
  assert.equal(t.complete, false)
  assert.equal(rollupFamily([node(agent('s:main', null, 10))]).complete, true)
})

test('rollupRows: a session row totals its session, a team row the whole family without double counting', () => {
  const forests = buildAgentForests([
    agent('s1:main', null, 100, { sessionId: 's1' }), agent('s1:sub', 's1:main', 20, { sessionId: 's1' }),
    agent('s2:main', null, 300, { sessionId: 's2' }), agent('s3:main', null, 7, { sessionId: 's3' }),
  ])
  const rows = buildSessionRows([session('s1', 'T'), session('s2', 'T'), session('s3')], ['T'], forests)
  const totals = rollupRows(rows)
  assert.equal(totals.get('s1')!.tokens, 120)
  assert.equal(totals.get('s2')!.tokens, 300)
  assert.equal(totals.get('team:T')!.tokens, 420)
  assert.equal(totals.get('s3')!.tokens, 7)
})

test('an agent that never reported tokens is unknown, not a known 0 (the spawn placeholder)', () => {
  const t = rollupBranch(node(agent('s:main', null, 100), [node(agent('s:sub', 's:main', 0, { tokenStatus: 'unavailable' }))]))
  assert.equal(t.known, 1)
  assert.equal(t.unknown, 1)
  assert.equal(t.complete, false)
  assert.ok(formatRollup(t).includes(ROLLUP_INCOMPLETE_TEXT))
  const none = rollupBranch(node(agent('s:main', null, 0, { tokenStatus: 'unavailable' })))
  assert.equal(formatRollup(none), ROLLUP_UNKNOWN_TEXT, 'a session with nothing reported reads unknown, not 0')
  assert.equal(rollupBranch(node(agent('s:x', null, 0, { tokenStatus: undefined }))).known, 0, 'no evidence = unknown')
  assert.equal(rollupBranch(node(agent('s:y', null, 0))).known, 1, 'a reported 0 is a real 0')
})

test('rollupRows with the whole data: the team total covers hidden member sessions and flags missing ones', () => {
  const sessions = [session('s1', 'T'), session('s2', 'T'), session('s3', 'T')]
  const forests = buildAgentForests([
    agent('s1:main', null, 10, { sessionId: 's1' }), agent('s2:main', null, 20, { sessionId: 's2' }),
  ])
  // 'Active only' kept s1 alone: the rows hide s2 and s3
  const rows = buildSessionRows([sessions[0]], ['T'], forests)
  const filtered = rollupRows(rows)
  assert.equal(filtered.get('team:T')!.tokens, 10, 'rows alone only see s1')
  const whole = rollupRows(rows, { sessions, forests }).get('team:T')!
  assert.equal(whole.tokens, 30, 'hidden s2 still counts')
  assert.equal(whole.complete, false, 's3 has no agent data: incomplete')
  const full = rollupRows(rows, { sessions: sessions.slice(0, 2), forests }).get('team:T')!
  assert.equal(full.tokens, 30)
  assert.equal(full.complete, true)
})

test('a partial agent is counted as a lower bound: known, but the total is flagged incomplete', () => {
  const t = rollupBranch(node(agent('s:p', null, 40, { tokenStatus: 'partial' })))
  assert.equal(t.known, 1)
  assert.equal(t.tokens, 40)
  assert.equal(t.complete, false)
  assert.ok(formatRollup(t).includes(ROLLUP_INCOMPLETE_TEXT))
})

test('the branch rollup and the session usage read the same status (no divergence)', () => {
  for (const status of ['available', 'partial', 'unavailable'] as const) {
    const a = agent('s:x', null, 10, { tokenStatus: status })
    assert.equal(rollupBranch(node(a)).known === 1, usageFromAgent(a).value !== null, status)
  }
})

test('a total containing an estimated agent says "estimé"; exact agents do not', () => {
  const exact = rollupBranch(node(agent('s:a', null, 4000)))
  assert.equal(exact.estimated, false)
  assert.ok(!formatRollup(exact).includes('estimé'))
  const t = rollupBranch(node(agent('s:a', null, 1000), [node(agent('s:b', 's:a', 3000, { tokensEstimated: true }))]))
  assert.equal(t.estimated, true)
  assert.ok(formatRollup(t).includes('4k estimé'), formatRollup(t))
})
