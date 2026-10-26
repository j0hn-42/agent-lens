# Install and configure

The [README](../README.md) has the three-command start. This page covers every way to run Agent Lens, how to choose which runtimes it watches, and which sessions it scans. If something does not show up, start with the [FAQ](faq.md).

- [Run with npx](#run-with-npx-no-clone)
- [Run from source](#run-from-source-no-vs-code-required)
- [Standalone app](#standalone-app-built-from-source)
- [VS Code extension](#vs-code-extension)
- [Runtime selection](#runtime-selection)
- [Scope: this workspace, a project, or all workspaces](#scope-this-workspace-a-project-or-all-workspaces)
- [Event sources and the local server](#event-sources-and-the-local-server)
- [JSONL event log](#jsonl-event-log)

Requirements: [Node.js](https://nodejs.org/) 20+ (LTS recommended; OpenCode sessions need 22.13 or later, because the database is read with `node:sqlite`), the CLI of at least one watched runtime, and [pnpm](https://pnpm.io/) only to run from source. For the VS Code extension: a VS Code-compatible IDE 1.85+.

## Run with npx (no clone)

```bash
npx @j0hn/agent-lens
```

This runs the standalone app from the npm package `@j0hn/agent-lens`: it sets up the Claude Code hooks, serves the UI and the relay on port 3001, and opens the browser. The options are those of the [standalone app](#standalone-app-built-from-source): `--port <n>`, `--no-open`, `--all-workspaces`, and `--help` for the full list. `npx @j0hn/agent-lens@<version>` pins a version. The name is scoped because npm refused the plain `agent-lens`, which it judged too close to an existing package; the command it installs is still `agent-lens`.

## Run from source (no VS Code required)

```bash
git clone https://github.com/j0hn-42/agent-lens.git
cd agent-lens
pnpm i
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start the web app + event relay
```

Open http://localhost:3000 and start a Claude Code session in another terminal: events stream to the browser in real time.

## Standalone app (built from source)

This is the same app as `npx @j0hn/agent-lens`, built from the checkout; use it when you work on Agent Lens. Build it and run it with Node:

```bash
pnpm i
pnpm run build:app            # writes app/dist/app.js and app/dist/webview/
node app/dist/app.js          # serves the UI and the relay, then opens the browser
```

Options: `--port <n>` (default 3001, `0` = ephemeral port), `--no-open` (do not open the browser), `--all-workspaces` (discover the Claude sessions of every workspace from the start). Run `node app/dist/app.js --help` for the full list.

## VS Code extension

Build the `.vsix` from source and install it:

```bash
pnpm i
npm install -g @vscode/vsce                   # once: the `package` script calls the `vsce` command
pnpm --filter agent-lens run package          # builds the webview and the extension, writes extension/agent-lens-<version>.vsix
code --install-extension extension/agent-lens-<version>.vsix
```

Use `cursor` or `windsurf` instead of `code` for those editors (or **Extensions: Install from VSIX...** in the Command Palette). It works with any VS Code-compatible IDE 1.85 or newer, including [Cursor](https://cursor.sh/) and [Windsurf](https://windsurf.com/).

Then:

1. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Lens: Open Agent Lens**.
2. Start a Claude Code, Codex, Copilot, Pi, Gemini CLI or OpenCode session in your workspace. Agent Lens will auto-detect it.

Agent Lens automatically configures Claude Code hooks the first time you open the panel. To manually reconfigure, run **Agent Lens: Configure Claude Code Hooks** from the Command Palette. The commands, the shortcut and the settings are listed in the [reference](reference.md).

## Runtime selection

By default Agent Lens watches Claude Code (`~/.claude/projects/`), Codex (`~/.codex/sessions/`), local GitHub Copilot (`~/.copilot/session-state/`), Pi (`~/.pi/agent/sessions/`), Gemini CLI (`~/.gemini/tmp/`) and OpenCode (`~/.local/share/opencode/opencode.db`) concurrently in all three entry points (VS Code extension, `pnpm run dev`, `node app/dist/app.js`). Sessions are shown side-by-side and tagged by runtime. If you only use one, the others are a harmless no-op: no visible effect, no user action needed.

To restrict to one runtime:

- **VS Code extension:** set `agentVisualizer.runtime` to `"auto"` / `"claude"` / `"codex"` / `"copilot"` / `"pi"` / `"gemini"` / `"opencode"` in your settings.
- **`pnpm run dev` and `node app/dist/app.js`:** set the `AGENT_LENS_RUNTIME` environment variable to `claude`, `codex`, `copilot`, `pi`, `gemini` or `opencode` (defaults to watching all).

For non-default installs, set `CODEX_HOME` for Codex; `COPILOT_HOME` for Copilot; `PI_CODING_AGENT_DIR` (sessions under `<dir>/sessions`) or `PI_CODING_AGENT_SESSION_DIR` (session files directly in it) for Pi, the variables Pi itself reads; `GEMINI_CLI_HOME` (sessions under `<dir>/.gemini/tmp`) for Gemini CLI, the variable Gemini CLI itself reads.

## Scope: this workspace, a project, or all workspaces

By default the relay only discovers the Claude Code sessions of the workspace it was started in. In `pnpm run dev` and the standalone app (`node app/dist/app.js`) the top bar has a **Session scope** selector (a native select, keyboard operable): **This workspace**, **All workspaces**, or **Project: <name>** (one of the projects in the list). The choice is applied to the running relay, with no restart, and remembered in the browser; the line next to the selector always says what is really scanned ("Scanning this workspace only (name)"; nothing is written on all workspaces), taken from the relay's own `GET /status`, and an empty list on a single workspace says so and how to widen it.

- `--all-workspaces` (or `AGENT_LENS_ALL_WORKSPACES=1`) now only gives the **initial** scope; the selector changes it afterwards.
- The discovery ceilings stay in force in every scope (200 project folders, 500 transcripts per folder, 256 MB per transcript, 25 watched sessions) and an overflow is shown next to the selector, never silent.
- A project choice narrows the Sessions and agents list and the **All** view of the canvas to that project; it does not change what the relay scans.
- Codex, Copilot, Pi, Gemini CLI and OpenCode sessions are matched to the workspace by their own watchers and are not affected by the scope. The VS Code extension has no selector: it reads the sessions of its own workspace.

See [relay-sources.md](relay-sources.md) for the endpoint and its guards.

## Event sources and the local server

Hooks and JSONL transcripts are reconciled (no duplicate events), and the local server is loopback-only and hardened (`AGENT_LENS_PORT=0` or `--port 0` picks an ephemeral port). See [relay-sources.md](relay-sources.md).

Sessions of a cloud agent leave nothing on this machine. Fetch their JSONL transcript and import it with `node app/dist/app.js --import <file-or-folder>` (or `AGENT_LENS_IMPORT`): it is read once, listed as *imported - not live*, and never shown as running. See [Imported transcripts](relay-sources.md#imported-transcripts-294).

## JSONL event log

You can also point Agent Lens at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file.
2. Agent Lens will tail the file and visualize events as they arrive.
