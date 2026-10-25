// #613: the three dialogs of lazy-panels (Settings, command palette, shortcuts) close themselves when their chunk
// does not load, instead of staying "open" on an empty screen. lazy-component.test.tsx covers the mechanism; this
// file covers the wiring: each dialog is declared with `closeOnError`, and that option closes through `onClose`.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { lazyComponent } from '@/components/agent-visualizer/lazy-component'
import { closeOnError } from '@/components/agent-visualizer/lazy-panels'

afterEach(() => { cleanup() })

const source = fs.readFileSync(path.join(process.cwd(), 'components/agent-visualizer/lazy-panels.tsx'), 'utf8')
// The text of `export const Name = lazyComponent<...>(...)`: from the export to the next blank line
const declaration = (name: string) => source.split('\n\n').find(block => block.includes(`export const ${name} = lazyComponent<`)) ?? ''

test('the three dialogs are declared with closeOnError, the other panels are not', () => {
  for (const name of ['SettingsDialog', 'CommandPalette', 'ShortcutsDialog']) {
    const d = declaration(name).split('\n').slice(declaration(name).split('\n').findIndex(l => l.includes(`export const ${name}`))).slice(0, 2).join('\n')
    assert.ok(d, `${name} is declared in lazy-panels.tsx`)
    assert.ok(d.includes('closeOnError)'), `${name} closes itself when its chunk does not load`)
  }
  for (const name of ['LegendPanel', 'GuidedTourCard', 'TourHighlight']) {
    const d = declaration(name)
    assert.ok(d, `${name} is declared in lazy-panels.tsx`)
    assert.ok(!d.includes('closeOnError'), `${name} has no dialog to close`)
  }
})

test('closeOnError: an open dialog whose chunk fails calls onClose once; a closed one loads nothing', async () => {
  let calls = 0
  const Lazy = lazyComponent<{ open: boolean; onClose: () => void }>(async () => { calls++; throw new Error('chunk 404') }, closeOnError)
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
