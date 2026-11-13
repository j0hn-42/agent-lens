// Burrow view: delegation is read from the observed link messages only (dispatch, return, teammate message).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMailState, linksSignature, newMail, openDelegations, relativesOf, treeOrder } from '../web/lib/burrow/burrow-links'
import type { AgentLink, ConversationMessage } from '../web/hooks/simulation/types'

let n = 0
const msg = (type: ConversationMessage['type'], from: string, to: string, toolUseId?: string): ConversationMessage =>
  ({ id: `m${++n}`, type, content: '', timestamp: n, from, to, ...(toolUseId ? { toolUseId } : {}) })
const link = (from: string, to: string, messages: ConversationMessage[], kind: AgentLink['kind'] = 'spawn'): AgentLink =>
  ({ id: `edge-${from}-${to}`, from, to, kind, sessionId: 's', messages, dropped: 0 })
const links = (...ls: AgentLink[]) => new Map(ls.map((l) => [l.id, l]))

test('newMail: the history is not replayed, then each new dispatch, return and message is delivered once', () => {
  const st = createMailState()
  const l = link('p', 'c', [msg('dispatch', 'p', 'c', 't1')])
  assert.deepEqual(newMail(links(l), st), [])
  l.messages.push(msg('return', 'c', 'p', 't1'), msg('tool_call', 'c', 'p'))
  const got = newMail(links(l), st)
  assert.deepEqual(got.map((m) => [m.kind, m.from, m.to]), [['return', 'c', 'p']])
  assert.deepEqual(newMail(links(l), st), [])
  const team = link('x', 'y', [], 'teammate')
  team.messages.push(msg('message', 'x', 'y'))
  assert.deepEqual(newMail(links(l, team), st).map((m) => m.kind), ['message'])
})

test('linksSignature changes when a message is added', () => {
  const l = link('p', 'c', [])
  const before = linksSignature(links(l))
  l.messages.push(msg('dispatch', 'p', 'c'))
  assert.notEqual(linksSignature(links(l)), before)
  assert.equal(linksSignature(undefined), '')
})

test('openDelegations: a dispatch without its return counts once per live sub-agent', () => {
  const live = new Set(['c1', 'c2', 'c3'])
  const ls = links(
    link('p', 'c1', [msg('dispatch', 'p', 'c1', 't1')]),
    link('p', 'c2', [msg('dispatch', 'p', 'c2', 't2'), msg('return', 'c2', 'p', 't2')]),
    link('p', 'c3', [msg('dispatch', 'p', 'c3', 't3'), msg('dispatch', 'p', 'c3', 't4')]),
    link('q', 'done', [msg('dispatch', 'q', 'done', 't5')]),
    link('x', 'c1', [msg('message', 'x', 'c1')], 'teammate'),
  )
  const open = openDelegations(ls, (k) => live.has(k))
  assert.equal(open.get('p'), 2, 'c1 and c3 still out, c2 returned')
  assert.equal(open.has('q'), false, 'a finished sub-agent without a recorded return is not counted')
  assert.equal(open.has('x'), false, 'teammate messages are not delegations')
})

test('relativesOf: the parent and the children that are drawn', () => {
  const agents = new Map([['p', { parentId: null }], ['c1', { parentId: 'p' }], ['c2', { parentId: 'p' }], ['g', { parentId: 'c1' }]])
  assert.deepEqual(relativesOf('p', agents, () => true), ['c1', 'c2'])
  assert.deepEqual(relativesOf('c1', agents, () => true), ['p', 'g'])
  assert.deepEqual(relativesOf('p', agents, (k) => k !== 'c2'), ['c1'])
})

test('treeOrder: sub-agents follow their orchestrator, one level deeper; an orphan or a cycle stays listed once', () => {
  const rows = [
    { id: 'c1', parentId: 'p' }, { id: 'x', parentId: null }, { id: 'p', parentId: null },
    { id: 'g', parentId: 'c1' }, { id: 'o', parentId: 'unknown' }, { id: 'k1', parentId: 'k2' }, { id: 'k2', parentId: 'k1' },
  ]
  const out = treeOrder(rows)
  assert.deepEqual(out.map((r) => `${r.id}:${r.depth}`), ['x:0', 'p:0', 'c1:1', 'g:2', 'o:0', 'k1:0', 'k2:1'])
})
