# Agent Lens

> **This is a fork of [Agent Flow](https://github.com/patoles/agent-flow)** by Simon Patole, published under the Apache License 2.0 and renamed **Agent Lens** as required by the upstream [trademark policy](TRADEMARK.md). It is not the official Agent Flow project and is not endorsed by its maintainers.
> The `agent-lens-app` npm package and the VS Code extension are **not published**: run the project from source (see below).

Real-time visualization of Claude Code and Codex agent orchestration. Watch your agents think, branch, and coordinate as they work. 

## Why Agent Lens?

The original project was created by Simon Patole while developing [CraftMyGame](https://craftmygame.com), because debugging agent behavior was painful. This fork keeps that goal and focuses on accessibility, a unified multi-agent view and readable agent-to-agent communication.

Claude Code is powerful, but its execution is a black box — you see the final result, not the journey. Agent Lens makes the invisible visible:

- **Understand agent behavior** — See how Claude breaks down problems, which tools it reaches for, and how subagents coordinate
- **Debug tool call chains** — When something goes wrong, trace the exact sequence of decisions and tool calls that led there
- **See where time is spent** — Identify slow tool calls, unnecessary branching, or redundant work at a glance
- **Learn by watching** — Build intuition for how to write better prompts by observing how Claude interprets and executes them

## Features

- **Live agent visualization**: Watch agent execution as an interactive node graph with real-time tool calls, branching, and return flows
- **Claude Code + Codex**: Auto-detects sessions from both runtimes concurrently and shows them side-by-side, or restrict to one via the `agentVisualizer.runtime` setting
- **Claude Code hooks**: Lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming
- **Codex rollout tailing**: Reads `~/.codex/sessions/**/rollout-*.jsonl` (respects `CODEX_HOME`) and surfaces tool calls, reasoning, and authoritative token counts from Codex's own event stream
- **Multi-session support**: Track multiple concurrent agent sessions with tabs
- **Interactive canvas**: Pan, zoom, click agents and tool calls to inspect details
- **Timeline & transcript panels**: Review the full execution timeline, file attention heatmap, and message transcript
- **JSONL log file support**: Point at any JSONL event log to replay or watch agent activity

## Getting Started

### Run from source (no VS Code required)

```bash
git clone https://github.com/jobailla/agent-flow.git agent-lens
cd agent-lens
pnpm i
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start the web app + event relay
```

Open http://localhost:3000 and start a Claude Code session in another terminal — events will stream to the browser in real-time.

### VS Code Extension

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Lens: Open Agent Lens**
3. Start a Claude Code or Codex session in your workspace — Agent Lens will auto-detect it

Agent Lens automatically configures Claude Code hooks the first time you open the panel. To manually reconfigure, run **Agent Lens: Configure Claude Code Hooks** from the Command Palette.

### Runtime selection

By default Agent Lens watches both Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) concurrently in all three entry points (VS Code extension, `pnpm run dev`, `npx agent-lens-app`). Sessions are shown side-by-side and tagged by runtime. If you only use one, the other is a harmless no-op — no visible effect, no user action needed.

To restrict to one runtime:

- **VS Code extension:** set `agentVisualizer.runtime` to `"auto"` / `"claude"` / `"codex"` in your settings
- **`pnpm run dev` and `npx agent-lens-app`:** set the `AGENT_FLOW_RUNTIME` environment variable to `claude` or `codex` (defaults to watching both)

For non-default Codex installs, set the `CODEX_HOME` environment variable.

### JSONL Event Log

You can also point Agent Lens at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file
2. Agent Lens will tail the file and visualize events as they arrive

## Commands

| Command | Description |
|---------|-------------|
| `Agent Lens: Open Agent Lens` | Open the visualizer panel |
| `Agent Lens: Open Agent Lens to Side` | Open in a side editor column |
| `Agent Lens: Connect to Running Agent` | Manually connect to an agent session |
| `Agent Lens: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming |

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Cmd+Alt+A` (Mac) / `Ctrl+Alt+A` (Win/Linux) | Open Agent Lens |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.runtime` | `"auto"` | Which agent runtime(s) to watch: `"auto"` (both), `"claude"`, or `"codex"` |
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode) |
| `agentVisualizer.eventLogPath` | `""` | Path to a JSONL event log file to watch |
| `agentVisualizer.autoOpen` | `false` | Auto-open when an agent session starts |

## Requirements

- [Node.js](https://nodejs.org/) 20+ (LTS recommended)
- [pnpm](https://pnpm.io/)
- Claude Code CLI
- For the VS Code extension: a VSCode-compatible IDE 1.85+ (e.g. [VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.sh/), [Windsurf](https://windsurf.com/))

## Development

```bash
pnpm i              # install dependencies for all packages
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start dev server + event relay
```

`pnpm run dev` starts both the Next.js dev server and an event relay that receives Claude Code events and streams them to the browser via SSE.

Other scripts:

| Script | Description |
|--------|-------------|
| `pnpm run dev:demo` | Start with demo/mock data |
| `pnpm run dev:relay` | Run the event relay server standalone |
| `pnpm run dev:extension` | Watch-build the extension |
| `pnpm run build:all` | Production build (webview + extension) |
| `pnpm run build:web` | Build the Next.js web app |
| `pnpm run build:extension` | Build the extension |
| `pnpm run build:webview` | Build the webview assets |

## Accessibility testing

Accessibility checks run in CI without any browser download:

- `pnpm --dir web run lint:a11y` runs `eslint-plugin-jsx-a11y` (strict preset) on `web/`. Known violations are allow-listed per file in `web/eslint.config.mjs`, each with the issue that will fix it.
- `pnpm run test:a11y` renders the key components (top bar, control bar, session tabs, transcript, feed, file attention, chat, popups, context menu, shortcuts dialog, timeline canvas and table view) in jsdom and runs axe-core on them, plus keyboard scenarios (shortcut filter, tab/menu/scrubber key models). Known axe violations live in `web/tests-a11y/known-violations.json` with an issue number. The test fails on a new violation and also when an allow-listed one disappears, so the list can only shrink.
- jsdom has no layout engine, so axe cannot compute color contrast here. Contrast is covered at the token level by `scripts/contrast.test.ts` (part of `pnpm test`).

Follow-up (not done yet): a Playwright + `@axe-core/playwright` smoke run against `pnpm run dev:demo` for layout-dependent checks (320 px reflow, 200 % zoom, `prefers-reduced-motion`, full-page Tab order). It needs a downloaded browser, so it is not part of CI today.

## Author

Agent Lens is a fork of [Agent Flow](https://github.com/patoles/agent-flow), created by [Simon Patole](https://github.com/patoles) for [CraftMyGame](https://craftmygame.com). The original author is credited under the Apache License 2.0; all upstream copyright notices are kept.

## Privacy & Telemetry

This fork sends **no telemetry**. The upstream project's collection endpoint was removed from the code on purpose, so nothing leaves your machine and nothing is written to disk for analytics. If you want telemetry for your own deployment, set your own endpoint and publishable key in `scripts/telemetry.ts` and rebuild. Telemetry also stays off when `DO_NOT_TRACK=1` or `AGENT_FLOW_TELEMETRY=false` is set.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

"Agent Flow" and its logos are trademarks of Simon Patole. This fork is an independent project under a different name, uses none of the Agent Flow logos, and is not affiliated with or endorsed by the Agent Flow maintainers. See [TRADEMARK.md](TRADEMARK.md).
