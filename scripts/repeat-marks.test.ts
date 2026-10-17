// Loop and repeat marks on the agent nodes (#377). A node is marked only when the simulation proves it:
// a loop verdict (lib/loop-detection, existing thresholds) or a repeated read / call in the ledger (lib/waste).
// The loop wins (one mark per node); nothing is said for an agent with no proof, never a bare "healthy".
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument } from './canvas-recorder'
import { repeatMarks, repeatMarkText, REPEAT_RULE_TEXT, type RepeatMark } from '../web/lib/repeat-marks'
import type { HealthVerdict, LoopFinding } from '../web/lib/loop-detection'
import { emptyWasteLedger, recordToolStart, type WasteLedger } from '../web/lib/waste'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { REPEAT_BADGE_DRAW, ORCHESTRATOR_DRAW, AGENT_DRAW } from '../web/lib/canvas-constants'
import { NODE } from '../web/lib/agent-types'
import { LIVE_ENTRY_TEXT } from '../web/lib/live-tour'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'

stubDocument()

const finding = (over: Partial<LoopFinding> = {}): LoopFinding =>
  ({ kind: 'repeat', toolName: 'Read', count: 3, atLeast: false, toolUseIds: ['a', 'b', 'c'], ...over }) as LoopFinding
const verdict = (status: HealthVerdict['status'], findings: LoopFinding[] = []): HealthVerdict =>
  ({ status, findings, calls: 3, comparable: 3, dropped: 0, lostEvents: 0 })

function readTwice(ledger: WasteLedger, agentId: string, path = '/repo/a.ts', times = 2): WasteLedger {
  let l = ledger
  for (let i = 0; i < times; i++) {
    l = recordToolStart(l, { sessionId: 's1', agentId, toolName: 'Read', inputData: { file_path: path }, toolUseId: `${agentId}-${path}-${i}`, toolCallId: `t-${agentId}-${path}-${i}`, time: i })
  }
  return l
}

test('no proof, no mark: clear, incomplete and unknown verdicts and an empty ledger mark nothing', () => {
  const health = new Map([['s1:a', verdict('clear')], ['s1:b', verdict('incomplete')], ['s1:c', verdict('unknown')]])
  assert.equal(repeatMarks(health, emptyWasteLedger(), ['s1:a', 's1:b', 's1:c']).size, 0)
  assert.equal(repeatMarks(undefined, undefined, ['s1:a']).size, 0)
})

test('a proven loop marks its agent with the findings of the verdict', () => {
  const f = finding()
  const marks = repeatMarks(new Map([['s1:a', verdict('loop', [f])]]), emptyWasteLedger(), ['s1:a'])
  assert.deepEqual(marks.get('s1:a'), { kind: 'loop', findings: [f] })
})

test('one repeated read (the ledger rule: a second identical call) marks its agent as repeated', () => {
  const marks = repeatMarks(new Map(), readTwice(emptyWasteLedger(), 's1:a'), ['s1:a'])
  const mark = marks.get('s1:a')
  assert.equal(mark?.kind, 'repeated')
  assert.equal(mark?.kind === 'repeated' && mark.items[0].repeats, 1)
})

test('a single read is not a repeat: no mark', () => {
  assert.equal(repeatMarks(new Map(), readTwice(emptyWasteLedger(), 's1:a', '/repo/a.ts', 1), ['s1:a']).size, 0)
})

test('the loop wins over the repeats: one mark per node', () => {
  const marks = repeatMarks(new Map([['s1:a', verdict('loop', [finding()])]]), readTwice(emptyWasteLedger(), 's1:a'), ['s1:a'])
  assert.equal(marks.get('s1:a')?.kind, 'loop')
  assert.equal(marks.size, 1)
})

test('only the agents of the drawn scene are marked (a hidden or filtered agent proves nothing)', () => {
  const health = new Map([['s1:hidden', verdict('loop', [finding()])]])
  const marks = repeatMarks(health, readTwice(emptyWasteLedger(), 's1:gone'), ['s1:a'])
  assert.equal(marks.size, 0)
})

