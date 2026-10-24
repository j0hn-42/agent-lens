// #662: a dialog, the legend panel or the tour is a chunk of its own, loaded the first time it has to show.
// lazyComponent renders nothing until then, never a fallback text that the panel would replace, and keeps the
// component mounted once loaded so a dialog keeps its state between two openings, as it did when it was eager.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { lazyComponent } from '@/components/agent-visualizer/lazy-component'

afterEach(() => { cleanup() })

function Panel({ open, label }: { open: boolean; label: string }) {
  return open ? <p>{label}</p> : <span data-closed="" />
}

function makeLazy() {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  const Lazy = lazyComponent(async () => { calls++; await gate; return Panel }, { when: (p: { open: boolean }) => p.open })
  return { Lazy, calls: () => calls, release }
}

test('closed: nothing is loaded and nothing is rendered', async () => {
  const { Lazy, calls } = makeLazy()
  const r = render(<Lazy open={false} label="Settings" />)
  await act(async () => { await new Promise(res => setTimeout(res, 0)) })
  assert.equal(calls(), 0)
  assert.equal(r.container.innerHTML, '')
})

test('opened: loaded once, nothing in between, then the panel; it stays mounted when closed again', async () => {
  const { Lazy, calls, release } = makeLazy()
  const r = render(<Lazy open label="Settings" />)
  assert.equal(r.container.innerHTML, '', 'no placeholder text while the chunk loads')
  r.rerender(<Lazy open label="Settings" />)
  await act(async () => { release(); await new Promise(res => setTimeout(res, 0)) })
  assert.equal(calls(), 1)
  assert.ok(r.getByText('Settings'))
  r.rerender(<Lazy open={false} label="Settings" />)
  assert.ok(r.container.querySelector('[data-closed]'), 'the loaded component gets the closed state itself')
})

test('preloaded: the first render already shows the panel, and a second instance does not load again', async () => {
  const { Lazy, calls, release } = makeLazy()
  release()
  await Lazy.preload()
  const r = render(<Lazy open label="Shortcuts" />)
  assert.ok(r.getByText('Shortcuts'))
  render(<Lazy open label="Again" />)
  assert.equal(calls(), 1)
})

test('without a condition the component is loaded at its first render', async () => {
  let calls = 0
  const Always = lazyComponent(async () => { calls++; return ({ label }: { label: string }) => <p>{label}</p> })
  const r = render(<Always label="Legend" />)
  await act(async () => { await new Promise(res => setTimeout(res, 0)) })
  assert.equal(calls, 1)
  assert.ok(r.getByText('Legend'))
})
