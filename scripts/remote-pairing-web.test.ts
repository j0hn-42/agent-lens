/**
 * Web side of the pairing (#517): the page reads #pair=<token>, drops the fragment with history.replaceState BEFORE it
 * posts the token to POST /pair, so the token stays neither in the address bar, nor in the history, nor in a bookmark.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pairFromFragment, type PairingPage } from '../web/lib/remote-pairing'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q'

interface Call { kind: 'replaceState' | 'fetch'; url: string; init?: RequestInit; hashAtCall: string }

function page(hash: string, answer: number | Error = 204): { env: PairingPage; calls: Call[] } {
  const calls: Call[] = []
  const location = { hash, pathname: '/', search: '?session=77777777-7777-4777-8777-777777777777' }
  const env: PairingPage = {
    location,
    history: {
      state: { kept: true },
      replaceState: (_data, _unused, url) => {
        calls.push({ kind: 'replaceState', url: String(url), hashAtCall: location.hash })
        location.hash = ''
      },
    },
    fetch: async (url, init) => {
      calls.push({ kind: 'fetch', url: String(url), init, hashAtCall: location.hash })
      if (answer instanceof Error) throw answer
      return { status: answer } as Response
    },
  }
  return { env, calls }
}

describe('pairFromFragment (#517)', () => {
  it('drops the fragment first, then posts the token to /pair as JSON, same origin only', async () => {
    const { env, calls } = page(`#pair=${TOKEN}`)
    assert.equal(await pairFromFragment(env), 'paired')
    assert.deepEqual(calls.map(c => c.kind), ['replaceState', 'fetch'], 'replaceState must come BEFORE the POST')
    assert.equal(calls[0].url, '/?session=77777777-7777-4777-8777-777777777777', 'the new URL keeps the path and query, not the fragment')
    assert.ok(!calls[0].url.includes(TOKEN))
    assert.equal(calls[1].hashAtCall, '', 'the token was already out of the address bar when the POST left')
    assert.equal(calls[1].url, '/pair')
    const init = calls[1].init ?? {}
    assert.equal(init.method, 'POST')
    assert.equal(init.body, JSON.stringify({ token: TOKEN }))
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.referrerPolicy, 'no-referrer')
  })

  it('no #pair= fragment: nothing is touched, nothing is sent', async () => {
    for (const hash of ['', '#', '#session=1', '#pairing=x']) {
      const { env, calls } = page(hash)
      assert.equal(await pairFromFragment(env), 'none', hash)
      assert.deepEqual(calls, [], hash)
    }
  })

  it('a malformed token is dropped from the address bar too, and never sent', async () => {
    for (const hash of ['#pair=', '#pair=short', `#pair=${TOKEN}x`, `#pair=${TOKEN}&x=1`, '#pair=' + '%41'.repeat(43)]) {
      const { env, calls } = page(hash)
      assert.equal(await pairFromFragment(env), 'failed', hash)
      assert.deepEqual(calls.map(c => c.kind), ['replaceState'], hash)
    }
  })

  it('a refused token (401, 429, 403) or a network error is a failure, never "paired"', async () => {
    for (const answer of [401, 429, 403, 503, 200, new Error('offline')]) {
      const { env } = page(`#pair=${TOKEN}`, answer)
      assert.equal(await pairFromFragment(env), 'failed', String(answer))
    }
  })
})
