// Burrow view: a failed tool call. The animal stumbles where it is, and its bubble gives the exit code only when the
// received text of a failed shell command proves one; nothing else is said, no line is made up.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { exitCodeOf, glumFrame, STUMBLE_S, stumbleFrame } from '../web/lib/burrow/burrow-failure'
import { actDrawList } from '../web/lib/burrow/burrow-acts'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'

const fox = BURROW_DATA.sprites.fox
const squirrel = BURROW_DATA.sprites.squirrel
const rects = BURROW_DATA.fx.rects
const at = (meta: typeof fox, age: number, o: { still?: boolean; line?: string | null } = {}) =>
  stumbleFrame({ age, still: o.still ?? false, meta, line: o.line === undefined ? 'Exit code 2' : o.line })
const names = (f: ReturnType<typeof at>) => (f?.fx ?? []).map((x) => x.name)

test('exitCodeOf: the exit code of a failed shell command, read strictly from the start of its received text', () => {
  const bash = (text: string, field: 'errorMessage' | 'result' = 'errorMessage') => exitCodeOf({ toolName: 'Bash', [field]: text })
  assert.equal(bash('Exit code 2'), 2)
  assert.equal(bash('Exit code 127\nbash: foo: command not found'), 127)
  assert.equal(bash('[FAILED] Exit code 1', 'result'), 1, 'the hook path prefixes the result')
  assert.equal(bash('Exit code 0'), 0)
  assert.equal(bash('Exit code 255'), 255)
  assert.equal(bash('exit code 2'), null, 'the case is the received one')
  assert.equal(bash('Exit code 2000'), null)
  assert.equal(bash('Exit code 256'), null, 'not an exit status')
  assert.equal(bash('Error: Exit code 2'), null, 'only at the start')
  assert.equal(bash('Exit code -1'), null)
  assert.equal(bash(''), null)
  assert.equal(exitCodeOf({ toolName: 'Bash' }), null, 'no text received')
  assert.equal(exitCodeOf({ toolName: 'Read', errorMessage: 'Exit code 2' }), null, 'only a shell command has an exit code')
  // the error message comes first, the result when there is none
  assert.equal(exitCodeOf({ toolName: 'Bash', errorMessage: 'Exit code 3', result: 'Exit code 4' }), 3)
  assert.equal(exitCodeOf({ toolName: 'Bash', errorMessage: '', result: 'Exit code 4' }), 4)
})

test('the stumble of the squirrel: startled 0.6 s, dizzy four times 0.25 s, sheepish 1.5 s, about three seconds in all', () => {
  assert.equal(STUMBLE_S, 3.1)
  const poses: Array<[number, string]> = [[0, 'startled'], [0.59, 'startled'], [0.6, 'dizzyA'], [0.85, 'dizzyB'], [1.1, 'dizzyA'], [1.35, 'dizzyB'], [1.6, 'sheepish'], [3.09, 'sheepish']]
  for (const [t, pose] of poses) assert.equal(at(squirrel, t)?.pose, pose, `${t}`)
  // then the pose is the engine's again: it goes on with what it was doing, the bubble still says the code
  const after = at(squirrel, 3.2)
  assert.equal(after?.pose, undefined)
  assert.equal(after?.sign, null)
  assert.deepEqual(after?.fx, [])
  assert.equal(after?.line, 'Exit code 2')
  assert.equal(at(squirrel, 4.0), null, 'over at 4 s')
  assert.equal(at(squirrel, 3.2, { line: null }), null, 'with no code to say, nothing is left after the stumble')
})

test('the stumble: a "!" over the head except while dizzy (stars turn there instead), never blinking; the exit code from 1.6 s to 4 s, only when received', () => {
  for (let i = 0; i < 310; i++) {
    const t = i / 100
    const f = at(squirrel, t)
    const dizzy = String(f?.pose).startsWith('dizzy')
    assert.equal(f?.sign, dizzy ? null : 'alert', `${t}`)
    assert.equal(names(f).filter((n) => n === 'w_star').length, dizzy ? 3 : 0, `${t}`)
    assert.equal(f?.line, t >= 1.6 ? 'Exit code 2' : undefined, `${t}`)
    assert.equal(at(squirrel, t, { line: null })?.line, undefined, 'no code: nothing said')
  }
})

test('the stumble effects: two puffs of dust drifting apart and fading under the feet for 0.55 s, a drop of sweat while sheepish', () => {
  const start = at(squirrel, 0.1)!
  const puffs = start.fx.filter((x) => x.name === 'w_puff')
  assert.equal(puffs.length, 2)
  assert.ok(puffs[0].dx < 0 && puffs[1].dx > 0 && puffs.every((p) => p.dy < 0), 'either side of the feet, a little up')
  assert.ok(puffs.every((p) => (p.alpha ?? 1) < 1 && (p.alpha ?? 1) > 0.7))
  const later = at(squirrel, 0.5)!.fx.filter((x) => x.name === 'w_puff')
  assert.ok(later[0].dx < puffs[0].dx && later[1].dx > puffs[1].dx && (later[0].alpha ?? 1) < (puffs[0].alpha ?? 1), 'they drift apart and fade')
  assert.deepEqual(names(at(squirrel, 0.56)), [])
  assert.deepEqual(names(at(squirrel, 2)), ['w_drop'])
  // the stars stay over the head: an ellipse 20 px wide, above the top of the drawn pose
  const tall = squirrel.poses.dizzyA.h
  for (let i = 60; i < 160; i += 5) {
    for (const s of at(squirrel, i / 100)!.fx) assert.ok(Math.abs(s.dx) <= 10 && s.dy <= -tall - 1 && s.dy >= -tall - 7, `${i} ${s.dx},${s.dy}`)
  }
  // every effect is a rect of the effects picture
  for (let i = 0; i < 400; i += 5) for (const n of names(at(squirrel, i / 100))) assert.ok(rects[n], n)
})

test('another animal stumbles standing: no pose of its own, the same signs, effects and code', () => {
  for (let i = 0; i < 310; i += 5) {
    const t = i / 100
    const f = at(fox, t)!
    assert.equal(f.pose, null, `${t}`)
    assert.deepEqual([f.sign, names(f)], [at(squirrel, t)!.sign, names(at(squirrel, t))], `${t}`)
  }
  // the sign sits over the fox's own head
  const sign = actDrawList({ x: 100, y: 200, meta: fox }, at(fox, 0.1)!, rects, 0, true).find((x) => x.name === 'w_alert')!
  assert.equal(sign.y, 200 - fox.h - rects.w_alert[3] - 3)
})

test('the still scene: sheepish under "!" with the code for the three seconds, then the code alone until 4 s; no effect', () => {
  for (let i = 0; i < 310; i += 5) {
    const t = i / 100
    const f = at(squirrel, t, { still: true })!
    assert.deepEqual([f.pose, f.sign, f.line, f.fx], ['sheepish', 'alert', 'Exit code 2', []], `${t}`)
    assert.equal(at(fox, t, { still: true })!.pose, null)
  }
  assert.deepEqual(at(squirrel, 3.5, { still: true }), { sign: null, fx: [], line: 'Exit code 2' })
  assert.equal(at(squirrel, 4, { still: true }), null)
  assert.equal(at(squirrel, 1, { still: true, line: null })?.line, undefined)
})

test('glum, an agent in error: the squirrel hangs its head, another animal stands, under a steady "!"', () => {
  assert.deepEqual(glumFrame({ meta: squirrel }), { pose: 'sad', sign: 'alert', fx: [] })
  assert.deepEqual(glumFrame({ meta: fox }), { pose: null, sign: 'alert', fx: [] })
})
