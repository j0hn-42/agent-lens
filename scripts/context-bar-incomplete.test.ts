// #613 (review of PR 687): "190k / 200k tokens (incomplete)" under the context bar is ONE fillText, and in every theme it
// is drawn at 4.5:1 or more on its plate AND on the bare canvas ground (a plate as wide as the text, and the ground at its ends). The proof lives here (recording context, no browser) because
// the demo has no session that lost events, and a screenshot taken under the first-run tour card proves nothing.
import './canvas-recorder'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordingContext, type DrawnOp } from './canvas-recorder'
import { fixtureAgents, over, ratio, solid, parse } from './scene-fixture'
import { THEME_IDS, type ThemeId } from '../web/lib/theme-tokens'
import { SCENE } from '../web/lib/colors'
import { scenePalette } from '../web/lib/scene-state-colors'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'

function tokenLine(theme: ThemeId, lost: boolean, estimated = false): DrawnOp[] {
  const rec = recordingContext(1)
  const agents = fixtureAgents()
  // The longest form: an estimated figure ("95k estimated / 200k tokens (incomplete)")
  if (estimated) for (const a of agents.values()) { a.tokensEstimated = true; a.tokensUsed = 95_000 }
  const replayLost = lost ? new Map([['s1', 3]]) : undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = { reducedMotion: true, zoom: 1, showCost: false, showStats: true, showSessionLabels: true, theme, replayLost }
  drawAgents(rec.ctx, agents, null, 's1:worker', true, 0, opts, 1_000_000)
  return rec.ops.filter(o => o.name === 'fillText' && /tokens/.test(String(o.args[0])))
}

test('a session that lost events: the token line under the context bar is one text ending in (incomplete)', () => {
  const lines = tokenLine('catppuccin-macchiato', true)
  assert.ok(lines.length > 0, 'a token line is painted')
  // The fixture has three agents of session s1 (lost) and one of s2 (not lost): only the lost ones carry the qualifier
  const marked = lines.filter(l => /incomplete/.test(String(l.args[0])))
  assert.ok(marked.length > 0 && marked.length < lines.length, 'the lost session is qualified, the other is not')
  for (const l of marked) assert.match(String(l.args[0]), /^\d+(\.\d+)?k( estimated)? \/ \d+k tokens \(incomplete\)$/, String(l.args[0]))
  assert.equal(tokenLine('catppuccin-macchiato', false).filter(l => /incomplete/.test(String(l.args[0]))).length, 0, 'nothing lost: no qualifier')
})

test('the longest form "95k estimated / 200k tokens (incomplete)" is one fillText, whole on its plate', () => {
  const lines = tokenLine('catppuccin-macchiato', true, true).filter(l => /incomplete/.test(String(l.args[0])))
  assert.ok(lines.length > 0)
  for (const l of lines) assert.equal(l.args[0], '95k estimated / 200k tokens (incomplete)')
})

// The plate behind the token line is as wide as the text it doubles (#613): no end of the label floats on links or halos
test('the plate behind the token line covers the whole text, "(incomplete)" included', () => {
  for (const estimated of [false, true]) {
    const rec = recordingContext(1)
    const agents = fixtureAgents()
    if (estimated) for (const a of agents.values()) { a.tokensEstimated = true; a.tokensUsed = 95_000 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = { reducedMotion: true, zoom: 1, showCost: false, showStats: true, showSessionLabels: true, replayLost: new Map([['s1', 3]]) }
    drawAgents(rec.ctx, agents, null, 's1:worker', true, 0, opts, 1_000_000)
    const texts = rec.ops.filter(o => o.name === 'fillText' && /tokens.*incomplete/.test(String(o.args[0])))
    assert.ok(texts.length > 0)
    for (const t of texts) {
      const half = (String(t.args[0]).length * 11 * 0.6) / 2
      const cx = Number(t.args[1]), y = Number(t.args[2])
      const covered = rec.ops.some(o => {
        if (o.name !== 'roundRect') return false
        const [rx, ry, rw, rh] = o.args.map(Number)
        return rx <= cx - half && rx + rw >= cx + half && ry <= y - 11 && ry + rh >= y
      })
      assert.ok(covered, `no plate covers "${t.args[0]}" (${half * 2} px wide at x=${cx})`)
    }
  }
})

for (const id of THEME_IDS) {
  test(`${id}: the "(incomplete)" token line reaches 4.5:1 on its plate over the canvas ground`, () => {
    const p = scenePalette(id)
    const plate = over(p.cardBgDark, solid(SCENE.void))
    const lines = tokenLine(id, true).filter(l => /incomplete/.test(String(l.args[0])))
    assert.ok(lines.length > 0)
    for (const l of lines) {
      assert.ok(parse(l.fillStyle), `${l.fillStyle} is a plain colour`)
      const r = ratio(over(l.fillStyle, plate, l.globalAlpha), plate)
      assert.ok(r >= 4.5, `${id}: ${l.args[0]} ${r.toFixed(2)}:1`)
    }
  })

  // The plate now follows the text (see above); the ground is still checked, as a margin of safety at its rounded ends.
  test(`${id}: the "(incomplete)" token line reaches 4.5:1 on the bare canvas ground where it overflows its plate`, () => {
    const ground = solid(SCENE.void)
    const lines = tokenLine(id, true).filter(l => /incomplete/.test(String(l.args[0])))
    assert.ok(lines.length > 0)
    for (const l of lines) {
      assert.ok(parse(l.fillStyle), `${l.fillStyle} is a plain colour`)
      const r = ratio(over(l.fillStyle, ground, l.globalAlpha), ground)
      assert.ok(r >= 4.5, `${id}: ${l.args[0]} on the ground ${r.toFixed(2)}:1`)
    }
  })
}
