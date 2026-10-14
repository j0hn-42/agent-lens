// #346: the web side knows the OpenCode runtime (badge, session filter, session validation).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { runtimeBadge } from '../web/lib/chrome-utils'
import { runtimeOptions } from '../web/lib/session-filter'
import { isSessionInfo } from '../web/lib/bridge-types'

const base = { id: 's', label: 'l', status: 'active', startTime: 1, lastActivityTime: 2 }

test('runtimeBadge: OpenCode has the short tag OC and the full name OpenCode', () => {
  assert.deepEqual(runtimeBadge('opencode'), { short: 'OC', label: 'OpenCode' })
})

test('runtimeOptions lists opencode when a session uses it', () => {
  assert.deepEqual(runtimeOptions([{ runtime: 'opencode' }, { runtime: 'claude' }]), ['claude', 'opencode'])
})

test('isSessionInfo accepts runtime opencode and still refuses an unknown runtime', () => {
  assert.equal(isSessionInfo({ ...base, runtime: 'opencode' }), true)
  assert.equal(isSessionInfo({ ...base, runtime: 'nope' }), false)
})
