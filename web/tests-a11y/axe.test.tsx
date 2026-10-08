// Automated axe-core checks on the key components, rendered in jsdom (issue #43).
//
// - No browser download needed: jsdom + @testing-library/react.
// - jsdom cannot compute layout or colors, so `color-contrast` is disabled here;
//   contrast is covered at the token level by scripts/contrast.test.ts.
// - Page-level rules (landmarks, h1, region) are disabled because components are
//   rendered in isolation, not as a full page.
// - Known violations live in known-violations.json (with the owning issue). The test
//   fails on a NEW violation and also when an allow-listed one disappears.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ControlBar } from '@/components/agent-visualizer/control-bar'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { ConversationPanel, type ConversationPanelProps } from '@/components/agent-visualizer/conversation-panel'
import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { ToolDetailPopup } from '@/components/agent-visualizer/tool-detail-popup'
import { DiscoveryDetailPopup } from '@/components/agent-visualizer/discovery-detail-popup'
import { GlassContextMenu } from '@/components/agent-visualizer/glass-context-menu'
import { ShortcutsDialog } from '@/components/agent-visualizer/shortcuts-dialog'
import { LinkPanel } from '@/components/agent-visualizer/link-panel'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import type { AgentLink } from '@/hooks/simulation/types'
import { TimelinePanel } from '@/components/agent-visualizer/timeline-panel'
import type { Agent, FileAttention, TimelineEntry, TimelineEvent } from '@/lib/agent-types'
import type { SessionInfo } from '@/lib/bridge-types'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { compareViolations, validateKnownViolations, type KnownViolation } from './axe-compare'

const known: KnownViolation[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'known-violations.json'), 'utf8'),
)

afterEach(() => cleanup())

async function axeRuleIds(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: {
      'color-contrast': { enabled: false },
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
    },
  })
  return results.violations.map(v => v.id)
}

async function check(scenario: string, container: HTMLElement) {
  const found = await axeRuleIds(container)
  const { unexpected, stale } = compareViolations(scenario, found, known)
  assert.deepEqual(unexpected, [], `[${scenario}] new axe violations (fix them, or allow-list with an issue number): ${unexpected.join(', ')}`)
  assert.deepEqual(stale, [], `[${scenario}] allow-listed violations no longer occur, remove them from known-violations.json: ${stale.join(', ')}`)
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const noop = () => {}
const sessions: SessionInfo[] = [
  { id: 's1', label: 'Main session', status: 'active', startTime: 0, lastActivityTime: 1000 },
  { id: 's2', label: 'Old session', status: 'completed', startTime: 0, lastActivityTime: 500 },
]
const messages: ConversationMessage[] = [
  { id: 'm1', type: 'user', content: 'Fix the bug', timestamp: 1 },
  { id: 'm2', type: 'assistant', content: 'Looking at the code', timestamp: 2 },
  { id: 'm3', type: 'thinking', content: 'Considering options', timestamp: 3 },
  { id: 'm4', type: 'tool_call', content: 'Read(file.ts)', timestamp: 4 },
]
const agent = {
  id: 'a1', name: 'main', state: 'thinking', parentId: null, tokensUsed: 1000, tokensMax: 200000,
  contextBreakdown: {}, toolCalls: 1, timeAlive: 5, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: true,
} as unknown as Agent
const files = new Map<string, FileAttention>([
  ['src/a.ts', { path: 'src/a.ts', reads: 2, edits: 1, totalTokens: 500, lastAccessed: 1, agents: ['a1'] }],
])
const timelineEntries = new Map<string, TimelineEntry>([
  ['a1', {
    id: 't1', agentId: 'a1', agentName: 'main', startTime: 0, endTime: 10,
    blocks: [
      { id: 'b1', type: 'thinking', startTime: 0, endTime: 4, label: 'thinking', color: '#66ccff' },
      { id: 'b2', type: 'tool_call', startTime: 4, endTime: 8, label: 'Read', color: '#ffaa33' },
    ],
  }],
])
const timelineEvents: TimelineEvent[] = [
  { id: 'e1', type: 'tool_call', label: 'Read', timestamp: 2 },
  { id: 'e2', type: 'error', label: 'Fail', timestamp: 6 },
]
const topBarProps: TopBarProps = {
  sessions, selectedSessionId: 's1', sessionsWithActivity: new Set(['s2']),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 1000, totalCost: 0.12,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, showStats: false, onToggleMute: noop, onOpenShortcuts: noop,
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('known-violations.json is well formed', () => {
  assert.deepEqual(validateKnownViolations(known), [])
})

test('shell: top bar', async () => {
  // index.tsx provides #visualizer-main (target of the tabs' aria-controls)
  const { container } = render(<><TopBar {...topBarProps} /><main id="visualizer-main" /></>)
  await check('top-bar', container)
})

test('shell: control bar', async () => {
  const { container } = render(
    <ControlBar
      isPlaying={false} speed={1} currentTime={3} totalDuration={10}
      onPlayPause={noop} onRestart={noop} onSpeedChange={noop} onSeek={noop}
      timelineEvents={timelineEvents}
    />,
  )
  await check('control-bar', container)
})

test('shell: control bar in review mode (play button, scrubber, resume)', async () => {
  const { container, getByRole } = render(
    <ControlBar
      isPlaying={false} speed={1} currentTime={3} totalDuration={10} isReviewing eventCount={4}
      onPlayPause={noop} onRestart={noop} onSpeedChange={noop} onSeek={noop} onResumeLive={noop}
      timelineEvents={timelineEvents}
    />,
  )
  // Guard against checking the wrong bar: these only exist in review mode.
  getByRole('button', { name: 'Play' })
  getByRole('slider', { name: 'Timeline position' })
  await check('control-bar-review', container)
  const clear = getByRole('button', { name: 'Clear history' })
  await act(async () => { fireEvent.click(clear) })
  getByRole('group', { name: 'Confirm clearing history' })
  await check('control-bar-review-confirm', container)
})

const listAgents = new Map([
  ['s1:main', { id: 's1:main', sessionId: 's1', parentKey: null, name: 'main', state: 'thinking', kind: 'main' as const, tokensUsed: 1200, spawnTime: 1 }],
  ['s1:sub', { id: 's1:sub', sessionId: 's1', parentKey: 's1:main', name: 'explore repo', state: 'tool_calling', kind: 'subagent' as const, currentTool: 'Grep', tokensUsed: 300, spawnTime: 2 }],
])

test('panel: sessions list', async () => {
  const { container } = render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set(['s2'])}
      onSelectSession={noop} onCloseSession={noop} agents={listAgents} selectedAgentId="s1:sub" onSelectAgent={noop}
      now={10_000}
    />,
  )
  await check('session-list-panel', container)
})

