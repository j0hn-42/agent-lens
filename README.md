# Agent Lens

> Agent Lens is based on [Agent Flow](https://github.com/patoles/agent-flow) by Simon Patole (Apache License 2.0). See [Origin and credits](#origin-and-credits).

Real-time visualization of Claude Code and Codex agent orchestration. Watch your agents think, branch, and coordinate as they work. 

## Why Agent Lens?

Agent Lens started from Agent Flow, a visualizer created by Simon Patole because debugging agent behavior was painful. We took the project over and push it further: accessibility, a single view of all agents across sessions, and readable agent-to-agent communication.

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
- **Multi-session support**: Track multiple concurrent agent sessions from a Sessions panel (sessions, agents and sub-agents as a tree)
- **Interactive canvas**: Pan, zoom, click agents and tool calls to inspect details
- **Timeline, Files & Conversation panels**: Review the full execution timeline, file attention heatmap, and the conversation (one panel for messages, tool calls and per-agent views)
- **Fleet / All view**: see every watched session on one canvas, with the sessions of a same project grouped together
- **Workflows and Teams**: agents of a Claude Code Agent Team or of a Workflow tool run are grouped in a labelled halo
- **Comms**: message links between agents, with the latest message on the link and a panel to read the exchange
- **Context panel**: the `CLAUDE.md` files and memory index a session works with, loaded on demand
- **Honest values**: nothing is shown that cannot be proven. Unknown states read "Not observed", partial totals read "at least X", local token counts are marked "estimated", costs that cannot be tied to one agent are "unattributed". See [Reading the UI](docs/reading-the-ui.md)
- **Typed `observations` action**: Claude can read what Agent Lens observes through a whitelisted, size-bounded endpoint (see [docs/state-share.md](docs/state-share.md))
- **JSONL log file support**: Point at any JSONL event log to replay or watch agent activity

## Getting Started

### Run from source (no VS Code required)

```bash
git clone https://github.com/jobailla/agent-lens.git
cd agent-lens
pnpm i
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start the web app + event relay
```

Open http://localhost:3000 and start a Claude Code session in another terminal — events will stream to the browser in real-time.

### VS Code Extension

Build the `.vsix` from source and install it:

```bash
pnpm i
npm install -g @vscode/vsce                   # once: the `package` script calls the `vsce` command
pnpm --filter agent-lens run package          # builds the webview and the extension, writes extension/agent-lens-<version>.vsix
code --install-extension extension/agent-lens-<version>.vsix
```

Use `cursor` or `windsurf` instead of `code` for those editors (or **Extensions: Install from VSIX...** in the Command Palette). It works with any VS Code-compatible IDE 1.85 or newer, including [Cursor](https://cursor.sh/) and [Windsurf](https://windsurf.com/).

Then:

1. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Lens: Open Agent Lens**
2. Start a Claude Code or Codex session in your workspace. Agent Lens will auto-detect it

Agent Lens automatically configures Claude Code hooks the first time you open the panel. To manually reconfigure, run **Agent Lens: Configure Claude Code Hooks** from the Command Palette.

### Runtime selection

By default Agent Lens watches both Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) concurrently in all three entry points (VS Code extension, `pnpm run dev`, `npx agent-lens-app`). Sessions are shown side-by-side and tagged by runtime. If you only use one, the other is a harmless no-op — no visible effect, no user action needed.

To restrict to one runtime:

- **VS Code extension:** set `agentVisualizer.runtime` to `"auto"` / `"claude"` / `"codex"` in your settings
- **`pnpm run dev` and `npx agent-lens-app`:** set the `AGENT_LENS_RUNTIME` environment variable to `claude` or `codex` (defaults to watching both)

For non-default Codex installs, set the `CODEX_HOME` environment variable.

### Event sources and the local server

Hooks and JSONL transcripts are reconciled (no duplicate events), and the local server is loopback-only and hardened (`AGENT_LENS_PORT=0` or `--port 0` picks an ephemeral port). See [docs/relay-sources.md](docs/relay-sources.md).

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
| `pnpm run dev:demo` | Start with the demo tour: every feature on mock data (script: [docs/demo.md](docs/demo.md)) |
| `pnpm run dev:demo:classic` | Start with the previous, single-session demo data |
| `pnpm run dev:relay` | Run the event relay server standalone |
| `pnpm run dev:extension` | Watch-build the extension |
| `pnpm run build:all` | Production build (webview + extension) |
| `pnpm run build:web` | Build the Next.js web app |
| `pnpm run build:extension` | Build the extension |
| `pnpm run build:webview` | Build the webview assets |
| `pnpm --filter agent-lens run package` | Build the extension and package it as a `.vsix` (runs `vsce package`; needs `@vscode/vsce` installed globally) |

Contributing (branches, labels, the checks to run before a PR): see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Reading the UI](docs/reading-the-ui.md): views, and what "Not observed", "at least", "estimated" and "unattributed" mean
- [Node inspector](docs/node-inspector.md): model, cost attribution, issue and PR links
- [Event sources](docs/relay-sources.md): hooks and JSONL reconciliation, the local server
- [Sharing state](docs/state-share.md): snapshots and the `observations` action
- [Demo tour](docs/demo.md): the presenter script that shows every feature on mock data

