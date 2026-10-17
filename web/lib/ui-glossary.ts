import type { PanelId } from './panel-layout'
import { FILE_TIMELINE_MAX_STEPS } from './file-timeline'
import { GIT_STRIP_MAX_COMMITS, GIT_STRIP_MAX_PRS } from './git-state'

// Fixed UI vocabulary (issue #32). Every panel title, aria-label, tooltip and empty state takes its words
// from here, so one thing never has two names. Pure data: no React and no path-alias imports (node:test).

/** The panels of the app, under the one name each is called everywhere. */
export const PANEL_NAMES = {
  conversation: 'Conversation',
  files: 'Files',
  timeline: 'Timeline',
  cost: 'Cost',
  context: 'Context',
  stats: 'Stats',
  system: 'System',
} as const

export type PanelKey = keyof typeof PANEL_NAMES

/** Terms of the agent hierarchy: Session > Agent (Main / Lead) > Subagent / Teammate. */
export const HIERARCHY_TERMS = {
  session: 'Session',
  agent: 'Agent',
  main: 'Main',
  lead: 'Lead',
  subagent: 'Subagent',
  teammate: 'Teammate',
} as const

/** The one empty-state wording of the app: "No <things> yet". */
export function emptyState(things: string): string {
  return `No ${things} yet`
}

/** Empty state of a search / filter that matches nothing. */
export function emptyMatch(things: string): string {
  return `No matching ${things}`
}

/** Accessible name of the control that opens a panel, with its shortcut. */
export function openPanelLabel(panel: PanelKey, shortcut?: string): string {
  return shortcut ? `${PANEL_NAMES[panel]} (${shortcut})` : PANEL_NAMES[panel]
}

/** Labels of the Conversation panel (title, pill, controls). */
export const CONVERSATION_LABELS = {
  title: PANEL_NAMES.conversation,
  /** Collapsed pill: opens the panel */
  open: `Open ${PANEL_NAMES.conversation}`,
  close: `Close ${PANEL_NAMES.conversation}`,
  /** Top bar button: visible text, aria-label and tooltip */
  buttonText: PANEL_NAMES.conversation,
  buttonLabel: openPanelLabel('conversation', 'C'),
  tablist: 'Filter messages by agent',
  search: 'Search messages',
  empty: emptyState('messages'),
  emptySearch: emptyMatch('messages'),
} as const

/**
 * UI vocabulary for grouped agents. Hierarchy: Session > Workflow > Agent. "Team" stays reserved for
 * Agent Teams (Claude Code's TeamCreate), whose members are called teammates.
 * Pure: no React, no DOM; relative imports only so node:test can load it.
 */

/** What a group of agents is: an Agent Team or one run of the Workflow tool. */
export type GroupKind = 'team' | 'workflow'

/** Unknown / missing values are plain teams (the historical default). */
export function normalizeGroupKind(v: unknown): GroupKind {
  return v === 'workflow' ? 'workflow' : 'team'
}

export const GROUP_NOUN: Readonly<Record<GroupKind, string>> = { team: 'Team', workflow: 'Workflow' }

/** "Team" | "Workflow" */
export function groupNoun(kind: GroupKind | undefined): string {
  return GROUP_NOUN[normalizeGroupKind(kind)]
}

/** "team" | "workflow" */
export function groupNounLower(kind: GroupKind | undefined): string {
  return groupNoun(kind).toLowerCase()
}

/** Member noun of a group: "member(s)" for a team, "agent(s)" for a workflow. */
export function memberNoun(kind: GroupKind | undefined, count = 1): string {
  const base = normalizeGroupKind(kind) === 'workflow' ? 'agent' : 'member'
  return count === 1 ? base : `${base}s`
}

/** "Workflow tempo-wave-a" / "Team alpha" */
export function groupHeading(kind: GroupKind | undefined, title: string): string {
  return `${groupNoun(kind)} ${title}`
}

/** Qualifiers of a usage figure (tokens, cost, percentage): said the same way on every surface (issue #123). */
export const USAGE_LABELS = {
  unavailable: 'not reported',
  atLeast: 'at least',
  estimated: 'estimated',
} as const

/** A cost is the tokens now in the context priced at a blended rate, never a bill (#364): "~" on screen,
 *  the name in words for assistive technology, the method in tooltips. */
export const COST_LABELS = {
  mark: '~',
  name: 'context cost estimate',
  method: 'Context cost estimate: the tokens now in the context × a blended rate per model (75% input, 25% output price). Not a bill: it drops after a compaction, ignores cache reads and does not add up earlier calls.',
} as const

