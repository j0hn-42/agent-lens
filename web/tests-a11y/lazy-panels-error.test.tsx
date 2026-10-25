// #613: the three dialogs of lazy-panels (Settings, command palette, shortcuts) close themselves when their chunk
// does not load, instead of staying "open" on an empty screen. lazy-component.test.tsx covers the mechanism with the
// same options; this file covers the wiring of lazy-panels.tsx itself, which a dynamic import that always succeeds
// cannot exercise: the options object closes through `onClose` once opened, and each dialog (only them) gets it.
// `closeOnError` is not exported (nothing but a test would use it), so the source is read.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { lazyComponent } from '@/components/agent-visualizer/lazy-component'

afterEach(() => { cleanup() })

const source = fs.readFileSync(path.join(process.cwd(), 'components/agent-visualizer/lazy-panels.tsx'), 'utf8')
/** The statement `export const Name = lazyComponent<...>(...)`, up to the next `export` or the end of the file */
const declaration = (name: string) => {
  const start = source.indexOf(`export const ${name} = lazyComponent<`)
  if (start < 0) return ''
  const next = source.indexOf('export const', start + 1)
  return source.slice(start, next < 0 ? undefined : next)
}

test('the three dialogs are declared with closeOnError, the other panels are not', () => {
  for (const name of ['SettingsDialog', 'CommandPalette', 'ShortcutsDialog']) {
    const d = declaration(name)
    assert.ok(d, `${name} is declared in lazy-panels.tsx`)
    assert.match(d.trimEnd().split('\n').slice(0, 2).join('\n'), /closeOnError\)$/, `${name} closes itself when its chunk does not load`)
  }
  for (const name of ['LegendPanel', 'GuidedTourCard', 'TourHighlight']) {
    const d = declaration(name)
    assert.ok(d, `${name} is declared in lazy-panels.tsx`)
    assert.ok(!d.includes('closeOnError'), `${name} has no dialog to close`)
  }
})

test('every lazyComponent of lazy-panels.tsx is accounted for: closeOnError on the dialogs and on nothing else', () => {
  const declared = [...source.matchAll(/export const (\w+) = lazyComponent[<(]/g)].map(m => m[1])
  // A lazyComponent that is not an `export const Name = ...` would escape the list above
  const calls = (source.match(/\blazyComponent\s*[<(]/g) ?? []).length
  assert.equal(declared.length, calls, `every lazyComponent call is an exported declaration (${calls} calls, ${declared.length} declarations)`)
  const withClose = declared.filter(name => declaration(name).includes('closeOnError')).sort()
  assert.deepEqual(withClose, ['CommandPalette', 'SettingsDialog', 'ShortcutsDialog'], `a new lazy panel is either a dialog with closeOnError listed here, or has none (declared: ${declared.join(', ')})`)
})

test('closeOnError, as written in lazy-panels.tsx: an open dialog whose chunk fails calls onClose once; a closed one loads nothing', async () => {
  const line = source.split('\n').find(l => l.startsWith('const closeOnError = ')) ?? ''
  assert.ok(line, 'closeOnError is declared')
  // Evaluated from its own text, with the helpers it names
  const whenOpen = (p: { open: boolean }) => p.open
  const options = new Function('whenOpen', `return (${line.replace('const closeOnError = ', '').replace(/: \(p: \{ onClose: \(\) => void \}\)/, ': (p)')})`)(whenOpen)
  let calls = 0
  const Lazy = lazyComponent<{ open: boolean; onClose: () => void }>(async () => { calls++; throw new Error('chunk 404') }, options)
  const original = console.error
  console.error = () => {}
  try {
    let closed = 0
    const onClose = () => { closed++ }
    const r = render(<Lazy open={false} onClose={onClose} />)
    await act(async () => { await new Promise(res => setTimeout(res, 0)) })
    assert.equal(calls, 0, 'closed: no load')
    r.rerender(<Lazy open onClose={onClose} />)
    await act(async () => { await new Promise(res => setTimeout(res, 0)) })
    assert.equal(calls, 1)
    assert.equal(closed, 1, 'the failure closes the dialog')
    assert.equal(r.container.innerHTML, '', 'and nothing is left on screen')
  } finally {
    console.error = original
  }
})
