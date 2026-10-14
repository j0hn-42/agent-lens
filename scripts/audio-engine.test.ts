import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AudioEngine } from '../web/lib/audio-engine'

// Minimal Web Audio stub: counts constructions and resume() calls.
let created = 0
let resumed = 0
const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} })
const node = () => ({ gain: param(), frequency: param(), Q: param(), connect() {}, start() {}, stop() {}, type: '' })
class FakeAudioContext {
  state = 'suspended'
  currentTime = 0
  destination = {}
  constructor() { created++ }
  resume() { resumed++; return Promise.resolve() }
  close() { return Promise.resolve() }
  createGain() { return node() }
  createOscillator() { return node() }
  createBiquadFilter() { return node() }
}

function setActivation(hasBeenActive: boolean) {
  Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { hasBeenActive } }, configurable: true })
}

beforeEach(() => {
  created = 0
  resumed = 0
  ;(globalThis as Record<string, unknown>).AudioContext = FakeAudioContext
  setActivation(true)
})

test('muted engine never creates an AudioContext (#383)', () => {
  const engine = new AudioEngine()
  engine.playToolStart()
  engine.playToolEnd()
  engine.playAgentSpawn()
  engine.playAgentComplete()
  engine.playError()
  assert.equal(created, 0)
  assert.equal(resumed, 0)
})

test('no AudioContext before any user gesture, even when unmuted (#383)', () => {
  setActivation(false)
  const engine = new AudioEngine()
  engine.setMuted(false)
  engine.playToolStart()
  engine.playError()
  assert.equal(created, 0)
})

test('unmuted engine with a user gesture creates one context and plays', () => {
  const engine = new AudioEngine()
  engine.setMuted(false)
  engine.playToolStart()
  engine.playToolEnd()
  assert.equal(created, 1)
})

test('toggling mute without a context does not throw', () => {
  const engine = new AudioEngine()
  assert.doesNotThrow(() => engine.setMuted(true))
  assert.doesNotThrow(() => engine.setMuted(false))
})
