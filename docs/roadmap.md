# Roadmap: runtimes and remote access (#238, #241)

This page records where the work of two design issues stands: more agent runtimes ([#238](https://github.com/j0hn-42/agent-lens/issues/238)) and remote access, mobile and desktop ([#241](https://github.com/j0hn-42/agent-lens/issues/241)). It promises **no date**. Each statement points to a pull request, an issue or a file, so it can be checked. Status words: **Delivered** (merged into `develop`), **Partial** (a part is merged, the rest is named), **Blocked** (a stated reason stops it).

The proposed designs of #238 and #241 are converted into this page: the individual pieces are tracked by their own issues, listed below. It follows the principle of [Reading the UI](reading-the-ui.md): nothing is claimed that cannot be proven, and what was not verified is said so.

## Runtimes

| Runtime | Status | Evidence |
| --- | --- | --- |
| Claude Code | Delivered | `extension/src/claude-runtime.ts`, `extension/src/transcript-parser.ts` |
| Codex | Delivered | `extension/src/codex-runtime.ts`, `codex-session-watcher.ts`, `codex-rollout-parser.ts`; tests `extension/test/codex-*.test.ts` |
| GitHub Copilot | Delivered | [#169](https://github.com/j0hn-42/agent-lens/issues/169), PR [#172](https://github.com/j0hn-42/agent-lens/pull/172); `extension/src/copilot-*.ts`, `extension/test/copilot-*.test.ts` |
| Pi | Delivered | PR [#327](https://github.com/j0hn-42/agent-lens/pull/327); `extension/src/pi-event-parser.ts`, `pi-session-watcher.ts`, `pi-runtime.ts` |
| Gemini CLI | Delivered | PR [#334](https://github.com/j0hn-42/agent-lens/pull/334); `extension/src/gemini-*.ts`, `extension/test/gemini-*.test.ts` |
| OpenCode | Delivered | issue [#346](https://github.com/j0hn-42/agent-lens/issues/346) (closed), PRs [#392](https://github.com/j0hn-42/agent-lens/pull/392), [#408](https://github.com/j0hn-42/agent-lens/pull/408), [#415](https://github.com/j0hn-42/agent-lens/pull/415), [#416](https://github.com/j0hn-42/agent-lens/pull/416), [#418](https://github.com/j0hn-42/agent-lens/pull/418), [#419](https://github.com/j0hn-42/agent-lens/pull/419); `extension/src/opencode-*.ts`, `extension/test/opencode-*.test.ts` |
| Cursor | Partial | issue [#472](https://github.com/j0hn-42/agent-lens/issues/472) (open) |
| Antigravity | Blocked | issue [#473](https://github.com/j0hn-42/agent-lens/issues/473) |

What the delivered runtimes read, and their known limits (sub-agents, tokens and cost not read yet for Pi and Gemini CLI, OpenCode read from a SQLite file on Linux only), are in the [README](../README.md#features) and in [Reading the UI](reading-the-ui.md). The common shape of an adapter (a pure parser, a session watcher, a runtime module in `extension/src/`) is the one the first design of #238 proposed; no new abstraction was added.

### Delivered: the sources each runtime reads

- **Pi**: `~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl`, matched to the workspace through the `cwd` of the header.
- **Gemini CLI**: `~/.gemini/tmp/<project>/chats/session-<timestamp>-<id>.jsonl`, matched through the `projectHash` of the first record. The hash algorithm was an open point of the design; the code now matches on it (see the README).
- **OpenCode**: the SQLite database, opened read-only, with its own hardening and loss reporting (PRs [#417](https://github.com/j0hn-42/agent-lens/pull/417), [#521](https://github.com/j0hn-42/agent-lens/pull/521), [#565](https://github.com/j0hn-42/agent-lens/pull/565), [#580](https://github.com/j0hn-42/agent-lens/pull/580)). The design is `docs/superpowers/specs/2026-10-12-opencode-runtime-design.md`. macOS is not verified.
- **History**: the watchers of Codex, Copilot, Pi and Gemini CLI mark the history they replay as `replayed` (PR [#426](https://github.com/j0hn-42/agent-lens/pull/426)), so it is never shown as live.

### Partial: Cursor (#472)

- **Delivered**: the protection step, PR [#610](https://github.com/j0hn-42/agent-lens/pull/610). Cursor runs by default the hooks of `~/.claude/settings.json`, so Agent Lens's `hook.js` can forward Cursor payloads. `isCursorHookPayload` (`extension/src/hook-guards.ts`) recognises them on documented markers only and the hook server answers `200` with no session, agent or state. Test: `extension/test/cursor-hook-guard.test.ts`. Description: [Cursor hook payloads are ignored](relay-sources.md#cursor-hook-payloads-are-ignored-472).
- **Not done**: Cursor is **not** a supported runtime. No Cursor session, agent or tool call is shown.
- **Not done, and the next step**: "step 0", recording real payloads on a real machine. The tests use examples copied from Cursor's documentation, not captures. Open questions, from the PR: the shape of the payload that third-party hooks receive, whether it carries `cursor_version`, and whether an empty output of `hook.js` on `preToolUse` blocks the tool in Cursor.
- **Not verified**: whether the `cursor-agent` CLI supports hooks (the issue says no primary source confirms it) and the format of `transcript_path`. The design is `docs/superpowers/specs/2026-10-12-cursor-runtime-design.md` (PR [#348](https://github.com/j0hn-42/agent-lens/pull/348)); the freeze decision is in the first comment of #472.

### Blocked: Antigravity (#473)

Nothing is built. The only known storage, `~/.gemini/antigravity/conversations/*.pb`, is an undocumented binary protobuf, with contradicting paths and regressions reported (forum posts, no official source), and no public hooks. Per [#473](https://github.com/j0hn-42/agent-lens/issues/473), no work starts before a public format exists. The information stays here and in [#238](https://github.com/j0hn-42/agent-lens/issues/238).

## Remote access, mobile, desktop (#241)

### What exists

- **A named tunnel and a pairing token**: `--allow-host <name>` with `--token-file`, a 256-bit token per start, `POST /pair`, a `Secure`, `HttpOnly`, `SameSite=Strict` cookie, a read-only remote surface, and refusals at startup. PRs [#326](https://github.com/j0hn-42/agent-lens/pull/326), [#336](https://github.com/j0hn-42/agent-lens/pull/336), [#478](https://github.com/j0hn-42/agent-lens/pull/478), [#493](https://github.com/j0hn-42/agent-lens/pull/493), [#528](https://github.com/j0hn-42/agent-lens/pull/528), [#539](https://github.com/j0hn-42/agent-lens/pull/539). Reference: [Remote access](remote-access.md). Code: `scripts/remote-access.ts`, `scripts/remote-pairing.ts`; tests `scripts/remote-guards.test.ts`, `scripts/remote-pairing.test.ts`, `scripts/entrypoints-hardening.test.ts`.
- **The standalone app**: `node app/dist/app.js` (built by `pnpm run build:app`), entry `app/src/`.
- **A phone-sized view**: below 768 px, panels become full-width drawers, controls are at least 44 by 44 px. Issue [#476](https://github.com/j0hn-42/agent-lens/issues/476), PR [#481](https://github.com/j0hn-42/agent-lens/pull/481); an end-to-end check of a permission card with a drawer open, PR [#547](https://github.com/j0hn-42/agent-lens/pull/547). The top bar below 600 px: PR [#452](https://github.com/j0hn-42/agent-lens/pull/452).
- **Tray driver (no icon yet)**: the Node part of the tray icon (`app-tray/src/`), PRs [#483](https://github.com/j0hn-42/agent-lens/pull/483), [#498](https://github.com/j0hn-42/agent-lens/pull/498), [#541](https://github.com/j0hn-42/agent-lens/pull/541). Reference: [Tray icon](tray.md).

### What remains

- **Listening outside loopback** (`--remote --host <address>`): refused until TLS ships. The v1 decision was the tunnel; Agent Lens has no built-in TLS ([Remote access](remote-access.md#not-available-yet)).
- **Revoking one pairing, or a one-use token**: not done; restarting revokes everything.
- **Firefox and Safari**: the pairing cookie was checked in Chromium only.
- **A pairing step in the tray icon**: tracked in [#335](https://github.com/j0hn-42/agent-lens/issues/335).
- **The native tray binary**: see below.

### Blocked: the native tray binary (app-tray)

The driver exists; the native menu binary is not in the repository ([Tray icon](tray.md#what-exists-today)). The remaining work is separate issues, all open:

- [#335](https://github.com/j0hn-42/agent-lens/issues/335): the tray icon of the standalone app (umbrella).
- [#510](https://github.com/j0hn-42/agent-lens/issues/510): the native binary, in Go, following the JSON protocol of `docs/tray.md`.
- [#511](https://github.com/j0hn-42/agent-lens/issues/511): cross-compilation in CI for macOS, Windows and Linux.
- [#512](https://github.com/j0hn-42/agent-lens/issues/512): signing (Gatekeeper, SmartScreen) and distribution.
- [#556](https://github.com/j0hn-42/agent-lens/issues/556): checking the stop of the relay over the IPC channel on Windows (a named pipe, not tested there).

Whether to wrap the Node app in a desktop shell (Electron or Tauri) instead of a native binary was left open in #335; #510 chooses a Go binary for the menu. Nothing else is decided here.
