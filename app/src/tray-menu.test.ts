import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrayMenu, isLoopbackUrl, sessionsLabel } from './tray-menu'

describe('sessionsLabel (#335)', () => {
  it('states the count only when /status proves it', () => {
    assert.equal(sessionsLabel({ sessionCount: 0 }), '0 sessions suivies')
    assert.equal(sessionsLabel({ sessionCount: 1 }), '1 session suivie')
    assert.equal(sessionsLabel({ sessionCount: 3 }), '3 sessions suivies')
  })
  it('never invents a number: unknown otherwise', () => {
    for (const bad of [null, undefined, {}, { sessionCount: '3' }, { sessionCount: -1 }, { sessionCount: 1.5 }, { sessionCount: NaN }, 'x']) {
      assert.equal(sessionsLabel(bad), 'État indisponible', JSON.stringify(bad))
    }
  })
})

describe('isLoopbackUrl (#335)', () => {
  it('accepts only http loopback hosts', () => {
    assert.equal(isLoopbackUrl('http://localhost:3001/'), true)
    assert.equal(isLoopbackUrl('http://127.0.0.1:3001'), true)
    assert.equal(isLoopbackUrl('http://[::1]:3001'), true)
    assert.equal(isLoopbackUrl('http://example.com:3001'), false)
    assert.equal(isLoopbackUrl('https://evil.test'), false)
    assert.equal(isLoopbackUrl('not a url'), false)
  })
})

describe('buildTrayMenu (#335)', () => {
  const url = 'http://localhost:3001/'
  it('lists open UI, state, URL, quit, in order, each with a text label', () => {
    const m = buildTrayMenu({ sessionCount: 2 }, url)
    assert.deepEqual(m.map(i => i.id), ['open', 'state', 'url', 'quit'])
    assert.ok(m.every(i => i.label.trim().length > 0))
    assert.equal(m[1].label, '2 sessions suivies')
    assert.equal(m[1].enabled, false)
    assert.equal(m[2].label, url)
  })
  it('keeps open/url/quit actionable and works without status', () => {
    const m = buildTrayMenu(null, url)
    assert.equal(m[1].label, 'État indisponible')
    assert.deepEqual(m.filter(i => i.enabled).map(i => i.id), ['open', 'url', 'quit'])
  })
  it('refuses a non-loopback URL: no open, no url entries', () => {
    const m = buildTrayMenu({ sessionCount: 1 }, 'http://example.com')
    assert.deepEqual(m.map(i => i.id), ['state', 'quit'])
  })
})