/** Shown wherever a result or outcome rests on an end that was never observed. */
export const END_NOT_OBSERVED = 'end not observed'

/** Warning attached to an expired call: the goal is not known to have been reached. */
export const EXPIRED_WARNING = 'Expired, end not observed: the result is unknown, not a success.'

/** Warning for a result that was reported although the end of the call was not observed. */
export const RESULT_WITHOUT_END_WARNING = `Result reported, ${END_NOT_OBSERVED}.`

/** Where a file card made from a Glob / Grep output comes from (#438): its index in the list, the count the
 *  tool's header reported, and how many cards the call has, so the paths not drawn are said, never hidden. `pattern`: the clipped args of the complete call of the same
 *  agent and tool_use_id, when it is known (#458); absent, nothing is invented. */
export function listedFileText(l: { tool: string; position: number; reported: number; shown: number; pattern?: string }): string {
  const base = `File listed by ${l.tool}${l.pattern ? ` "${l.pattern}"` : ''}, ${l.position} of ${l.reported} files the call reported`
  return l.reported > l.shown ? `${base}; ${l.shown} shown, ${l.reported - l.shown} not drawn` : base
}

/** File timeline in the Files panel (#385): only calls observed to succeed are steps; commits are never inferred. */
export const FILE_TIMELINE_LABELS = {
  kinds: { read: 'read', edited: 'edited', written: 'written' },
  noCallId: 'call id not reported',
  noCommits: 'Commits are not shown: no observed event ties a file to a commit.',
  /** "3 steps observed", "(incomplete)" when the relay could not replay some events */
  summary: (n: number, incomplete: boolean) => `${n} step${n === 1 ? '' : 's'} observed${incomplete ? ' (incomplete)' : ''}`,
  /** Screen-reader-only end of the summary, so each closed disclosure names its file */
  summaryOf: (path: string) => ` of ${path}`,
  omitted: (n: number) => `${n} earlier step${n === 1 ? '' : 's'} not kept (the ${FILE_TIMELINE_MAX_STEPS} most recent are listed)`,
  list: (path: string) => `Steps of ${path}`,
} as const

/** Git strip of the agent card (#386): each value read from an observed git / gh output, never a default. */
export const GIT_STRIP_LABELS = {
  title: 'Git (observed)',
  /** Under the title when the relay could not replay some events: qualifies the branch, the commits and the PRs */
  lost: 'events lost: later changes may be missing',
  /** Screen reader only, after the PR link text */
  newTab: ' (opens in a new tab)',
  branch: 'Branch',
  detached: 'detached HEAD',
  sources: { checkout: 'git checkout / switch', status: 'git status', 'show-current': 'git branch --show-current', commit: 'git commit' },
  /** "+1:02": time since the agent appeared */
  seen: (elapsed: string) => `seen +${elapsed}`,
  commits: (n: number, incomplete: boolean) => `${n} commit${n === 1 ? '' : 's'} observed${incomplete ? ' (incomplete)' : ''}`,
  commitsList: 'Commits observed',
  amended: 'amended',
  omittedCommits: (n: number) => `${n} earlier commit${n === 1 ? '' : 's'} not kept (the ${GIT_STRIP_MAX_COMMITS} most recent are listed)`,
  prsList: 'Pull requests observed',
  pr: (n: number, repo: string | null) => `PR #${n} (${repo ?? 'repository not reported'})`,
  prStates: { created: 'created', open: 'open', draft: 'open, draft', merged: 'merged', closed: 'closed' },
  omittedPrs: (n: number) => `${n} earlier PR${n === 1 ? '' : 's'} not kept (the ${GIT_STRIP_MAX_PRS} most recent are listed)`,
} as const

/** "Why this tool?" and the causal chain of a failure (issue #231): each line says what was observed, or that it cannot be proven. */
export const WHY_LABELS = {
  title: 'Why this tool?',
  reasoning: 'Reasoning observed just before this call',
  reasoningNone: 'No reasoning observed just before this call',
  redacted: 'Reasoning not disclosed by the runtime',
  incomplete: 'Older messages were dropped: earlier reasoning may be missing',
  unknown: {
    'no-tool-use-id': 'Not provable: this call has no tool_use_id',
    'call-not-in-history': 'Not provable: the call is no longer in the kept history',
    'history-truncated': 'Not provable: older messages were dropped',
  },
  chain: 'Causal chain of this failure',
  failure: 'Failure',
  noErrorText: 'Error text not reported',
  chainReasoning: 'Reasoning before the failing call',
  dispatchReasoning: 'Reasoning before the dispatch',
  prompt: 'Latest prompt observed before it',
  promptUnknown: {
    'none-observed': 'No prompt observed before it',
    'no-tool-use-id': 'Prompt not provable: the call has no tool_use_id',
    'call-not-in-history': 'Prompt not provable: the call is no longer in the kept history',
    'history-truncated': 'Prompt not provable: older messages were dropped',
  },
  stop: {
    'dispatch-not-observed': 'Chain stops: the dispatch of this sub-agent was not observed',
    'link-unverified': 'Chain stops: the link to its parent is unverified',
    'parent-unknown': 'Chain stops: the parent is no longer listed',
  },
} as const

