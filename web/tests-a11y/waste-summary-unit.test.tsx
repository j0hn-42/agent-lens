// #613: the folded summary counts the repeated TARGETS (one row each), not the calls: a file read three times is one row, two repeats.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { emptyWasteLedger, recordToolStart } from '@/lib/waste'
import { setLocaleChoice } from '@/lib/locale'

afterEach(() => { cleanup(); document.body.replaceChildren(); act(() => setLocaleChoice('auto')) })

// two files, one read 3 times (2 repeats), one read twice (1 repeat): 2 targets, 3 repeats
function ledger() {
  let l = emptyWasteLedger()
  let n = 0
  for (const [file, times] of [['/repo/a.ts', 3], ['/repo/b.ts', 2]] as const) for (let i = 0; i < times; i++) {
    const id = `t${++n}`
    l = recordToolStart(l, { sessionId: 's', agentId: 's:a', toolName: 'Read', inputData: { file_path: file }, toolUseId: id, toolCallId: id, time: n })
  }
  return l
}

const summary = () => render(<FileAttentionPanel visible fileAttention={new Map()} waste={ledger()} onClose={() => {}} />).container.querySelector('details > summary')!.textContent

test('en: the unit is the repeated target, never the call count', () => {
  assert.equal(summary(), 'Repeated reads and calls: 2 repeated targets observed')
})

test('fr: same unit', () => {
  act(() => setLocaleChoice('fr'))
  assert.equal(summary(), 'Lectures et appels répétés : 2 cibles répétées observées')
})
