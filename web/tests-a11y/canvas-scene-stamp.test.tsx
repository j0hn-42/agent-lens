// Idle drawing (#216): the scene fingerprint that feeds the draw gate. Synthetic agents only.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sceneStamp, sceneAnimating, type SceneStampInput } from '@/components/agent-visualizer/canvas/scene-stamp'
import { createDrawGate } from '@/components/agent-visualizer/canvas/draw-gate'

/* eslint-disable @typescript-eslint/no-explicit-any */
const agent = (over: Record<string, unknown> = {}): any => ({
  id: 'a', x: 10, y: 20, opacity: 1, scale: 1, tokensUsed: 5, toolCalls: 1, messageBubbles: [], state: 'idle', ...over,
})
const tool = (over: Record<string, unknown> = {}): any => ({ id: 't', x: 1, y: 2, opacity: 1, state: 'complete', tokenCost: null, ...over })
function input(over: Partial<SceneStampInput> = {}): SceneStampInput {
  return {
    agents: [agent()], toolCalls: [tool()], particles: 0, edges: 1, discoveries: 0, effects: 0,
    transform: { x: 0, y: 0, scale: 1 }, width: 800, height: 600, dpr: 1, epoch: 0, keys: ['a', null, false], ...over,
  }
}

test('stamp: identical scenes give the same fingerprint', () => {
  assert.equal(sceneStamp(input()), sceneStamp(input()))
})

test('stamp: every visible change moves the fingerprint', () => {
  const base = sceneStamp(input())
  const changes: Array<[string, Partial<SceneStampInput>]> = [
    ['agent moved', { agents: [agent({ x: 11 })] }],
    ['agent state', { agents: [agent({ state: 'thinking' })] }],
    ['agent fading', { agents: [agent({ opacity: 0.5 })] }],
    ['tokens', { agents: [agent({ tokensUsed: 6 })] }],
    ['new bubble', { agents: [agent({ messageBubbles: [{}] })] }],
    ['tool state', { toolCalls: [tool({ state: 'error' })] }],
    ['tool cost', { toolCalls: [tool({ tokenCost: 10 })] }],
    ['pan', { transform: { x: 1, y: 0, scale: 1 } }],
    ['zoom', { transform: { x: 0, y: 0, scale: 1.2 } }],
    ['resize', { width: 801 }],
    ['particle', { particles: 1 }],
    ['new edge', { edges: 2 }],
    ['selection', { keys: ['b', null, false] }],
    ['toggle', { keys: ['a', null, true] }],
    ['react render', { epoch: 1 }],
  ]
  for (const [name, over] of changes) assert.notEqual(sceneStamp(input(over)), base, name)
})

test('animating: active agents, running tools, particles and effects keep the full rate; a settled fleet does not', () => {
  assert.equal(sceneAnimating([agent({ state: 'idle' }), agent({ state: 'complete' })], [tool()], 0, 0), false)
  assert.equal(sceneAnimating([agent({ state: 'thinking' })], [], 0, 0), true)
  assert.equal(sceneAnimating([agent({ state: 'waiting_permission' })], [], 0, 0), true)
  assert.equal(sceneAnimating([agent()], [tool({ state: 'running' })], 0, 0), true)
  assert.equal(sceneAnimating([agent()], [], 2, 0), true)
  assert.equal(sceneAnimating([agent()], [], 0, 1), true)
})

test('idle: a settled scene over one second of 60 fps frames is drawn at most 10 times, and answers a change at once', () => {
  const gate = createDrawGate()
  let drawn = 0
  const stamp = sceneStamp(input())
  for (let i = 0; i < 60; i++) {
    if (gate.shouldDraw({ now: i * 16.7, stamp, reducedMotion: false, animating: sceneAnimating([agent()], [tool()], 0, 0) })) drawn++
  }
  assert.ok(drawn <= 10, `drawn ${drawn}`)
  const moved = sceneStamp(input({ agents: [agent({ x: 99 })] }))
  assert.equal(gate.shouldDraw({ now: 60 * 16.7 + 1, stamp: moved, reducedMotion: false, animating: false }), true)
})
