import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelFocusController, type PanelFocusEnv } from '../web/lib/menu-utils'
import { getActivityLabel, safeTeamColor, safeLabel } from '../web/lib/state-labels'

/** Manual frame scheduler: frames only run when the test calls flush(). */
function makeScheduler() {
  let next = 1
  const queue = new Map<number, () => void>()
  return {
    request: (cb: () => void) => { const id = next++; queue.set(id, cb); return id },
    cancel: (id: number) => { queue.delete(id) },
    flush() {
      const batch = [...queue.entries()]
      queue.clear()
      for (const [, cb] of batch) cb()
    },
    pending: () => queue.size,
  }
}

interface Fake { name: string; connected: boolean }

function makeWorld() {
  const trigger: Fake = { name: 'trigger', connected: true }
  const other: Fake = { name: 'other', connected: true }
  const state = {
    active: trigger as Fake | 'body' | 'panel' | 'dialog',
    inOtherDialog: false,
    log: [] as string[],
  }
  const env: PanelFocusEnv<Fake> = {
    captureTrigger: () => (typeof state.active === 'object' ? state.active : null),
    isConnected: (el) => el.connected,
    focus: (el) => { state.active = el; state.log.push(`focus:${el.name}`) },
    isFocusInOtherDialog: () => state.inOtherDialog,
    // Mirrors shouldRestoreFocus: body/lost or inside the panel only.
    canRestoreFocus: () => state.active === 'body' || state.active === 'panel',
    focusPanel: () => { state.active = 'panel'; state.log.push('focus:panel') },
  }
  return { trigger, other, state, env }
}

test('panel opens: focus moves into the panel only after two frames', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  s.flush()
  assert.deepEqual(w.state.log, [], 'nothing after the first frame')
  s.flush()
  assert.deepEqual(w.state.log, ['focus:panel'])
})

test('card opens while the panel is open: the dialog keeps focus (one owner)', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  // The detail card mounts in the same commit and takes focus.
  w.state.active = 'dialog'
  w.state.inOtherDialog = true
  s.flush(); s.flush()
  assert.deepEqual(w.state.log, [])
  assert.equal(w.state.active, 'dialog')
})

test('card opened before the panel: trigger capture skips the dialog', () => {
  const w = makeWorld()
  w.state.active = 'dialog'
  w.state.inOtherDialog = true
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  s.flush(); s.flush()
  c.setVisible(false)
  assert.deepEqual(w.state.log, [], 'no trigger captured, nothing restored, nothing focused')
})

test('card closes while the panel is open: panel is not refocused', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  s.flush(); s.flush()
  w.state.log.length = 0
  // Card closes; controller is not told anything (panel stays visible).
  c.setVisible(true)
  assert.equal(s.pending(), 0)
  assert.deepEqual(w.state.log, [])
})

test('panel closes: focus returns to the trigger when focus was dropped or inside the panel', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  s.flush(); s.flush()
  w.state.active = 'body' // inert dropped focus
  c.setVisible(false)
  assert.deepEqual(w.state.log, ['focus:panel', 'focus:trigger'])

  const w2 = makeWorld()
  const s2 = makeScheduler()
  const c2 = createPanelFocusController(w2.env, s2)
  c2.setVisible(true)
  s2.flush(); s2.flush()
  c2.setVisible(false) // focus still in the panel
  assert.equal(w2.state.active, w2.trigger)
})

test('panel closes: focus the user moved elsewhere is never stolen', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  s.flush(); s.flush()
  w.state.active = w.other
  c.setVisible(false)
  assert.equal(w.state.active, w.other)
})

test('rapid toggles: pending frames are cancelled and each open recaptures the trigger', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  c.setVisible(false)
  assert.equal(s.pending(), 0, 'close cancels the pending focus')
  c.setVisible(true)
  s.flush()
  c.setVisible(false) // between frame 1 and 2
  assert.equal(s.pending(), 0)
  s.flush(); s.flush()
  assert.deepEqual(w.state.log, [], 'panel never stole focus; trigger already had it')

  w.state.active = w.other
  c.setVisible(true) // recaptures `other`
  s.flush(); s.flush()
  w.state.active = 'body'
  c.setVisible(false)
  assert.equal(w.state.active, w.other)
})

test('repeated setVisible with the same value is ignored', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  c.setVisible(true)
  assert.equal(s.pending(), 1)
  c.setVisible(false)
  c.setVisible(false)
  assert.equal(s.pending(), 0)
})

test('trigger removed from the DOM: nothing is focused on close', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  s.flush(); s.flush()
  w.trigger.connected = false
  w.state.active = 'body'
  c.setVisible(false)
  assert.deepEqual(w.state.log, ['focus:panel'])
})

test('autoFocus false: captures and restores the trigger without scheduling frames', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s, { autoFocus: false })
  c.setVisible(true)
  assert.equal(s.pending(), 0)
  w.state.active = 'body'
  c.setVisible(false)
  assert.equal(w.state.active, w.trigger)
})

test('dispose cancels pending frames', () => {
  const w = makeWorld()
  const s = makeScheduler()
  const c = createPanelFocusController(w.env, s)
  c.setVisible(true)
  c.dispose()
  assert.equal(s.pending(), 0)
})

test('activity labels and untrusted team values', () => {
  assert.equal(getActivityLabel('working'), 'Working')
  assert.equal(getActivityLabel('idle'), 'Idle')
  assert.equal(getActivityLabel('done'), 'Done')
  assert.equal(getActivityLabel('some_thing'), 'some thing')
  assert.equal(safeTeamColor('#a1B2c3'), '#a1B2c3')
  assert.equal(safeTeamColor('red'), undefined)
  assert.equal(safeTeamColor('#fff'), undefined)
  assert.equal(safeTeamColor('#a1b2c3; background:url(x)'), undefined)
  assert.equal(safeTeamColor(42), undefined)
  assert.equal(safeLabel('ab\u0007c\n'), 'abc')
  assert.equal(safeLabel('x'.repeat(100), 10), 'xxxxxxxxxx')
  assert.equal(safeLabel('  '), undefined)
  assert.equal(safeLabel(null), undefined)
})