test('panel: sessions list with a team and runtime badges', async () => {
  const teamSessions = [
    { ...sessions[0], runtime: 'codex' as const },
    { ...sessions[1], teamName: 'alpha', runtime: 'claude' as const },
  ]
  const teams = new Map([['alpha', { name: 'alpha', leadSessionId: 's1', members: [{ name: 'a' }, { name: 'b' }] }]])
  const { container } = render(
    <SessionListPanel
      visible onClose={noop} sessions={teamSessions} selectedSessionId="team:alpha" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={listAgents} selectedAgentId={null} onSelectAgent={noop}
      teams={teams} teamWorking={new Map([['alpha', 1]])} now={10_000}
    />,
  )
  await check('session-list-panel-team', container)
})

test('panel: sessions list grouped by project', async () => {
  const grouped = [
    { ...sessions[0], projectId: 'pa', projectName: 'alpha' },
    { ...sessions[1], projectId: 'pb', projectName: 'beta' },
  ]
  const { container, getByText } = render(
    <SessionListPanel
      visible onClose={noop} sessions={grouped} selectedSessionId="s1" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={listAgents} selectedAgentId={null} onSelectAgent={noop}
      now={10_000}
    />,
  )
  assert.ok(getByText('alpha') && getByText('beta'), 'one heading per project')
  await check('session-list-panel-projects', container)
})

// The panel is controlled by its parent (open / pill): this wrapper plays the part of the shell.
function Conversation(props: Omit<ConversationPanelProps, 'open' | 'onOpen' | 'onClose'> & { initialOpen?: boolean }) {
  const { initialOpen = false, ...rest } = props
  const [open, setOpen] = React.useState(initialOpen)
  return <ConversationPanel {...rest} open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} />
}

test('panel: conversation (collapsed pill and open panel)', async () => {
  const agents = new Map<string, Agent>([['a1', agent]])
  const conversations = new Map<string, ConversationMessage[]>([['a1', messages]])
  const { container } = render(
    <Conversation conversations={conversations} agents={agents} onAgentClick={noop} selectedAgentId={null} />,
  )
  await check('conversation-collapsed', container)
  const pill = container.querySelector('button')
  assert.ok(pill, 'the pill is a button that opens the panel')
  await act(async () => { fireEvent.click(pill) })
  assert.ok(container.querySelector('[role="log"]'), 'the open panel lists the messages')
  await check('conversation-open', container)
})

test('panel: conversation open from the start, including tool calls (transcript and agent preset)', async () => {
  const agents = new Map<string, Agent>([['a1', agent]])
  const conversations = new Map<string, ConversationMessage[]>([['a1', messages]])
  const { container } = render(
    <Conversation initialOpen conversations={conversations} agents={agents} onAgentClick={noop} selectedAgentId="a1" />,
  )
  assert.ok(container.textContent?.includes('Read'), 'tool calls are listed')
  await check('conversation-agent-preset', container)
})

