# Features

The [README](../README.md) shows what Agent Lens does in a few lines. This page is the detail of each feature, with its limits. How to read what the interface shows is in [Reading the UI](reading-the-ui.md); the principle behind all of it is that nothing is displayed that cannot be proven.

- [On the canvas](#on-the-canvas)
- [Runtimes](#runtimes)
- [Cost and quota](#cost-and-quota)
- [Honest values](#honest-values)
- [Themes](#themes)
- [Context and system panels](#context-and-system-panels)
- [Sharing, export and integrations](#sharing-export-and-integrations)

## On the canvas

- **Live agent visualization**: watch agent execution as an interactive node graph with real-time tool calls, branching, and return flows.
- **Interactive canvas**: pan, zoom, click agents and tool calls to inspect details.
- **Multi-session support**: track multiple concurrent agent sessions from a Sessions panel (sessions, agents and sub-agents as a tree), sorted by recent activity, renamable (F2) and prefixed by folder when several folders are open.
- **Fleet / All view**: see every watched session on one canvas, with the sessions of a same project grouped together.
- **Timeline, Files & Conversation panels**: review the full execution timeline, the file attention heatmap (with the file conflicts: files that several agents edited, see [Reading the UI](reading-the-ui/views.md)), and the conversation (one panel for messages, tool calls and per-agent views).
- **Repeated reads and calls**: the Files & repeats panel lists, in a section folded behind a counted summary, files an agent read again with no edit seen in between, and identical calls repeated, with the tokens the repeats cost when they were reported (see [Reading the UI](reading-the-ui/repeated-reads.md)).
- **Delegation report**: the inspector of an agent lists each of its sub-agents with its tokens, the files it was seen to read, the duration the runtime reported and the start of its returned report; unknown values say so (see [Reading the UI](reading-the-ui/delegation-report.md#delegation-report)).
- **Workflows and Teams**: agents of a Claude Code Agent Team or of a Workflow tool run are grouped in a labelled halo.
- **Comms**: message links between agents, with the latest message on the link and a panel to read the exchange.
- **Command palette**: `Ctrl+K` (`Cmd+K` on a Mac) opens actions, panels, sessions (direct jump) and agents, all from the keyboard. `?` lists every shortcut. See [Reading the UI](reading-the-ui/command-palette.md).

## Runtimes

Agent Lens watches Claude Code, Codex, GitHub Copilot, Pi, Gemini CLI and OpenCode concurrently and tags each session with its runtime. How to restrict it to one runtime is in [Install and configure](install.md#runtime-selection). Where each runtime stands (delivered, partial, blocked) is in the [roadmap](roadmap.md).

- **Claude Code hooks**: a lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming.
- **Codex rollout tailing**: reads `~/.codex/sessions/**/rollout-*.jsonl` (respects `CODEX_HOME`) and surfaces tool calls, reasoning, and authoritative token counts from Codex's own event stream.
- **Copilot session tailing**: reads local `~/.copilot/session-state/<id>/events.jsonl` (respects `COPILOT_HOME`), matched to the workspace through `workspace.yaml`, and surfaces messages, tool calls and sub-agent activity. Cloud-hosted Copilot agent sessions are not covered.
- **Pi session tailing**: reads `~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl` (respects `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`), matched to the workspace through the `cwd` of the session header, and surfaces prompts, replies, thinking, tool calls and compactions. Pi has no sub-agents; tokens and cost are not read yet (see [Reading the UI](reading-the-ui/runtimes.md#pi-sessions)).
- **Gemini CLI session tailing**: reads `~/.gemini/tmp/<project>/chats/session-<timestamp>-<id>.jsonl` (respects `GEMINI_CLI_HOME`), matched to the workspace through the `projectHash` of the first record (the sha256 of the project root), and surfaces prompts, replies, thoughts and tool calls. Sub-agent chat files are not read, so no sub-agent is drawn; tokens and cost are not read yet (see [Reading the UI](reading-the-ui/runtimes.md#gemini-cli-sessions)).
- **OpenCode session reading**: reads OpenCode's SQLite database (`<data>/opencode.db` for the latest, beta and prod channels, `opencode-<channel>.db` for any other channel), `<data>` being `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`; `OPENCODE_DB` overrides it: an absolute path is used as is, a relative one is resolved under `<data>`. It is read-only and needs no hook, and it surfaces prompts, replies, reasoning and tool calls. Only sessions with rows in the last 10 minutes are followed (25 at most, the most recent first), and history older than that is not replayed. Linux only for now, macOS is not verified (see [Reading the UI](reading-the-ui/runtimes.md#opencode-sessions)).
- **JSONL log file support**: point at any JSONL event log to replay or watch agent activity (see [Install and configure](install.md#jsonl-event-log)).
- **Imported transcripts**: sessions of a cloud agent leave nothing on the machine; import their JSONL transcript once, it is listed as *imported - not live* and never shown as running (see [Imported transcripts](relay-sources.md#imported-transcripts-294)).

## Cost and quota

- **Cost per agent**: tokens and cost are read from what the runtime reports; a cost that cannot be tied to one agent is "unattributed" (see [Reading the UI](reading-the-ui/cost-and-usage.md)).
- **Subscription quota gauges**: two small gauges in the top bar show how much of the Claude Code 5-hour and weekly quota is left, as Claude Code reports it, with the reset time on hover or focus and `quota: unknown for now` when it cannot be proven. The data comes from Claude Code's status line, which Agent Lens wraps only if you run `node scripts/setup.js --statusline` (opt-in, undone with `--restore-statusline`). Nothing is shown before any quota has been received, nor for a Copilot or OpenCode session (see [Reading the UI](reading-the-ui/cost-and-usage.md#subscription-quota-gauges)).

## Honest values

Nothing is shown that cannot be proven. Unknown states read "Not observed", partial totals read "at least X", local token counts are marked "estimated", costs that cannot be tied to one agent are "unattributed". See [Reading the UI](reading-the-ui/honest-values.md).

## Themes

Nine dark themes: Catppuccin Macchiato (default) with Mocha and Frappé, Midnight (calm indigo), Graphite (neutral), Neon (the original cyan look), Ember (warm, low blue light), Anthropic (warm neutrals and orange, inspired by the public Anthropic colours, not an official theme) and High contrast (pure black, white text, yellow accent, for low vision). They are chosen with the **Theme** selector in **Settings** (the gear button in the top bar). The theme applies to the interface and to the agent state colours on the canvas; the rest of the canvas and the page background keep the neon colours. See [Reading the UI](reading-the-ui/themes.md#themes).

WCAG 2.1 AA is enforced by CI; how it is tested is in [CONTRIBUTING](../CONTRIBUTING.md#accessibility-testing).

## Context and system panels

- **Context panel**: the `CLAUDE.md` files and memory index a session works with, loaded on demand, and the session's capabilities (instruction files, skills grouped by plugin, MCP servers) as its transcript recorded them. Standalone relay only (`pnpm run dev` / app), not in the VS Code extension, where the Context button says so; the issue and PR links of the panel are relay-only too.
- **System panel**: CPU, memory, swap, disk and load of the machine that runs the relay, with a 2-minute history and no invented value (see [system-stats.md](system-stats.md)).

## Sharing, export and integrations

- **Session export and HTML replay**: save a session as one offline HTML file with a keyboard scrubber, secrets redacted before writing (best effort). See [session-export.md](session-export.md).
- **Headless use**: `ps`, `tail` and `statusline` commands, a one-line `/statusline` endpoint for tmux or zellij, and webhooks on live agent events (explicit destinations, fixed body, bounded). See [headless.md](headless.md).
- **MCP server `agent-lens`**: register it in `.mcp.json` and Claude reads, as read-only MCP tools, the observed sessions and agent states and the PR / issue links of a session's project; a failure is an error, never an empty list (see [mcp-server.md](mcp-server.md)).
- **Typed `observations` action**: Claude can read what Agent Lens observes through a whitelisted, size-bounded endpoint (see [state-share.md](state-share.md)). Standalone relay only (`pnpm run dev` / app), not in the VS Code extension.
- **Operator control (VS Code, off by default)**: an optional `PermissionRequest` hook and a decision channel let the panel answer Claude Code permission requests. It fails closed (no answer means Claude Code asks as usual), takes one decision per request, and journals in a 0600 file without the tool input. See [operator-control.md](operator-control.md).
- **Remote access**: a named tunnel with `--allow-host` and `--token-file`, pairing a device, a read-only remote surface. See [remote-access.md](remote-access.md).
- **Launching an agent**: the opt-in `--allow-launch` route. See [launch-security.md](launch-security.md).