test('the repeats of one agent are listed costliest first, and never attributed to another agent', () => {
  let l = readTwice(emptyWasteLedger(), 's1:a', '/repo/a.ts', 2)
  l = readTwice(l, 's1:a', '/repo/b.ts', 4)
  l = readTwice(l, 's1:b', '/repo/c.ts', 2)
  const marks = repeatMarks(new Map(), l, ['s1:a', 's1:b'])
  const a = marks.get('s1:a') as Extract<RepeatMark, { kind: 'repeated' }>
  assert.deepEqual(a.items.map(i => i.target), ['/repo/b.ts', '/repo/a.ts'])
  const b = marks.get('s1:b') as Extract<RepeatMark, { kind: 'repeated' }>
  assert.deepEqual(b.items.map(i => i.target), ['/repo/c.ts'])
})

test('text of a loop mark: the verdict word, then the evidence (at most two findings, "at least" kept)', () => {
  const t = repeatMarkText({ kind: 'loop', findings: [finding({ atLeast: true }), finding({ toolName: 'Glob' }), finding({ toolName: 'Bash' })] })
  assert.equal(t.short, 'loop observed')
  assert.equal(t.detail, 'Loop observed: Read called at least 3× in a row with the same input; Glob called 3× in a row with the same input; and 1 more in the Health section of the agent card.')
})

test('text of a repeat mark: a fact, never "wasted", and no file path (presentation mode, long paths)', () => {
  let l = readTwice(emptyWasteLedger(), 's1:a', '/secret/path/a.ts', 3)
  l = readTwice(l, 's1:a', '/secret/path/b.ts', 2)
  const mark = repeatMarks(new Map(), l, ['s1:a']).get('s1:a')!
  const t = repeatMarkText(mark)
  assert.equal(t.short, 'repeated reads observed')
  assert.equal(t.detail, 'Repeated reads observed: read again 2 times, no edit seen in between; and 1 more in the Files panel.')
  assert.ok(!/waste/i.test(t.detail + t.short))
  assert.ok(!t.detail.includes('/secret'))
})

test('the words of a repeat mark follow the evidence: reads, calls, or both', () => {
  const run = (l: WasteLedger, id: string, i: number) =>
    recordToolStart(l, { sessionId: 's1', agentId: id, toolName: 'Bash', inputData: { command: 'ls' }, toolUseId: `b${i}`, toolCallId: `tb${i}`, time: i })
  let calls = emptyWasteLedger()
  calls = run(run(calls, 's1:a', 0), 's1:a', 1)
  const callMark = repeatMarks(new Map(), calls, ['s1:a']).get('s1:a')!
  const c = repeatMarkText(callMark)
  assert.equal(c.short, 'repeated calls observed')
  assert.equal(c.detail, 'Repeated calls observed: same Bash command run again 1 time, right after itself.')
  const both = readTwice(calls, 's1:a', '/repo/z.ts', 2)
  const b = repeatMarkText(repeatMarks(new Map(), both, ['s1:a']).get('s1:a')!)
  assert.equal(b.short, 'repeated reads and calls observed')
})

test('the legend and the tour state the ledger rules, not a wider claim', () => {
  assert.equal(
    REPEAT_RULE_TEXT,
    'a file read again with no edit seen in between, the same Glob run again with no write seen in between, or the same Bash command run again right after itself',
  )
  assert.ok(LIVE_ENTRY_TEXT['mark-repeated'].includes(REPEAT_RULE_TEXT))
  assert.ok(!LIVE_ENTRY_TEXT['mark-repeated'].includes('would change the answer'))
})

// ─── The badge drawn on the node ───────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:worker'
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: 'worker', name: 'worker',
    state: 'idle', parentId: 's1:main', parentKey: 's1:main', tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 300, y: 300, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: Date.now(),
    ...over,
  }
}
const one = (a: any) => new Map([[a.id, a]])
const opts = (over: Record<string, unknown> = {}): any => ({ reducedMotion: true, zoom: 1, showCost: false, showStats: false, ...over })
const badgeArcs = (ops: { name: string; args: unknown[] }[], a: any) => {
  const r = NODE.radiusSub
  const cx = a.x - r * REPEAT_BADGE_DRAW.offset
  const cy = a.y - r * REPEAT_BADGE_DRAW.offset
  return ops.filter(o => o.name === 'arc' && Math.abs(Number(o.args[0]) - cx) < 0.5 && Math.abs(Number(o.args[1]) - cy) < 0.5)
}

test('drawAgents: no mark, no badge on the upper-left rim', () => {
  const a = agent()
  const rec = recordingContext(1)
  drawAgents(rec.ctx, one(a), null, null, false, 0, opts())
  assert.equal(badgeArcs(rec.ops, a).length, 0)
})

