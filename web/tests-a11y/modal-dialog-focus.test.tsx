// #507: the focus behaviour of the four modal dialogs (settings, keyboard shortcuts, launch, command palette), pinned
// before their focus trap moves into the useModalDialog hook: role and aria-modal, accessible name, initial focus, Tab
// and Shift+Tab wrapping inside the dialog, Escape (closes, consumed), focus given back to the trigger.
// Real key events through fireEvent: removing a handler makes a test fail.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent, within } from '@testing-library/react'

import { SettingsDialog } from '@/components/agent-visualizer/settings-dialog'
import { ShortcutsDialog } from '@/components/agent-visualizer/shortcuts-dialog'
import { LaunchDialog } from '@/components/agent-visualizer/launch-dialog'
import { CommandPalette } from '@/components/agent-visualizer/command-palette'
import { setLocaleChoice } from '@/lib/locale'
import type { FetchLike } from '@/lib/launch-client'

beforeEach(() => { act(() => { setLocaleChoice('en') }) })
afterEach(() => {
  cleanup()
  act(() => { setLocaleChoice('auto') })
  document.body.replaceChildren()
})

const noop = () => {}
const noFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) })
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })

type Kind = 'settings' | 'shortcuts' | 'launch' | 'palette'

function Dialog({ kind, open, onClose }: { kind: Kind; open: boolean; onClose: () => void }) {
  if (kind === 'settings') {
    return (
      <SettingsDialog
        open={open} onClose={onClose} hexGrid onHexGridChange={noop} muted={false} onToggleMute={noop}
        showMode="active" onShowModeChange={noop} singleKeyEnabled onSingleKeyEnabledChange={noop} onOpenShortcuts={noop}
      />
    )
  }
  if (kind === 'shortcuts') return <ShortcutsDialog open={open} onClose={onClose} singleKeyEnabled onSingleKeyEnabledChange={noop} />
  if (kind === 'palette') return <CommandPalette open={open} onClose={onClose} items={[]} />
  // The launch dialog has no `open` prop: it is mounted while open (agent-detail-card)
  return open
    ? <LaunchDialog repo="o/r" issue={7} role="r" title="Title" maxConcurrent={1} launches={new Map()} origin="" onClose={onClose} fetchFn={noFetch} />
    : null
}

function Host({ kind, closes }: { kind: Kind; closes: { n: number } }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>Trigger</button>
      <Dialog kind={kind} open={open} onClose={() => { closes.n++; setOpen(false) }} />
    </>
  )
}

const NAME: Record<Kind, string> = {
  settings: 'Settings',
  shortcuts: 'Keyboard shortcuts',
  launch: 'Launch an agent on issue #7',
  palette: 'Command palette',
}

async function openDialog(kind: Kind) {
  const closes = { n: 0 }
  const view = render(<Host kind={kind} closes={closes} />)
  const trigger = view.getByTestId('trigger')
  trigger.focus()
  await act(async () => { fireEvent.click(trigger) })
  await flush()
  const dialog = within(document.body).getByRole('dialog', { name: NAME[kind] })
  return { view, trigger, dialog, closes }
}

/** The controls Tab stops at, in document order: what a keyboard user reaches */
function tabStops(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]'))
    .filter(n => n.tabIndex >= 0 && !n.closest('[hidden]') && !(n as HTMLButtonElement).disabled)
}

const KINDS: Kind[] = ['settings', 'shortcuts', 'launch', 'palette']

