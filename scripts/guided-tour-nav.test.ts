import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startTour, nextStep, prevStep, goToStep, exitTour, INACTIVE_TOUR } from '../web/lib/guided-tour-nav'

test('start opens on the first step; exit closes', () => {
  assert.deepEqual(startTour(), { active: true, index: 0 })
  assert.deepEqual(exitTour(), INACTIVE_TOUR)
})

test('next and prev move by one and stop at the bounds without looping', () => {
  let s = startTour()
  s = prevStep(s, 3); assert.equal(s.index, 0)
  s = nextStep(s, 3); s = nextStep(s, 3); assert.equal(s.index, 2)
  s = nextStep(s, 3); assert.equal(s.index, 2)
})

test('goTo clamps out-of-range indexes', () => {
  assert.equal(goToStep(startTour(), 99, 5).index, 4)
  assert.equal(goToStep(startTour(), -3, 5).index, 0)
})

test('navigating an inactive tour or an empty list does nothing', () => {
  assert.deepEqual(nextStep(INACTIVE_TOUR, 3), INACTIVE_TOUR)
  assert.deepEqual(goToStep(startTour(), 2, 0), startTour())
})