// --- Words that had two meanings (#372) -------------------------------------------------------------

/** The model's token window and its gauge. Never "Context" alone: that word names the project panel. */
export const CONTEXT_WINDOW_NAME = 'Context window'

/** What a panel holds, said after its name where a tooltip or the shortcuts table explains it. */
export const PANEL_SUMMARIES = {
  context: 'project CLAUDE.md, memory, issues',
} as const

/** The control-bar slider. Never "Timeline": that word names the panel opened by T. */
export const PLAYBACK_LABELS = {
  position: 'Playback position',
} as const

/** The list opened by L (top bar, Shortcuts dialog, command palette). */
export const SESSIONS_LIST_NAME = 'Sessions and agents'

/** Session list controls. A session row's button only hides it: the next event or a reconnect lists it again. */
export const SESSION_LIST_LABELS = {
  activeOnly: 'Active only',
  activeOnlyHelp: 'List only the sessions heard from that are still followed and not marked finished (the selected one stays). Hides a session once its end was observed or it is no longer watched (size cap, read error, scope change), and the ones never heard from. No time limit, unlike the 10-minute window of the All view.',
  hide: 'Hide session (reappears on new activity or after a reconnect)',
  hideNamed: (label: string) => `Hide session ${label} (reappears on new activity or after a reconnect)`,
  hidden: (label: string) => `Session hidden: ${label}`,
  hiddenUnnamed: 'Session hidden',
} as const

/** Top bar under 768 px (#378, #476): the panel buttons, the totals and the view filters fold behind this disclosure button. */
export const TOP_BAR_LABELS = {
  more: 'More',
  moreName: 'More: panels, totals and filters',
  moreHelp: 'Panel buttons, agent counts, tokens in context, cost and the view filters (folded under 768 px wide)',
  /** Folded with filters on: the visible text says the canvas is filtered (short: it shares a row at 320 px) */
  moreWithFilters: (count: number) => `More · ${count} ${count === 1 ? 'filter' : 'filters'}`,
  /** Its accessible name starts with that visible text (2.5.3), then names the filters */
  moreNameWithFilters: (names: readonly string[]) =>
    `More · ${names.length} ${names.length === 1 ? 'filter' : 'filters'} on: panels, totals and filters (${names.join(', ')})`,
  /** The same name in two parts around the list of filters, so each filter can carry its own language (#373) */
  moreNameWithFiltersParts: (count: number) => ({
    before: `More · ${count} ${count === 1 ? 'filter' : 'filters'} on: panels, totals and filters (`,
    after: ')',
  }),
  /** Filter names used in those strings */
  filterHideInactive: 'Hide inactive agents',
  filterFinishedHidden: (count: number) => `Finished sessions hidden (${count})`,
} as const

/** Suffix of a timeline label whose call expired. */
export const EXPIRED_LABEL_SUFFIX = `(expired, ${END_NOT_OBSERVED})`

/** Docked panels (panel-layout ids) under the name the user knows them by. */
const DOCK_PANEL_NAMES: Record<PanelId, string> = {
  detail: 'Agent card',
  system: PANEL_NAMES.system,
  link: 'Link',
  files: PANEL_NAMES.files,
  conversation: PANEL_NAMES.conversation,
  timeline: PANEL_NAMES.timeline,
}

/**
 * Sentence for the open panels a one-at-a-time sheet hides (#410); '' when none is hidden. `ids` is in open order,
 * oldest first: the sheet shows the newest, so closing it brings back the last hidden one. Context shares the
 * 'files' slot of the dock, so `context` names that slot Context instead of Files.
 */
export function hiddenPanelsText(ids: readonly PanelId[], opts: { context?: boolean } = {}): string {
  if (ids.length === 0) return ''
  const names = ids.map(id => (id === 'files' && opts.context ? PANEL_NAMES.context : DOCK_PANEL_NAMES[id]))
  const one = ids.length === 1
  return `${ids.length} ${one ? 'panel' : 'panels'} hidden: ${names.join(', ')}. Close the panel shown to see ${one ? 'it' : names[names.length - 1]}.`
}
