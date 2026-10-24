import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createProjectWatchScan } from './project-watch-scan'

function setup(tracked: string[] = []) {
  let scans = 0
  const w = createProjectWatchScan({ scan: () => { scans++ }, isTracked: id => tracked.includes(id) })
  return { w, scans: () => scans }
}

test('writes on an already tracked transcript never scan (#650)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { w, scans } = setup(['abc'])
    for (let i = 0; i < 200; i++) w.onEvent('abc.jsonl')
    mock.timers.tick(5000)
    assert.equal(scans(), 0)
    w.dispose()
  } finally { mock.timers.reset() }
})

test('a new session is scanned at once, not after the debounce (#650)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { w, scans } = setup()
    w.onEvent('new.jsonl')
    assert.equal(scans(), 1)
    w.dispose()
  } finally { mock.timers.reset() }
})

test('a burst of unknown-file events costs one leading and one trailing scan per 250 ms (#650)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { w, scans } = setup()
    for (let i = 0; i < 100; i++) w.onEvent('skipped.jsonl')
    assert.equal(scans(), 1)
    mock.timers.tick(249)
    assert.equal(scans(), 1)
    mock.timers.tick(1)
    assert.equal(scans(), 2)
    mock.timers.tick(5000)
    assert.equal(scans(), 2, 'no event, no more scans')
    w.dispose()
  } finally { mock.timers.reset() }
})

test('non-jsonl and missing filenames are ignored; dispose cancels the trailing scan (#650)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { w, scans } = setup()
    w.onEvent(undefined); w.onEvent(null); w.onEvent('notes.txt')
    assert.equal(scans(), 0)
    w.onEvent('a.jsonl'); w.onEvent('a.jsonl')
    w.dispose()
    mock.timers.tick(1000)
    assert.equal(scans(), 1)
  } finally { mock.timers.reset() }
})
