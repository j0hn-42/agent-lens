/**
 * Shared setup of the relay + Gemini tests (#238). createRelay() runs once per process, so each
 * scenario has its own test file; the fixture (fake home, Gemini session of a workspace, /status
 * reader) lives here. Import it BEFORE ./relay: it fixes HOME and GEMINI_CLI_HOME.
 */
import '../extension/test/helpers/alias-vscode'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { geminiProjectHash } from '../extension/src/gemini-event-parser'
import { isStatusPath } from '../extension/src/relay-guards'

export const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-gemini-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
const geminiHome = path.join(fakeHome, 'gemini-home')
process.env.GEMINI_CLI_HOME = geminiHome

/** A workspace with one Gemini session whose project hash is the hash of that workspace. */
export function makeWorkspaceWithGeminiSession(): string {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(fakeHome, 'ws-')))
  const chats = path.join(geminiHome, '.gemini', 'tmp', 'registry-slug', 'chats')
  fs.mkdirSync(chats, { recursive: true })
  fs.writeFileSync(
    path.join(chats, 'session-2026-10-12T09-00-0001.jsonl'),
    JSON.stringify({ sessionId: '9c1d2e3f-0000-4000-8000-000000000001', projectHash: geminiProjectHash(workspace), startTime: '2026-01-05T09:00:00.000Z' }) + '\n' +
    JSON.stringify({ id: 'u1', timestamp: 't', type: 'user', content: 'Fix the bug' }) + '\n',
  )
  return workspace
}

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>

/** GET /status of a relay, served on a loopback port for the call. */
export async function statusOf(relay: Relay): Promise<{ runtimes: string[]; sessionCount: number }> {
  const server = http.createServer((req, res) => {
    if (isStatusPath(req.url)) return relay.handleStatus(req, res)
    res.writeHead(404); res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/status', agent: false }, res => {
        let b = ''
        res.on('data', c => { b += c })
        res.on('end', () => resolve(b))
      }).on('error', reject)
    })
    return JSON.parse(body)
  } finally { server.close() }
}
