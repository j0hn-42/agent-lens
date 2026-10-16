/**
 * Guided tour of a REAL session (#244). The demo tour (guided-steps.ts) replays a scripted scenario; here the
 * steps are built from what the canvas proves is on screen (legend-presence.ts), so the tour explains the
 * symbols you can see and never mentions one that is absent. A step has no scenario time: the scene stays live.
 * Runtime imports are relative (the root test runner has no "@/" alias).
 */
import type { TourStep } from './guided-steps'
import { LEGEND_ENTRIES, type LegendEntryId, type LegendSectionId } from './legend-entries'
import type { LegendPresence } from './legend-presence'
import { CONTEXT_WINDOW_NAME } from './ui-glossary'
import { cleanText } from '../components/agent-visualizer/canvas/team-style'

/** One sentence per legend entry. It describes the symbol, never the session: the facts come from the presence. */
export const LIVE_ENTRY_TEXT: Readonly<Record<LegendEntryId, string>> = {
  'state-idle': 'Idle: the agent has nothing to do right now and waits for its next turn.',
  'state-thinking': 'Thinking: the agent is working out its next step.',
  'state-tool_calling': 'Calling a tool: a tool call of this agent is running.',
  'state-waiting_permission': 'Waiting: the agent asked for a permission and is blocked until you answer it in your terminal.',
  'state-error': 'Error: the agent reported an error. Open the agent to read it.',
  'state-paused': 'Paused: the agent was paused.',
  'state-complete': 'Done: the agent finished.',
  'shape-main': 'A large hexagon is a main agent, the root of a session.',
  'shape-sub': 'A small hexagon is a sub-agent or a teammate.',
  'shape-tool': 'A rounded card is a tool call.',
  'shape-discovery': 'A card with a colour bar is a discovery, such as a file a search call listed.',
  'shape-complete': 'A dashed outline marks an agent that finished.',
  'edge-parent': 'A thick line joins a parent to its sub-agent; the events confirm the link.',
  'edge-unverified': 'A dashed line is a parent link that the events do not confirm: treat it as unproven.',
  'edge-tool': 'A thin amber line joins a tool call to its agent.',
  'edge-file-conflict': 'A red dash-dot line with a diamond joins two agents that edited the same file, each edit observed to succeed. The Files panel lists the files.',
  'edge-badge-hidden': 'A "+N" badge means N agents are hidden in a folded branch. Click it to unfold.',
  'edge-badge-active': 'A green badge counts the active agents of a folded branch.',
  'particle-dispatch': 'A purple dot carries a task from a parent to a sub-agent.',
  'particle-return': 'A green dot carries a result back to the parent.',
  'team-ring': 'A coloured outer ring marks a teammate of an Agent Team.',
  'team-idle': 'A hollow ring: the teammate is idle.',
  'team-working': 'An open arc: the teammate is working.',
  'team-done': 'A filled dot: the teammate is done.',
  'team-archived': 'A faded dashed outline is an archived agent: finished, kept on screen and still clickable.',
  'team-halo': 'A dashed halo groups a team or a workflow.',
  'session-halo': 'A dotted halo groups the agents of one session. Its label gives runtime, workspace, status and cost; click it to zoom to the cluster.',
  orchestrator: 'A crown with a LEAD (team) or MAIN (session) badge marks the orchestrator.',
  'team-row': 'The legend lists each team with its member count.',
  'link-flight': 'Long purple dashes: a message is in flight.',
  'link-recent': 'A solid green line: a message arrived recently.',
  'link-error': 'A dotted red line: the message link reported an error.',
  'link-quiet': 'A thin faded line is a quiet link; its badge is the message count. Click it to read the messages.',
  'link-bubble': 'A bubble on a link shows its latest message. Click it to open the link panel.',
  'ctx-system': 'System prompt: part of the context window.',
  'ctx-user': 'User messages: part of the context window.',
  'ctx-tool-results': 'Tool results: part of the context window.',
  'ctx-reasoning': 'Reasoning: part of the context window.',
  'ctx-subagent': 'Sub-agent results: part of the context window.',
  'disc-file': 'File: a path a successful Glob or Grep call listed in its output, at most a few per call.',
  'disc-pattern': 'Pattern: an agent pinned a pattern.',
  'disc-finding': 'Finding: an agent pinned a finding.',
  'disc-code': 'Code: an agent pinned a piece of code.',
  'rt-claude': 'The Claude spark logo: the agent runs on Claude Code.',
  'rt-codex': 'The knot logo: the agent runs on Codex.',
  'rt-copilot': 'The visor logo: the agent runs on GitHub Copilot.',
  'rt-pi': 'The pi letter: the agent runs on the Pi coding agent.',
  'rt-gemini': 'The four-point star: the agent runs on Gemini CLI.',
  'rt-opencode': 'The square brackets: the agent runs on OpenCode.',
}

