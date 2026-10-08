/** Constantes qui doivent rester alignées entre extension, relais et web (#122): une divergence donnerait des états contradictoires. */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SNAPSHOT_STALE_AFTER_MS, RELAY_ISSUE_LINKS_CACHE_TTL_MS, RELAY_SESSION_INDEX_CACHE_MS, RELAY_SSE_HEARTBEAT_MS } from '../extension/src/constants'
import { STALE_AFTER_MS } from '../web/lib/canvas-constants'
import { PROJECT_CONTEXT_TTL_MS } from '../web/lib/project-context'
import { ISSUE_LINKS_CACHE_TTL_MS } from '../web/lib/issue-links'
import { HEARTBEAT_INTERVAL_MS } from '../web/lib/reconnect'

test('le seuil de péremption est le même dans l\'UI et dans l\'action observations', () => {
  assert.equal(STALE_AFTER_MS, SNAPSHOT_STALE_AFTER_MS)
})

test('le TTL du cache d\'issue-links est le même côté relais, hook web et contexte projet', () => {
  assert.equal(ISSUE_LINKS_CACHE_TTL_MS, RELAY_ISSUE_LINKS_CACHE_TTL_MS)
  assert.equal(PROJECT_CONTEXT_TTL_MS, RELAY_ISSUE_LINKS_CACHE_TTL_MS)
})

test('le cache de l\'index de sessions est une constante nommée', () => {
  assert.equal(RELAY_SESSION_INDEX_CACHE_MS, 30_000)
})

test('le battement de cœur du client suit celui du relais', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, RELAY_SSE_HEARTBEAT_MS)
})