test('drawAgents: a loop and a repeat draw a badge on the upper-left rim, with two different shapes', () => {
  const a = agent()
  const loop = recordingContext(1)
  drawAgents(loop.ctx, one(a), null, null, false, 0, opts({ repeatMarks: new Map([[a.id, { kind: 'loop' }]]) }))
  const rep = recordingContext(1)
  drawAgents(rep.ctx, one(a), null, null, false, 0, opts({ repeatMarks: new Map([[a.id, { kind: 'repeated' }]]) }))
  assert.ok(badgeArcs(loop.ops, a).length > 0, 'loop badge drawn')
  assert.ok(badgeArcs(rep.ops, a).length > 0, 'repeat badge drawn')
  // The glyph differs by shape, not only by colour: the loop draws an open arc (the circular arrow), the repeat none
  const glyphArcs = (ops: typeof loop.ops) => badgeArcs(ops, a).filter(o => Math.abs(Number(o.args[4]) - Number(o.args[3])) < Math.PI * 1.99)
  assert.ok(glyphArcs(loop.ops).length > 0, 'loop: an open arc')
  assert.equal(glyphArcs(rep.ops).length, 0, 'repeat: no arc besides the disc')
})

test('drawAgents: the badge does not move with the animation clock (static under any motion setting)', () => {
  const a = agent({ state: 'complete' })
  const at = (time: number, reducedMotion: boolean) => {
    const rec = recordingContext(1)
    drawAgents(rec.ctx, one(a), null, null, false, time, opts({ reducedMotion, repeatMarks: new Map([[a.id, { kind: 'loop' }]]) }))
    return JSON.stringify(badgeArcs(rec.ops, a).map(o => o.args))
  }
  assert.equal(at(0, false), at(7.3, false))
  assert.equal(at(0, false), at(0, true))
})

test('drawAgents: the badge is a shape, drawn below the zoom where labels disappear', () => {
  const a = agent()
  const rec = recordingContext(0.1)
  drawAgents(rec.ctx, one(a), null, null, false, 0, opts({ zoom: 0.1, repeatMarks: new Map([[a.id, { kind: 'repeated' }]]) }))
  assert.ok(badgeArcs(rec.ops, a).length > 0)
  assert.ok(!rec.texts.some(t => t.text.includes('worker')), 'precondition: labels hidden')
})

test('badge geometry: its disc never meets the crown disc, the "+N" branch badge or the label, at any node size', () => {
  const disc = REPEAT_BADGE_DRAW.size + 2
  const crownDisc = ORCHESTRATOR_DRAW.badgeFontSize - 1 + 2
  for (const base of [NODE.radiusSub, NODE.radiusMain]) {
    for (const k of [0.8, 1, ORCHESTRATOR_DRAW.scale]) {
      const r = base * k
      const bx = -r * REPEAT_BADGE_DRAW.offset, by = -r * REPEAT_BADGE_DRAW.offset
      // Crown (upper right, same height) and teammate activity badge share (0.8r, -0.8r)
      assert.ok(Math.hypot(r * 0.8 - bx, -r * 0.8 - by) > disc + crownDisc, `crown, r=${r}`)
      // "+N" badge starts at (0.55r, 0.55r) and grows right / down
      assert.ok(bx + disc < r * 0.55 || by + disc < r * 0.55, `+N badge, r=${r}`)
      // Label starts under the node
      assert.ok(by + disc < r + AGENT_DRAW.labelYOffset, `label, r=${r}`)
    }
  }
})

// ─── Screen-reader outline ─────────────────────────────────────────────────

test('outline: an agent with a mark carries its text, an agent without one carries nothing', () => {
  const a = agent({ id: 's1:a', name: 'alpha' })
  const b = agent({ id: 's1:b', name: 'beta' })
  const marks = repeatMarks(new Map([['s1:a', verdict('loop', [finding()])]]), emptyWasteLedger(), ['s1:a', 's1:b'])
  const model = buildA11yModel(new Map([[a.id, a], [b.id, b]]), new Map(), [], new Map(), { repeatMarks: marks })
  const itemA = model.agents.find(x => x.id === 's1:a')!
  const itemB = model.agents.find(x => x.id === 's1:b')!
  assert.deepEqual(itemA.repeats, { kind: 'loop', short: 'loop observed', detail: 'Loop observed: Read called 3× in a row with the same input.' })
  assert.ok(!('repeats' in itemB), 'no "no loop" in the outline')
})
