/**
 * Shared setup of the relay + Gemini tests (#238). createRelay() runs once per process, so each
 * scenario has its own test file; the fixture (fake home, Gemini session of a workspace, /status
 * reader) lives here. Import it BEFORE ./relay: it fixes HOME and GEMINI_CLI_HOME.
 */
import '../extension/test/helpers/alias-vscode'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { geminiProjectHash } from '../extension/src/gemini-event-parser'

export const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-gemini-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
const geminiHome = path.join(fakeHome, 'gemini-home')
process.env.GEMINI_CLI_HOME = geminiHome

/** A workspace directory under the fake home, with no Gemini session yet. */
export function makeWorkspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(fakeHome, 'ws-')))
}

/** Writes Gemini session number `n` of `workspace` (its project hash is the hash of that workspace); returns its id. */
export function writeGeminiSession(workspace: string, n = 1): string {
  const chats = path.join(geminiHome, '.gemini', 'tmp', 'registry-slug', 'chats')
  fs.mkdirSync(chats, { recursive: true })
  const sessionId = `9c1d2e3f-0000-4000-8000-${String(n).padStart(12, '0')}`
  fs.writeFileSync(
    path.join(chats, `session-2026-10-12T09-00-${String(n).padStart(4, '0')}.jsonl`),
    JSON.stringify({ sessionId, projectHash: geminiProjectHash(workspace), startTime: '2026-01-05T09:00:00.000Z' }) + '\n' +
    JSON.stringify({ id: 'u1', timestamp: 't', type: 'user', content: 'Fix the bug' }) + '\n',
  )
  return sessionId
}

/** A workspace with one Gemini session whose project hash is the hash of that workspace. */
export function makeWorkspaceWithGeminiSession(): string {
  const workspace = makeWorkspace()
  writeGeminiSession(workspace)
  return workspace
}

export { statusOf } from './relay-status-of'
