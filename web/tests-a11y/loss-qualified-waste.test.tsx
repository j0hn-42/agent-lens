// #366: the "Repeated reads and calls" section qualifies its numbers and its absence when the relay could not replay events.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { WasteSection } from '@/components/agent-visualizer/waste-section'
import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { emptyWasteLedger, recordToolStart, recordToolEnd, describeWaste, wasteSummary, type WasteLedger } from '@/lib/waste'

afterEach(() => { cleanup(); document.body.replaceChildren() })

function ledgerWithRepeats(): WasteLedger {
  let l = emptyWasteLedger()
  for (let i = 0; i < 3; i++) {
    const call = { sessionId: 's1', agentId: 's1:main', toolName: 'Read', inputData: { file_path: '/repo/a.ts' }, toolCallId: `t${i}`, time: i }
    l = recordToolStart(l, call)
    l = recordToolEnd(l, `t${i}`, 100, 'reported')
  }
  return l
}

test('nothing lost: the section reads as before (no noise)', () => {
  const { container } = render(<WasteSection waste={ledgerWithRepeats()} />)
  const text = container.textContent ?? ''
  assert.match(text, /read again 2 times, no edit seen in between/)
  assert.doesNotMatch(text, /at least|incomplete|not replayed/)
  cleanup()
  const empty = render(<WasteSection waste={emptyWasteLedger()} />)
  assert.match(empty.container.textContent ?? '', /No repeat observed(?! \()/)
})

test('events lost: the repeat count is "at least N", the absence is "(incomplete)", and the loss is said', () => {
  const { container } = render(<WasteSection waste={ledgerWithRepeats()} replayLost={7} />)
  const text = container.textContent ?? ''
  assert.match(text, /read again at least 2 times, no edit seen in between/)
  assert.match(text, /at least 7 earlier events were not replayed by the relay/)
  cleanup()
  const empty = render(<WasteSection waste={emptyWasteLedger()} replayLost={7} />)
  const t = empty.container.textContent ?? ''
  assert.match(t, /No repeat observed \(incomplete\)/)
  assert.match(t, /at least 7 earlier events were not replayed by the relay/)
})

test('describeWaste keeps the singular under loss', () => {
  const [item] = wasteSummary(ledgerWithRepeats()).items
  assert.equal(describeWaste({ ...item, repeats: 1 }, 3), 'read again at least 1 time, no edit seen in between')
  assert.equal(describeWaste({ ...item, repeats: 1 }), 'read again 1 time, no edit seen in between')
})

test('the Files panel hands its replay loss to the section', () => {
  const { container } = render(
    <FileAttentionPanel visible fileAttention={new Map()} onClose={() => {}} agentLabel={k => k} waste={ledgerWithRepeats()} replayLost={4} />,
  )
  assert.match(container.textContent ?? '', /read again at least 2 times/)
})
