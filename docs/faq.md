# FAQ and troubleshooting

Each answer comes from what the code and the other pages of this documentation state; where something was not verified, it says so.

- [Nothing shows up in the graph](#nothing-shows-up-in-the-graph)
- [Which port does it use?](#which-port-does-it-use)
- [Agents or sessions disappear from the canvas](#agents-or-sessions-disappear-from-the-canvas)
- [A session says "Not observed"](#a-session-says-not-observed)
- [The graph says it is incomplete](#the-graph-says-it-is-incomplete)
- [The quota gauges are missing](#the-quota-gauges-are-missing)
- [One runtime shows nothing](#one-runtime-shows-nothing)
- [Does Agent Lens send my data anywhere?](#does-agent-lens-send-my-data-anywhere)

## Nothing shows up in the graph

Check these in order:

1. **The relay is running.** `pnpm run dev` (web app and relay) or `node app/dist/app.js` (standalone app). The VS Code extension runs its own.
2. **The Claude Code hooks are configured.** Run `pnpm run setup` once; it writes the hooks in `settings.json` of your Claude config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`). The extension configures them the first time you open the panel, and **Agent Lens: Configure Claude Code Hooks** redoes it. A `settings.json` that cannot be parsed is never modified.
3. **The scope.** By default the relay discovers only the Claude Code sessions of the workspace it was started in. In `pnpm run dev` and the standalone app, the **Session scope** selector in the top bar widens it to a project or to all workspaces, with no restart; the line next to it says what is really scanned. See [Scope](install.md#scope-this-workspace-a-project-or-all-workspaces).
4. **The runtime.** If `AGENT_LENS_RUNTIME` (or `agentVisualizer.runtime`) is set to one runtime, the others are not watched. See [Runtime selection](install.md#runtime-selection).

Try `pnpm run dev:demo` to check that the app itself works: it plays a tour on mock data and needs no session.

## Which port does it use?

`pnpm run dev` serves the web app on http://localhost:3000. The standalone app uses 3001 by default; `--port <n>` changes it and `--port 0` (or `AGENT_LENS_PORT=0`) asks the system for a free one, printed at startup. The local server listens on `127.0.0.1` only. If Next.js falls back to another port in development, set `AGENT_LENS_WEB_PORT` so the relay accepts it ([details](relay-sources.md)).

## Agents or sessions disappear from the canvas

**Hide inactive** is on by default. It hides agents whose turn is over, and, in the All view, sessions marked finished more than 10 minutes ago. When it hides everything, the canvas says "N finished agents hidden" with a **Show** button. Turn **Hide inactive** off to see everything again: the toggle is in the top bar's More menu and in the settings dialog. How it works is in [Reading the UI](reading-the-ui/filters.md).

## A session says "Not observed"

The session or agent is known (for example listed on disk) but no event was ever received for it, so no state or activity is invented. Sessions of a cloud agent leave nothing on your machine: import their JSONL transcript with `--import`, and they are listed as *imported - not live*. See [Honest values](reading-the-ui/honest-values.md) and [Event sources](install.md#event-sources-and-the-local-server).

## The graph says it is incomplete

"Graph incomplete: at least N earlier events were not replayed" means the relay keeps a bounded number of events per session and could not replay all of them to the page that connected. The number is a lower bound. See [Reading the UI](reading-the-ui/relay-and-losses.md#graph-truncated).

## The quota gauges are missing

They need Claude Code's status line. Run `node scripts/setup.js --statusline` (opt-in; `--restore-statusline` undoes it). Nothing is shown before a quota has been received, and none is shown for a Copilot or OpenCode session. See [Subscription quota gauges](reading-the-ui/cost-and-usage.md#subscription-quota-gauges).

## One runtime shows nothing

- **OpenCode**: read from its SQLite database, on Linux only (macOS is not verified, Windows is not supported yet: set `OPENCODE_DB` to an absolute path). Only sessions with rows in the last 10 minutes are followed.
- **Pi and Gemini CLI**: sessions show up, but tokens and cost are not read yet, and neither runtime shows sub-agents.
- **Copilot**: only the local sessions; cloud-hosted Copilot agent sessions are not covered.
- **Cursor**: not a supported runtime. Its hook payloads are recognised and ignored. See the [roadmap](roadmap.md).
- **Non-default install folders**: set `CODEX_HOME`, `COPILOT_HOME`, `PI_CODING_AGENT_DIR` or `GEMINI_CLI_HOME`. See [Runtime selection](install.md#runtime-selection).

The Context panel and the `observations` action exist only in the standalone relay (`pnpm run dev` or the app), not in the VS Code extension.

## Does Agent Lens send my data anywhere?

No. It sends no telemetry: the collection endpoint inherited from Agent Flow was removed. The local server listens on loopback only unless you set up [remote access](remote-access.md) yourself.
