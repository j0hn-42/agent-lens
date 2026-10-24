/**
 * The later updates of a page's loss figure (#613, #605 review): an update reaches the page only while it is the
 * current one (`isCurrent`), and none after `end()` (the ledger lets the page go). Pure: a fake panel and a ledger of
 * its own, whose page updates run at once.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ExtensionToWebviewMessage } from '../src/protocol'
import { startPanelPage } from '../src/panel-start'
import { PanelLossLedger } from '../src/panel-loss'

const ev = (sessionId: string, replayed = false) => ({ time: 0, type: 'message', payload: {}, sessionId, ...(replayed ? { replayed: true } : {}) }) as unknown as AgentEvent

function setup() {
  const ledger = new PanelLossLedger(200, fn => fn())
  for (let i = 0; i < 3; i++) ledger.note(ev('a'))
  const messages: ExtensionToWebviewMessage[] = []
  const panel = { markReady() {}, postMessage: (msg: ExtensionToWebviewMessage) => { messages.push(msg) }, setConnectionStatus() {} }
  const state = { current: true }
  const page = startPanelPage(panel, {
    collectActiveSessions: () => [], replaySessions: () => {}, disable1MContext: () => false, hooksConfigured: () => true,
    connectionStatus: () => 'test', isCurrent: () => state.current, ledger,
  })
  const losses = () => messages.filter(x => x.type === 'event-loss')
  return { ledger, page, state, losses }
}

describe('updates of the page figure (#613)', () => {
  it('a history read again lowers the current page\'s figure, and the page is told', () => {
    const { ledger, losses } = setup()
    assert.deepEqual(losses(), [{ type: 'event-loss', evicted: { a: 3 } }])
    ledger.note(ev('a', true))
    assert.deepEqual(losses().at(-1), { type: 'event-loss', evicted: { a: 2 } })
  })

  it('a page that is no longer the current one is not written to', () => {
    const { ledger, state, losses } = setup()
    state.current = false
    ledger.note(ev('a', true))
    assert.equal(losses().length, 1, 'only the figure sent on ready')
  })

  it('after end(), no update is sent to that page', () => {
    const { ledger, page, losses } = setup()
    page.end()
    ledger.note(ev('a', true))
    assert.equal(losses().length, 1, 'only the figure sent on ready')
  })
})