interface Group { id: string; title: string; entries: readonly LegendEntryId[] }

/** Every legend entry belongs to exactly one group; a group is a step when at least one of its entries is on screen. */
const GROUPS: readonly Group[] = [
  { id: 'agents', title: 'Your agents', entries: ['shape-main', 'orchestrator', 'shape-sub', 'rt-claude', 'rt-codex', 'rt-copilot', 'rt-pi', 'rt-gemini', 'rt-opencode'] },
  { id: 'state-thinking', title: 'An agent is thinking', entries: ['state-thinking'] },
  { id: 'state-tool_calling', title: 'An agent is calling a tool', entries: ['state-tool_calling'] },
  { id: 'state-waiting_permission', title: 'An agent is waiting for you', entries: ['state-waiting_permission'] },
  { id: 'state-error', title: 'An agent is in error', entries: ['state-error'] },
  { id: 'state-paused', title: 'An agent is paused', entries: ['state-paused'] },
  { id: 'state-idle', title: 'An agent is idle', entries: ['state-idle'] },
  { id: 'state-complete', title: 'An agent is done', entries: ['state-complete'] },
  { id: 'tools', title: 'Tool calls', entries: ['shape-tool', 'edge-tool'] },
  { id: 'finished', title: 'Finished agents', entries: ['shape-complete', 'team-archived'] },
  { id: 'hierarchy', title: 'Who started whom', entries: ['edge-parent', 'edge-unverified', 'particle-dispatch', 'particle-return'] },
  { id: 'folded', title: 'Folded branches', entries: ['edge-badge-hidden', 'edge-badge-active'] },
  { id: 'conflicts', title: 'File conflicts', entries: ['edge-file-conflict'] },
  { id: 'teams', title: 'Agent teams', entries: ['team-ring', 'team-working', 'team-idle', 'team-done', 'team-halo', 'team-row'] },
  { id: 'sessions', title: 'Sessions', entries: ['session-halo'] },
  { id: 'links', title: 'Links between agents', entries: ['link-flight', 'link-recent', 'link-error', 'link-quiet', 'link-bubble'] },
  { id: 'context', title: CONTEXT_WINDOW_NAME, entries: ['ctx-system', 'ctx-user', 'ctx-tool-results', 'ctx-reasoning', 'ctx-subagent'] },
  { id: 'discoveries', title: 'Discoveries', entries: ['shape-discovery', 'disc-file', 'disc-pattern', 'disc-finding', 'disc-code'] },
]

const sectionOf = (id: LegendEntryId): LegendSectionId =>
  (Object.keys(LEGEND_ENTRIES) as LegendSectionId[]).find(section => (LEGEND_ENTRIES[section] as readonly string[]).includes(id))!

/**
 * The steps of the tour of what is on screen now, in a fixed order. Frozen when the tour starts: a step whose
 * entries leave the scene is flagged by the caller (the card says it is no longer on screen), not rewritten.
 */
export function buildLiveTourSteps(presence: LegendPresence): TourStep[] {
  const present = new Set(presence.entries)
  const steps: TourStep[] = []
  for (const group of GROUPS) {
    const covers = group.entries.filter(id => present.has(id))
    if (covers.length === 0) continue
    const example = covers.find(id => presence.agentFor[id] !== undefined)
    const key = example ? presence.agentFor[example] : undefined
    const label = key ? cleanText(presence.labels[key], 40) : ''
    const sentences = covers.map(id => LIVE_ENTRY_TEXT[id]).join(' ')
    steps.push({
      id: group.id,
      title: group.title,
      body: label ? `${sentences} Highlighted agent: "${label}".` : sentences,
      covers,
      target: key ? { kind: 'agent-key', key } : { kind: 'dom', id: `legend-${sectionOf(covers[0])}` },
      ...(key ? {} : { opensLegend: true }),
    })
  }
  return steps
}
