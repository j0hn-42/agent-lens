import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pairingBanner } from './pairing-banner'

const token = 'A'.repeat(42) + 'Q'
const base = { allowedHosts: ['box.tail1234.ts.net', 'lens.example.com:8443'], port: 4711, token, tokenFile: '/home/me/.agent-lens/pair-token' }

describe('pairingBanner (#517)', () => {
  it('on a terminal: one pairing URL per tunnel name and one for this machine, the token only after #pair=', () => {
    const text = pairingBanner({ ...base, isTTY: true })
    assert.ok(text.includes(`https://box.tail1234.ts.net/#pair=${token}`))
    assert.ok(text.includes(`https://lens.example.com:8443/#pair=${token}`))
    assert.ok(text.includes(`http://127.0.0.1:4711/#pair=${token}`))
    assert.ok(text.includes(base.tokenFile), 'names the token file')
    // The token appears nowhere but in a fragment
    const outside = text.split(`#pair=${token}`).join('')
    assert.ok(!outside.includes(token), 'the token appears outside a #pair= fragment')
  })

  it('not on a terminal (a pipe, a service log): the token is never printed, the URLs point to the token file', () => {
    const text = pairingBanner({ ...base, isTTY: false })
    assert.ok(!text.includes(token), 'the token reached a non-terminal output')
    assert.ok(text.includes('https://box.tail1234.ts.net/#pair='))
    assert.ok(text.includes('http://127.0.0.1:4711/#pair='))
    assert.ok(text.includes(base.tokenFile))
    assert.match(text, /not a terminal/)
  })

  it('says how to revoke (restart) and that the browser is not opened automatically', () => {
    for (const isTTY of [true, false]) {
      const text = pairingBanner({ ...base, isTTY })
      assert.match(text, /restart/i)
      assert.match(text, /not opened automatically/)
    }
  })
})