for (const kind of KINDS) {
  test(`${kind}: a modal dialog named by its title`, async () => {
    const { dialog } = await openDialog(kind)
    assert.equal(dialog.getAttribute('role'), 'dialog')
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    const titleId = dialog.getAttribute('aria-labelledby')
    assert.ok(titleId, 'named by aria-labelledby')
    assert.equal(document.getElementById(titleId)?.textContent, NAME[kind])
    assert.equal(dialog.tabIndex, -1, 'the container can take focus but is no Tab stop')
  })

  test(`${kind}: Escape closes it once, is consumed (default prevented, never reaches window) and focus returns to the trigger`, async () => {
    const { view, trigger, dialog, closes } = await openDialog(kind)
    const seen: string[] = []
    const listener = (e: KeyboardEvent) => { seen.push(e.key) }
    window.addEventListener('keydown', listener)
    let notPrevented = true
    try {
      const target = dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : dialog
      await act(async () => { notPrevented = fireEvent.keyDown(target, { key: 'Escape' }) })
    } finally {
      window.removeEventListener('keydown', listener)
    }
    assert.equal(notPrevented, false, 'default prevented')
    assert.deepEqual(seen, [], 'stopped before window')
    assert.equal(closes.n, 1)
    assert.equal(within(document.body).queryByRole('dialog'), null)
    assert.equal(document.activeElement, trigger)
    assert.ok(view.getByTestId('trigger'))
  })

  test(`${kind}: a trigger gone from the page by the time it closes is not focused`, async () => {
    // Opened while a plain button (outside React) had the focus; that button then leaves the page
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const closes = { n: 0 }
    const view = render(<Host kind={kind} closes={closes} />)
    outside.focus()
    await act(async () => { fireEvent.click(view.getByTestId('trigger')) })
    await flush()
    const dialog = within(document.body).getByRole('dialog', { name: NAME[kind] })
    outside.remove()
    const target = dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : dialog
    await act(async () => { fireEvent.keyDown(target, { key: 'Escape' }) })
    assert.equal(closes.n, 1)
    assert.notEqual(document.activeElement, outside)
    assert.equal(document.activeElement, document.body)
  })
}

test('settings: initial focus on the selected tab', async () => {
  const { dialog } = await openDialog('settings')
  assert.equal(document.activeElement, within(dialog).getByRole('tab', { name: 'General' }))
})

test('shortcuts: initial focus on the dialog itself', async () => {
  const { dialog } = await openDialog('shortcuts')
  assert.equal(document.activeElement, dialog)
})

test('launch: initial focus on Cancel, the safe choice', async () => {
  const { dialog } = await openDialog('launch')
  assert.equal(document.activeElement, within(dialog).getByRole('button', { name: 'Cancel' }))
})

test('palette: initial focus in the search field', async () => {
  const { dialog } = await openDialog('palette')
  assert.equal(document.activeElement, within(dialog).getByRole('combobox'))
})

for (const kind of ['settings', 'shortcuts', 'launch'] as const) {
  test(`${kind}: Tab on the last stop wraps to the first, Shift+Tab on the first to the last, Shift+Tab on the container to the last`, async () => {
    const { dialog } = await openDialog(kind)
    const stops = tabStops(dialog)
    assert.ok(stops.length >= 2, 'at least two stops')
    const first = stops[0]
    const last = stops[stops.length - 1]

    last.focus()
    assert.equal(fireEvent.keyDown(last, { key: 'Tab' }), false, 'wrapping Tab is prevented')
    assert.equal(document.activeElement, first)

    assert.equal(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }), false, 'wrapping Shift+Tab is prevented')
    assert.equal(document.activeElement, last)

    dialog.focus()
    assert.equal(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }), false)
    assert.equal(document.activeElement, last)

    // In the middle, Tab is left to the browser
    if (stops.length >= 3) {
      const middle = stops[1]
      middle.focus()
      assert.equal(fireEvent.keyDown(middle, { key: 'Tab' }), true, 'not prevented in the middle')
      assert.equal(fireEvent.keyDown(middle, { key: 'Tab', shiftKey: true }), true)
      assert.equal(document.activeElement, middle)
    }
  })
}

