// useFullscreen (#173, #192): immersive mode = browser fullscreen + hidden chrome. jsdom has no Fullscreen API,
// so the document is given a controllable one. Covered: toggle with and without requestFullscreen, a refused
// promise, leaving by the browser (Esc, F11 -> fullscreenchange), and cleanup of the listener.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useFullscreen } from '@/hooks/use-fullscreen'

const root = document.documentElement as unknown as Record<string, unknown>
const doc = document as unknown as Record<string, unknown>

let fsElement: Element | null
let requestCalls: number
let exitCalls: number
let requestImpl: () => Promise<void>
let exitImpl: () => Promise<void>

function installFullscreenApi() {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement })
  root.requestFullscreen = () => { requestCalls++; return requestImpl() }
  doc.exitFullscreen = () => { exitCalls++; return exitImpl() }
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const browserLeavesFullscreen = () => act(() => {
  fsElement = null
  document.dispatchEvent(new Event('fullscreenchange'))
})

beforeEach(() => {
  fsElement = null
  requestCalls = 0
  exitCalls = 0
  requestImpl = async () => { fsElement = document.documentElement }
  exitImpl = async () => { fsElement = null }
  installFullscreenApi()
})
afterEach(() => {
  cleanup()
  delete root.requestFullscreen
  delete doc.exitFullscreen
  delete (document as unknown as Record<string, unknown>).fullscreenElement
})

test('starts outside immersive mode', () => {
  const { result } = renderHook(() => useFullscreen())
  assert.equal(result.current.immersive, false)
})

test('toggle enters immersive mode and asks the browser for fullscreen', async () => {
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, true)
  assert.equal(requestCalls, 1)
})

test('toggle again leaves immersive mode and exits browser fullscreen', async () => {
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, false)
  assert.equal(exitCalls, 1)
})

test('a rejected exitFullscreen is swallowed and immersive mode is still left', async () => {
  exitImpl = () => Promise.reject(new Error('not fullscreen'))
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, false)
})

test('without requestFullscreen (iOS Safari, embedded webviews) the chrome is hidden and nothing throws', async () => {
  delete root.requestFullscreen
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, true)
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, false)
  assert.equal(exitCalls, 0, 'never entered browser fullscreen, so nothing to exit')
})

test('a refused requestFullscreen keeps the chrome hidden and the browser windowed', async () => {
  requestImpl = () => Promise.reject(new TypeError('Permissions check failed'))
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, true)
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, false)
  assert.equal(exitCalls, 0, 'the request was refused: there is no fullscreen to exit')
})

test('leaving browser fullscreen by Esc/F11 (fullscreenchange) also leaves immersive mode', async () => {
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, true)
  browserLeavesFullscreen()
  assert.equal(result.current.immersive, false)
  assert.equal(exitCalls, 0, 'the browser already left: no second exit')
  // the next toggle enters again
  act(() => result.current.toggle())
  await flush()
  assert.equal(result.current.immersive, true)
  assert.equal(requestCalls, 2)
})

test('fullscreenchange does not end immersive mode that never entered browser fullscreen', async () => {
  requestImpl = () => Promise.reject(new Error('denied'))
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  browserLeavesFullscreen()
  assert.equal(result.current.immersive, true)
})

test('fullscreenchange while still in fullscreen changes nothing', async () => {
  const { result } = renderHook(() => useFullscreen())
  act(() => result.current.toggle())
  await flush()
  act(() => { document.dispatchEvent(new Event('fullscreenchange')) })
  assert.equal(result.current.immersive, true)
})

test('the fullscreenchange listener is removed on unmount', () => {
  const added: EventListenerOrEventListenerObject[] = []
  const removed: EventListenerOrEventListenerObject[] = []
  const add = document.addEventListener.bind(document)
  const remove = document.removeEventListener.bind(document)
  document.addEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: unknown) => {
    if (type === 'fullscreenchange') { added.push(l) }
    add(type, l, o as never)
  }) as typeof document.addEventListener
  document.removeEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: unknown) => {
    if (type === 'fullscreenchange') { removed.push(l) }
    remove(type, l, o as never)
  }) as typeof document.removeEventListener
  try {
    const { unmount } = renderHook(() => useFullscreen())
    assert.equal(added.length, 1)
    unmount()
    assert.deepEqual(removed, added)
  } finally {
    document.addEventListener = add
    document.removeEventListener = remove
  }
})
