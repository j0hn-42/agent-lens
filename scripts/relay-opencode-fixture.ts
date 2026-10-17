/**
 * Shared setup of the relay + OpenCode tests (#346). createRelay() runs once per process, so each
 * scenario has its own test file; the fixture (fake home, SQLite database holding a recent root
 * session of a workspace, /status reader) lives here. Import it BEFORE ./relay: it fixes HOME.
 */
import '../extension/test/helpers/alias-vscode'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { OpenCodeFixture } from '../extension/test/helpers/opencode-fixture'

export { statusOf } from './relay-status-of'

export const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-opencode-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.XDG_DATA_HOME

/** A workspace directory under the fake home. */
export function makeWorkspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(fakeHome, 'ws-')))
}

/** A database with one recent root session of the workspace; returns the database path. */
export function makeDbWithSession(workspace: string): string {
  const file = path.join(fakeHome, 'opencode.db')
  const fx = new OpenCodeFixture(file)
  const now = Date.now()
  fx.session('ses_relay', { dir: workspace, created: now - 5000, updated: now - 1000 })
  fx.close()
  return file
}
