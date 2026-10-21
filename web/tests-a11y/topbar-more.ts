// Test helper (one-line top bar, owner request 2026-10-21): the scope, the view filters, the quota gauges and the tools
// (sound, full screen, Settings, shortcuts) are behind More at every width, rendered only while it is open; the panel buttons
// too under 1024 px. A test that uses one of them opens More first, as a person would.
import { act, fireEvent } from '@testing-library/react'
// Call these outside an act() scope: a nested act does not render More open before `find` looks for the control
import { TOPBAR_MORE_ID } from '@/components/agent-visualizer/top-bar'

const moreButton = () => document.getElementById(TOPBAR_MORE_ID)

/** Opens More (once) and returns its button. */
export function openMore(): HTMLElement {
  const more = moreButton()
  if (!more) throw new Error('no More button in the top bar')
  if (more.getAttribute('aria-expanded') !== 'true') act(() => { fireEvent.click(more) })
  return more
}

/** Closes More if it is open (a filter keeps it open; the app's Escape waits until More is closed). */
export function closeMore(): void {
  const more = moreButton()
  if (more?.getAttribute('aria-expanded') === 'true') act(() => { fireEvent.click(more) })
}

/** Clicks a control of More and closes More again: the rest of the test sees the bar as it was. */
export function clickInMore(find: () => HTMLElement): void {
  openMore()
  const el = find()
  act(() => { fireEvent.click(el) })
  closeMore()
}

/** Opens More and returns what `find` finds in it. */
export function inMore<T>(find: () => T): T {
  openMore()
  return find()
}

/** Opens More, then clicks what `find` finds in it inside an async act (a control that opens a dialog or full screen closes More itself). */
export async function pressInMore(find: () => HTMLElement): Promise<void> {
  openMore()
  const el = find()
  await act(async () => { fireEvent.click(el) })
}
