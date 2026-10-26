# Reference

Commands, shortcuts, settings and scripts. For installation see [Install and configure](install.md); for contributing see [CONTRIBUTING](../CONTRIBUTING.md).

## Commands

| Command | Description |
|---------|-------------|
| `Agent Lens: Open Agent Lens` | Open the visualizer panel |
| `Agent Lens: Open Agent Lens to Side` | Open in a side editor column |
| `Agent Lens: Connect to Running Agent` | Manually connect to an agent session |
| `Agent Lens: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming |
| `Agent Lens: Install the Permission Hook (operator control)` | Install the optional PermissionRequest hook of the [operator control](operator-control.md) |
| `Agent Lens: Remove the Permission Hook (operator control)` | Remove that hook; the observation hooks stay |

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Cmd+Alt+A` (Mac) / `Ctrl+Alt+A` (Win/Linux) | Open Agent Lens |

Inside the app, `Ctrl+K` (`Cmd+K` on a Mac) opens the command palette: actions, panels, sessions (direct jump) and agents, all from the keyboard. `?` lists every shortcut. See [Reading the UI](reading-the-ui/command-palette.md).

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.runtime` | `"auto"` | Which agent runtime(s) to watch: `"auto"` (all), `"claude"`, `"codex"`, `"copilot"`, `"pi"`, `"gemini"`, or `"opencode"` |
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode). Machine-scoped: set it in your User Settings, a workspace `.vscode/settings.json` is ignored |
| `agentVisualizer.eventLogPath` | `""` | Path to a JSONL event log file to watch |
| `agentVisualizer.allowControl` | `false` | Let the panel answer Claude Code permission requests; see [operator control](operator-control.md). Machine-scoped: set it in your User Settings, a workspace `.vscode/settings.json` is ignored |
| `agentVisualizer.autoOpen` | `false` | Auto-open when an agent session starts |

## Scripts

`pnpm run dev` starts both the Next.js dev server and an event relay that receives Claude Code events and streams them to the browser via SSE.

| Script | Description |
|--------|-------------|
| `pnpm run dev:demo` | Start with the demo tour: every feature on mock data (script: [demo.md](demo.md)) |
| `pnpm run dev:demo:classic` | Start with the previous, single-session demo data |
| `pnpm run dev:demo:guided` | Start the step-by-step guided tour of the graph legend (13 steps, [demo.md](demo.md)). On a real session, **Tour this session** (beside **Legend**) explains only the symbols on screen ([Reading the UI](reading-the-ui/legend-and-tour.md)) |
| `pnpm run capture:media` | Regenerate the README GIF, video and captures in `docs/media/` from the demo tour (needs Chromium and `ffmpeg`, takes about two minutes) |
| `pnpm run dev:relay` | Run the event relay server standalone |
| `pnpm run mcp` | Run the read-only `agent-lens` MCP server on stdio (started by Claude Code from `.mcp.json`, see [mcp-server.md](mcp-server.md)) |
| `pnpm run dev:extension` | Watch-build the extension |
| `pnpm run build:all` | Production build (webview + extension) |
| `pnpm run build:web` | Build the Next.js web app |
| `pnpm run build:extension` | Build the extension |
| `pnpm run build:webview` | Build the webview assets |
| `pnpm run gen:themes` | Regenerate `web/app/themes.css` after editing the theme tokens (`web/lib/theme-tokens.json`) |
| `pnpm --filter agent-lens run package` | Build the extension and package it as a `.vsix` (runs `vsce package`; needs `@vscode/vsce` installed globally) |