test('panel: file attention', async () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} onOpenFile={noop} />)
  await check('file-attention', container)
})

test('popup: tool detail', async () => {
  const { container } = render(
    <ToolDetailPopup
      tool={{ id: 'x', toolName: 'Read', state: 'complete', args: 'file.ts', result: 'ok', tokenCost: 10 }}
      position={{ x: 100, y: 100 }} onClose={noop}
    />,
  )
  await check('tool-popup', container)
})

test('popup: discovery detail', async () => {
  const { container } = render(
    <DiscoveryDetailPopup
      discovery={{ id: 'd', type: 'file', label: 'a.ts', content: 'content', agentId: 'a1' }}
      agentName="main" position={{ x: 100, y: 100 }} onClose={noop}
    />,
  )
  await check('discovery-popup', container)
})

test('popup: context menu', async () => {
  const { container } = render(
    <GlassContextMenu
      position={{ x: 50, y: 50 }} onClose={noop}
      items={[{ label: 'Pin', onClick: noop }, { label: '', onClick: noop, separator: true }, { label: 'Remove', onClick: noop, danger: true }]}
    />,
  )
  await check('context-menu', container)
})

test('dialog: keyboard shortcuts', async () => {
  const { container } = render(
    <ShortcutsDialog open onClose={noop} singleKeyEnabled onSingleKeyEnabledChange={noop} />,
  )
  await check('shortcuts-dialog', container)
})

test('timeline: canvas view and table view', async () => {
  const { container } = render(
    <TimelinePanel visible timelineEntries={timelineEntries} currentTime={5} onClose={noop} />,
  )
  await check('timeline-canvas', container)
  const toggle = container.querySelector('button[aria-controls]')
  assert.ok(toggle, 'timeline has a table view toggle')
  await act(async () => { fireEvent.click(toggle) })
  assert.ok(container.querySelector('table'), 'table view renders a <table>')
  await check('timeline-table', container)
})

// ─── Teams, communication links, legend ──────────────────────────────────────

const teammate = {
  ...agent, id: 'a2', name: 'reviewer', isMain: false, parentId: 'a1', kind: 'teammate', teamName: 'alpha', teamColor: '#4488ff',
} as unknown as Agent
const teamAgents = new Map<string, Agent>([['a1', agent], ['a2', teammate]])
const teamLink: AgentLink = {
  id: 'a1->a2', from: 'a1', to: 'a2', kind: 'teammate', sessionId: 's1', dropped: 0,
  messages: [
    { id: 'l1', type: 'message', content: 'Please review the diff', timestamp: 1, from: 'a1', to: 'a2' },
    { id: 'l2', type: 'message', content: 'x'.repeat(900), timestamp: 2, from: 'a2', to: 'a1' },
  ],
}
const teamMap = new Map([['alpha', { name: 'alpha', leadSessionId: 's1', members: [{ name: 'main' }, { name: 'reviewer', color: 'blue' }] }]])

test('panel: link panel (collapsed and expanded long message)', async () => {
  const { container, getByRole } = render(<LinkPanel link={teamLink} agents={teamAgents} onClose={noop} />)
  await check('link-panel', container)
  const showAll = Array.from(container.querySelectorAll('button')).find(b => /show all/i.test(b.textContent ?? ''))
  assert.ok(showAll, 'the long message exposes a "Show all" button')
  const collapsedLength = (container.textContent ?? '').length
  await act(async () => { fireEvent.click(showAll) })
  assert.ok((container.textContent ?? '').length > collapsedLength, 'expanding reveals more of the message')
  assert.ok(getByRole('dialog'))
  await check('link-panel-expanded', container)
})

test('panel: conversation with links and teams', async () => {
  const conversations = new Map<string, ConversationMessage[]>([['a1', messages]])
  const links = new Map<string, AgentLink>([[teamLink.id, teamLink]])
  const { container } = render(
    <Conversation
      conversations={conversations} agents={teamAgents} onAgentClick={noop} selectedAgentId={null}
      links={links} droppedMessages={new Map([['a1', 3]])} teams={teamMap}
    />,
  )
  const pill = container.querySelector('button')
  assert.ok(pill)
  await act(async () => { fireEvent.click(pill) })
  await check('conversation-teams', container)
})

test('canvas chrome: graph legend (closed and open, with a team)', async () => {
  const team = { key: 'alpha', name: 'alpha', color: '#4488ff', memberIds: ['a1', 'a2'], memberNames: ['main', 'reviewer'], text: 'Team alpha: main (working), reviewer (idle)' }
  const { container } = render(<GraphLegend teams={[team]} />)
  await check('legend-closed', container)
  const toggle = container.querySelector('button')
  assert.ok(toggle, 'legend exposes a toggle')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'legend starts collapsed')
  await act(async () => { fireEvent.click(toggle) })
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'legend is expanded before the open check')
  await check('legend-open', container)
})
