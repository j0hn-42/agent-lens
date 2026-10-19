// #440: the shared waitFor helper polls a condition instead of sleeping a fixed time.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { waitFor } from './wait-for'

test('waitFor returns true as soon as the condition holds, without waiting for the cap', async () => {
  const start = Date.now()
  let ready = false
  setTimeout(() => { ready = true }, 120)
  const ok = await waitFor(() => ready, 5_000)
  assert.equal(ok, true)
  assert.ok(Date.now() - start < 2_000, `returned soon after the condition held (${Date.now() - start} ms)`)
})

test('waitFor returns false once the cap is reached and the condition never held', async () => {
  const start = Date.now()
  const ok = await waitFor(() => false, 200)
  assert.equal(ok, false)
  assert.ok(Date.now() - start >= 200, 'it waited up to the cap')
})

test('waitFor does not wait at all when the condition already holds', async () => {
  let calls = 0
  const ok = await waitFor(() => { calls++; return true }, 5_000)
  assert.equal(ok, true)
  assert.equal(calls, 1)
})
