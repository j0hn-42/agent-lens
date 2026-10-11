import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseNotifyMessage, NotifyThrottle, showNativeNotification, NOTIFY_BODY_MAX } from '../src/notify'

describe('parseNotifyMessage (webview input is untrusted)', () => {
  it('accepts a known trigger with a title and a body', () => {
    assert.deepEqual(parseNotifyMessage({ type: 'notify', trigger: 'attention', title: 'Agent Lens', body: '1 waiting' }),
      { trigger: 'attention', title: 'Agent Lens', body: '1 waiting' })
  })
  it('refuses an unknown trigger, a missing or non-string body and a non-object', () => {
    for (const bad of [null, 3, 'x', {}, { trigger: 'attention' }, { trigger: 'evil', title: 't', body: 'b' },
      { trigger: 'cost', title: 1, body: 'b' }, { trigger: 'cost', title: 't', body: { a: 1 } }, { trigger: 'cost', title: 't', body: '' }]) {
      assert.equal(parseNotifyMessage(bad), null, JSON.stringify(bad))
    }
  })
  it('strips control characters and caps the length', () => {
    const out = parseNotifyMessage({ trigger: 'complete', title: 'T\u0007‮', body: `a\nb${'x'.repeat(NOTIFY_BODY_MAX * 2)}` })
    assert.ok(out)
    assert.equal(out.title, 'T')
    assert.ok(out.body.length <= NOTIFY_BODY_MAX)
    assert.ok(!/[\u0000-\u001F]/.test(out.body))
  })
})

describe('NotifyThrottle', () => {
  it('lets one message per trigger through per window, triggers are independent', () => {
    const t = new NotifyThrottle(1000)
    assert.equal(t.allow('cost', 0), true)
    assert.equal(t.allow('cost', 500), false)
    assert.equal(t.allow('attention', 500), true)
    assert.equal(t.allow('cost', 1000), true)
  })
})

describe('showNativeNotification', () => {
  const msg = { trigger: 'attention' as const, title: 'Agent Lens', body: '1 waiting' }
  it('warns for attention and cost, informs for a finished session', () => {
    const calls: string[] = []
    const ui = { showWarningMessage: (m: string) => { calls.push(`warn:${m}`) }, showInformationMessage: (m: string) => { calls.push(`info:${m}`) } }
    showNativeNotification(msg, { focused: false }, ui)
    showNativeNotification({ ...msg, trigger: 'cost', body: 'Cost reached $6.00' }, { focused: false }, ui)
    showNativeNotification({ ...msg, trigger: 'complete', body: 'Session finished: x' }, { focused: false }, ui)
    assert.deepEqual(calls, ['warn:Agent Lens: 1 waiting', 'warn:Agent Lens: Cost reached $6.00', 'info:Agent Lens: Session finished: x'])
  })
  it('stays silent while the Agent Lens panel is the focused view', () => {
    const calls: string[] = []
    const ui = { showWarningMessage: () => { calls.push('w') }, showInformationMessage: () => { calls.push('i') } }
    showNativeNotification(msg, { focused: true }, ui)
    assert.deepEqual(calls, [])
  })
})
