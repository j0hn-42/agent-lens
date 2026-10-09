import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { GuidedTourCard } from '@/components/agent-visualizer/guided-tour-card'
import { GUIDED_STEPS } from '@/lib/guided-steps'
import { GUIDED_TOUR_BUTTON_ID } from '@/components/agent-visualizer/guided-tour-context'

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

test('Previous is disabled on the first step and Next on the last, and they do nothing there', () => {
  // aria-disabled, not disabled: a disabled button drops the focus to <body> (see the keyboard tests below)
  const first = setup(0)
  const prev = first.view.getByRole('button', { name: 'Previous' })
  assert.equal(prev.getAttribute('aria-disabled'), 'true')
  fireEvent.click(prev)
  assert.deepEqual(first.calls, [])
  assert.equal(first.view.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled'), null)
  cleanup()
  const last = setup(GUIDED_STEPS.length - 1)
  const next = last.view.getByRole('button', { name: 'Next' })
  assert.equal(next.getAttribute('aria-disabled'), 'true')
  fireEvent.click(next)
  assert.deepEqual(last.calls, [])
})

/** The card driven like the app does it: the index is clamped to the steps */
function Driven({ start }: { start: number }) {
  const [index, setIndex] = React.useState(start)
  const last = GUIDED_STEPS.length - 1
  return (
    <GuidedTourCard steps={GUIDED_STEPS} index={index} onNext={() => setIndex(i => Math.min(i + 1, last))}
      onPrev={() => setIndex(i => Math.max(i - 1, 0))} onGoTo={setIndex} onExit={() => {}} />
  )
}

const position = (view: ReturnType<typeof render>) => view.getByText(/^Step \d+ of \d+$/).textContent

test('pressing Next up to the last step keeps the focus on Next, and the arrow keys still navigate', async () => {
  const view = render(<Driven start={0} />)
  await frames()
  const next = view.getByRole('button', { name: 'Next' }) as HTMLButtonElement
  next.focus()
  for (let i = 0; i < GUIDED_STEPS.length + 2; i++) {
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    fireEvent.click(document.activeElement!)
  }
  assert.equal(position(view), `Step ${GUIDED_STEPS.length} of ${GUIDED_STEPS.length}`)
  assert.ok(document.activeElement === next, 'the focus stays on Next')
  // A disabled button cannot hold the focus in a browser: Next must stay focusable
  assert.equal(next.disabled, false)
  assert.equal(next.getAttribute('aria-disabled'), 'true')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
  assert.equal(position(view), `Step ${GUIDED_STEPS.length - 1} of ${GUIDED_STEPS.length}`)
})

test('pressing Previous back to the first step keeps the focus on Previous, and the arrow keys still navigate', async () => {
  const view = render(<Driven start={2} />)
  await frames()
  const prev = view.getByRole('button', { name: 'Previous' }) as HTMLButtonElement
  prev.focus()
  for (let i = 0; i < 4; i++) fireEvent.click(document.activeElement!)
  assert.equal(position(view), `Step 1 of ${GUIDED_STEPS.length}`)
  assert.ok(document.activeElement === prev, 'the focus stays on Previous')
  assert.equal(prev.disabled, false)
  assert.equal(prev.getAttribute('aria-disabled'), 'true')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  assert.equal(position(view), `Step 2 of ${GUIDED_STEPS.length}`)
})

test('the tour starts with the focus on Next, so a first Enter does not end it', async () => {
  const view = render(<Driven start={0} />)
  await frames()
  assert.equal(document.activeElement?.textContent, 'Next')
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

test('when the element that opened the tour is gone, exiting focuses the Guided tour button', async () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const { view } = setup(1)
  await frames()
  trigger.remove()
  // The Guided tour button comes back when the tour ends (it is unmounted while the tour runs)
  const start = document.createElement('button')
  start.id = GUIDED_TOUR_BUTTON_ID
  document.body.appendChild(start)
  view.unmount()
  await frames()
  assert.equal(document.activeElement, start)
})

test('with no element that opened the tour (auto-started demo), exiting focuses the Guided tour button', async () => {
  const { view } = setup(1)
  await frames()
  const start = document.createElement('button')
  start.id = GUIDED_TOUR_BUTTON_ID
  document.body.appendChild(start)
  view.unmount()
  await frames()
  assert.equal(document.activeElement, start)
})
