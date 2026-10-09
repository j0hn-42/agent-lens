// The Sessions panel opens with "Active only" ON (aria-pressed="true"). Tests that need every session
// listed (finished, unobserved, ...) switch the filter off first with this helper.
import { strict as assert } from 'node:assert'
import { fireEvent } from '@testing-library/react'

type View = { getByRole: (role: 'button', opts: { name: string }) => HTMLElement }

export function showAllSessions(view: View): HTMLElement {
  const toggle = view.getByRole('button', { name: 'Active only' })
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'the Active only filter starts on')
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'every session is listed now')
  return toggle
}