test('settings: the trap skips the unselected tabs and the controls of the hidden panels', async () => {
  const { dialog } = await openDialog('settings')
  const stops = tabStops(dialog)
  const close = within(dialog).getByRole('button', { name: 'Close' })
  const sound = within(dialog).getByRole('switch', { name: /Sound effects/ })
  assert.equal(stops[0], close, 'Close comes first')
  assert.equal(stops[stops.length - 1], sound, 'the last stop is the last control of the General panel')
  sound.focus()
  fireEvent.keyDown(sound, { key: 'Tab' })
  assert.equal(document.activeElement, close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, sound, 'not a control of a hidden panel')
})

test('settings: Tab with no stop at all is held (nothing to reach)', async () => {
  // Not reachable with the real content; pinned through a container emptied of its stops
  const { dialog } = await openDialog('settings')
  for (const n of tabStops(dialog)) n.setAttribute('tabindex', '-1')
  dialog.focus()
  assert.equal(fireEvent.keyDown(dialog, { key: 'Tab' }), false)
  assert.equal(document.activeElement, dialog)
})

test('launch: Tab is trapped as well when the stop zone is shown (a running launch)', async () => {
  const closes = { n: 0 }
  const launches = new Map([['0123456789abcdef', {
    id: '0123456789abcdef', repo: 'o/r', issue: 7, role: 'r', worktree: 'issue-7-r', sessionId: 's', state: 'running',
    requestedAt: 1, outputBytes: 0, outputDroppedBytes: 0,
  }]]) as never
  render(<LaunchDialog repo="o/r" issue={7} role="r" title="T" maxConcurrent={1} launches={launches} origin="" onClose={() => { closes.n++ }} fetchFn={noFetch} />)
  await flush()
  const dialog = within(document.body).getByRole('dialog')
  const stops = tabStops(dialog)
  const first = stops[0]
  const last = stops[stops.length - 1]
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement, first)
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, last)
})

test('palette: the search field is the only stop, Tab and Shift+Tab are held, also from the container', async () => {
  const { dialog } = await openDialog('palette')
  const field = within(dialog).getByRole('combobox')
  assert.deepEqual(tabStops(dialog), [field])
  assert.equal(fireEvent.keyDown(field, { key: 'Tab' }), false)
  assert.equal(document.activeElement, field)
  assert.equal(fireEvent.keyDown(field, { key: 'Tab', shiftKey: true }), false)
  assert.equal(document.activeElement, field)
  dialog.focus()
  assert.equal(fireEvent.keyDown(dialog, { key: 'Tab' }), false, 'held, not left to the browser')
  assert.equal(document.activeElement, dialog)
  assert.equal(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }), false)
  assert.equal(document.activeElement, dialog)
})

test('palette: Escape closes it from the container too', async () => {
  const { dialog, closes, trigger } = await openDialog('palette')
  dialog.focus()
  await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }) })
  assert.equal(closes.n, 1)
  assert.equal(document.activeElement, trigger)
})

test('launch: Escape while the stop confirmation is shown cancels the confirmation only', async () => {
  const closes = { n: 0 }
  const launches = new Map([['0123456789abcdef', {
    id: '0123456789abcdef', repo: 'o/r', issue: 7, role: 'r', worktree: 'issue-7-r', sessionId: 's', state: 'running',
    requestedAt: 1, outputBytes: 0, outputDroppedBytes: 0,
  }]]) as never
  render(<LaunchDialog repo="o/r" issue={7} role="r" title="T" maxConcurrent={1} launches={launches} origin="" onClose={() => { closes.n++ }} fetchFn={noFetch} />)
  await flush()
  const dialog = within(document.body).getByRole('dialog')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' })) })
  const confirm = document.activeElement as HTMLElement
  assert.ok(dialog.contains(confirm))
  let notPrevented = true
  await act(async () => { notPrevented = fireEvent.keyDown(confirm, { key: 'Escape' }) })
  assert.equal(notPrevented, false)
  assert.equal(closes.n, 0, 'the dialog stays open')
  assert.equal(document.activeElement, within(dialog).getByRole('button', { name: 'Stop' }))
})
