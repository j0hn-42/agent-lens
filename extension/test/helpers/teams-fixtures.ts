/**
 * SYNTHETIC fixtures that mimic the on-disk structures of Claude Code Agent Teams.
 * Never copy real transcript or team content here.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, WatchedSession } from '../../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../../src/transcript-parser'
import type { SubagentWatcherDelegate } from '../../src/subagent-watcher'

export const LEAD_SESSION = '11111111-1111-4111-8111-111111111111'

export function tmpDir(prefix = 'agent-lens-teams-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export const userText = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', message: { role: 'user', content: text }, ...extra })
export const assistantText = (text: string) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
export const assistantThinking = (text: string) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } })
export const assistantToolUse = (id: string, name = 'Read', input: Record<string, unknown> = { file_path: '/x' }) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
export const toolResult = (id: string, content = 'ok') =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })

export function writeJsonl(file: string, entries: unknown[], mtimeMs?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
}

export interface TeammateFixture {
  agentId: string
  meta?: Record<string, unknown> | null
  entries: unknown[]
  /** File mtime (ms); default: now */
  mtimeMs?: number
}

export function teammateMeta(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentType: name, description: `${name} task`, name, model: 'claude-sonnet-4-5',
    taskKind: 'in_process_teammate', teamName: 'demo-team', color: 'blue',
    spawnedAgentType: 'general-purpose', permissionMode: 'default', spawnDepth: 1,
    ...over,
  }
}

export function writeTeammate(subDir: string, fx: TeammateFixture): string {
  const file = path.join(subDir, `agent-${fx.agentId}.jsonl`)
  writeJsonl(file, fx.entries, fx.mtimeMs)
  if (fx.meta !== null) {
    fs.writeFileSync(path.join(subDir, `agent-${fx.agentId}.meta.json`), JSON.stringify(fx.meta ?? teammateMeta(fx.agentId)))
  }
  return file
}

export function makeSession(overrides: Partial<WatchedSession> = {}): WatchedSession {
  return {
    sessionId: 's1', filePath: '', fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    seenMessageHashes: new Set(), sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null, subagentWatchers: new Map(),
    spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'x', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    ...overrides,
  }
}

export function makeHarness(session: WatchedSession) {
  const events: AgentEvent[] = []
  const parserDelegate: TranscriptParserDelegate = {
    emit: (e) => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(parserDelegate)
  const delegate = {
    emit: (e: AgentEvent) => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session,
    getLastActivityTime: () => 0,
    resetInactivityTimer: () => {},
  } as unknown as SubagentWatcherDelegate
  const closeWatchers = () => {
    for (const st of session.subagentWatchers.values()) st.watcher?.close()
    session.subagentsDirWatcher?.close()
  }
  return { parser, delegate, events, closeWatchers }
}

export const ofType = (events: AgentEvent[], type: string) => events.filter(e => e.type === type)

export function teamConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo-team',
    createdAt: 1_700_000_000_000,
    leadAgentId: 'team-lead@demo-team',
    leadSessionId: LEAD_SESSION,
    members: [
      { agentId: 'team-lead@demo-team', name: 'team-lead', agentType: 'team-lead', joinedAt: 1_700_000_000_000, tmuxPaneId: 'leader', cwd: '/work/demo', subscriptions: [], backendType: 'in-process' },
      { agentId: 'alice@demo-team', name: 'alice', agentType: 'general-purpose', joinedAt: 1_700_000_001_000, tmuxPaneId: 'in-process', cwd: '/work/demo', subscriptions: [], backendType: 'in-process', color: 'green' },
    ],
    ...over,
  }
}

export function writeTeam(teamsDir: string, dirName: string, config: unknown, inboxes: Record<string, unknown> = {}): string {
  const dir = path.join(teamsDir, dirName)
  fs.mkdirSync(path.join(dir, 'inboxes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
  for (const [member, content] of Object.entries(inboxes)) {
    fs.writeFileSync(path.join(dir, 'inboxes', `${member}.json`), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}
