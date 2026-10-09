import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { GuidedTourCard } from '@/components/agent-visualizer/guided-tour-card'
import { GUIDED_STEPS } from '@/lib/guided-steps'

afterEach(() => { cleanup(); document.body.replaceChildren() })
const frames = () => act(async () => { await new Promise(r => setTimeout(r, 80)) })

function setup(index = 1) {
  const calls: string[] = []
  const view = render(
    <GuidedTourCard steps={GUIDED_STEPS} index={index} onNext={() => calls.push('next')} onPrev={() => calls.push('prev')}
      onGoTo={i => calls.push(`goto:${i}`)} onExit={() => calls.push('exit')} />,
  )
  return { view, calls }
}

test('the card is a labelled dialog that shows the title, the body and the position', () => {
  const { view } = setup(1)
  const dialog = view.getByRole('dialog')
  assert.ok(dialog.getAttribute('aria-labelledby'))
  assert.ok(view.getByText(GUIDED_STEPS[1].title))
  assert.ok(view.getByText(GUIDED_STEPS[1].body))
  assert.ok(view.getByText(`Step 2 of ${GUIDED_STEPS.length}`))
})

test('Previous is disabled on the first step and Next on the last', () => {
  assert.equal((setup(0).view.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled, true)
  cleanup()
  assert.equal((setup(GUIDED_STEPS.length - 1).view.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled, true)
})

test('buttons call back; the step list jumps to a step', () => {
  const { view, calls } = setup(1)
  fireEvent.click(view.getByRole('button', { name: 'Next' }))
  fireEvent.click(view.getByRole('button', { name: 'Previous' }))
  fireEvent.click(view.getByRole('button', { name: 'Exit tour' }))
  fireEvent.change(view.getByRole('combobox', { name: 'Go to step' }), { target: { value: '3' } })
  assert.deepEqual(calls, ['next', 'prev', 'exit', 'goto:3'])
})

test('arrow keys and Escape work inside the card only', async () => {
  const { view, calls } = setup(1)
  await frames()
  const dialog = view.getByRole('dialog')
  fireEvent.keyDown(dialog, { key: 'ArrowRight' })
  fireEvent.keyDown(dialog, { key: 'ArrowLeft' })
  fireEvent.keyDown(dialog, { key: 'Escape' })
  assert.deepEqual(calls, ['next', 'prev', 'exit'])
  calls.length = 0
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  assert.deepEqual(calls, [], 'the graph keyboard navigation keeps its arrow keys')
})

test('the step text is announced politely', () => {
  const { view } = setup(2)
  assert.equal(view.container.querySelector('[aria-live="polite"]')?.textContent?.includes(GUIDED_STEPS[2].title), true)
})

test('exiting the tour (unmount) gives the focus back to the element that opened it', async () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  assert.equal(document.activeElement, trigger)
  const { view } = setup(1)
  await frames()
  assert.notEqual(document.activeElement, trigger, 'the card takes the focus')
  view.unmount()
  await frames()
  assert.equal(document.activeElement, trigger)
})
