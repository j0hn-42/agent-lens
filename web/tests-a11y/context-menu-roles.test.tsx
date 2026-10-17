// #380 (4.1.2): a context-menu toggle that knows its state is a menuitemcheckbox with aria-checked, and a decorative
// icon (an emoji) is hidden from the accessible name.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { GlassContextMenu } from '@/components/agent-visualizer/glass-context-menu'

afterEach(() => { cleanup(); document.body.replaceChildren() })

test('an item with a checked state is a menuitemcheckbox carrying aria-checked', () => {
  const v = render(
    <GlassContextMenu
      position={{ x: 10, y: 10 }}
      onClose={() => {}}
      items={[
        { label: 'Stats', checked: true, onClick: () => {} },
        { label: 'Grid', checked: false, onClick: () => {} },
        { label: 'Zoom', onClick: () => {} },
      ]}
    />,
  )
  assert.equal(v.getByRole('menuitemcheckbox', { name: 'Stats' }).getAttribute('aria-checked'), 'true')
  assert.equal(v.getByRole('menuitemcheckbox', { name: 'Grid' }).getAttribute('aria-checked'), 'false')
  assert.ok(v.getByRole('menuitem', { name: 'Zoom' }).getAttribute('aria-checked') === null, 'a plain item has no aria-checked')
})

test('the icon is decorative: aria-hidden, not part of the accessible name', () => {
  const v = render(
    <GlassContextMenu position={{ x: 10, y: 10 }} onClose={() => {}} items={[{ icon: '📊', label: 'Toggle stats', onClick: () => {} }]} />,
  )
  const item = v.getByRole('menuitem', { name: 'Toggle stats' })
  assert.equal(item.querySelector('[aria-hidden="true"]')?.textContent, '📊')
})
