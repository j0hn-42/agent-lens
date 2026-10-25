// #613 (review of PR 687): "190k / 200k tokens (incomplete)" under the context bar is ONE fillText, and in every theme it
// is drawn at 4.5:1 or more on its plate over the canvas ground. The proof lives here (recording context, no browser) because
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

function tokenLine(theme: ThemeId, lost: boolean): DrawnOp[] {
  const rec = recordingContext(1)
  const replayLost = lost ? new Map([['s1', 3]]) : undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = { reducedMotion: true, zoom: 1, showCost: false, showStats: true, showSessionLabels: true, theme, replayLost }
  drawAgents(rec.ctx, fixtureAgents(), null, 's1:worker', true, 0, opts, 1_000_000)
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
}