## Releasing

1. Bump `version` in `extension/package.json` and `app/package.json` (they must match) and add a `## <version>` entry at the top of `extension/CHANGELOG.md`. Every user-visible change (feature, fix, behaviour change) gets a line there, with its issue number, in the same PR that introduces it or at the latest when bumping.
2. `node scripts/release-check.js` verifies the two versions and the CHANGELOG entry (it also runs in CI).
3. Push a tag `vX.Y.Z` matching the version. The `Release` workflow builds the webview and extension, packages `agent-lens.vsix` as a workflow artifact and attaches it to a GitHub Release. It can also be run by hand (`workflow_dispatch`, never on `develop`) to get the `.vsix` artifact only. Nothing is published to the Marketplace or Open VSX and no secret is used.

## Accessibility testing

Three layers run in CI (see `.github/workflows/ci.yml`):

- **Lint** — `pnpm --dir web run lint:a11y` runs `eslint-plugin-jsx-a11y` (strict preset, no per-file overrides, inline disables ignored) and compares the result with `web/tests-a11y/lint-baseline.json`, one entry per file and rule with a violation count and the issue that fixes it. It fails on any new violation and on any listed violation that was fixed. After fixing code, run `pnpm --dir web run lint:a11y -- --write` and review the diff; the baseline should only shrink.
- **jsdom + axe-core** — `pnpm run test:a11y` renders the key components (top bar, control bar in live and review mode, sessions panel, Conversation, file attention, popups, context menu, shortcuts dialog, timeline canvas and table view) and runs axe-core on them. Keyboard wiring tests render the real components and dispatch real key events (scrubber arrows, Space on a button, Escape, context-menu arrows). Known axe violations live in `web/tests-a11y/known-violations.json` with an issue number; the test fails on a new violation and when a listed one disappears, with a message saying which entry to remove.
- **Browser (Playwright + `@axe-core/playwright`)** — `pnpm --dir web run test:e2e` starts the demo app itself on a free port (and stops it at the end; set `E2E_BASE_URL` to use a server that is already running instead) for what jsdom cannot see: serious/critical axe violations including color contrast on the initial page, each panel, review mode, the shortcuts dialog, the context menu (right click) and the tool detail popup (opened from the graph outline button that mirrors a canvas click); the context menu keys (Shift+F10, ContextMenu, ArrowDown/Up, Home, End, Escape, Tab) with focus return, and Escape on the tool popup; no clipped containers, horizontal scroll or off-screen controls at 320 px and 640 px (400 % and 200 % zoom; only the elements tracked in issue #23 are tolerated, any other clipped control fails), measured only after the layout is stable (bounding boxes unchanged over two animation frames and a quiet period) and with the Files and Conversation panels open; the canvas redraws markedly less (pixel diff between two frames, against a no-preference baseline) and no infinite CSS animation runs under `prefers-reduced-motion: reduce`; no invisible control in the Tab order; Space, Escape and scrubber keys on the real page. Install the browser once with `pnpm --dir web exec playwright install chromium`. The server log is written to `web/test-results/demo-server.log`. Browser-level findings use the `e2e:*` scenarios of `known-violations.json`.

Color contrast of the design tokens is also checked without a browser by `scripts/contrast.test.ts` (part of `pnpm test`).

## Origin and credits

Agent Lens is based on [Agent Flow](https://github.com/patoles/agent-flow), created by [Simon Patole](https://github.com/patoles) for [CraftMyGame](https://craftmygame.com). Agent Flow's code, architecture and original visual design are the foundation of this project, and we are grateful to its author.

This repository is an independent continuation with its own name, icon set, roadmap and maintainers. It is not affiliated with or endorsed by the Agent Flow project. Changes made since the fork are listed in [NOTICE](NOTICE) and in the git history; the history before the fork is Agent Flow's.

## Privacy & Telemetry

Agent Lens sends **no telemetry**: the collection endpoint inherited from Agent Flow was removed, so nothing leaves your machine and nothing is written to disk for analytics. If you want telemetry for your own deployment, set your own endpoint and publishable key in `scripts/telemetry.ts` and rebuild. Telemetry also stays off when `DO_NOT_TRACK=1` or `AGENT_LENS_TELEMETRY=false` is set.

## License

Apache License 2.0, see [LICENSE](LICENSE). The original copyright notices are kept and the modifications are stated in [NOTICE](NOTICE), as the license requires.
