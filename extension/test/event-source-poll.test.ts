/**
 * JsonlEventSource : sans fs.watch (ENOSPC/EMFILE) ou après une erreur du watcher,
 * le polling de secours continue de lire les nouvelles lignes (#140).
 */
import './helpers/alias-vscode'
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsonlEventSource } from '../src/event-source'
import { POLL_FALLBACK_MS } from '../src/constants'
import type { AgentEvent } from '../src/protocol'

const line = (n: number) => JSON.stringify({ type: 'message', time: n, payload: {} }) + '\n'

describe('JsonlEventSource : polling de secours', () => {
  it('lit les nouvelles lignes quand fs.watch lève ENOSPC', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-evsrc-'))
    const file = path.join(dir, 'events.jsonl')
    const watch = mock.method(require('node:fs'), 'watch', () => { throw Object.assign(new Error('limit'), { code: 'ENOSPC' }) })
    mock.timers.enable({ apis: ['setInterval'] })
    const src = new JsonlEventSource(file)
    try {
      const got: AgentEvent[] = []
      src.onEvent(e => got.push(e))
      src.start()
      fs.appendFileSync(file, line(1))
      mock.timers.tick(POLL_FALLBACK_MS)
      assert.equal(got.length, 1)
      fs.appendFileSync(file, line(2))
      mock.timers.tick(POLL_FALLBACK_MS)
      assert.equal(got.length, 2)
    } finally {
      src.dispose()
      mock.timers.reset()
      watch.mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
