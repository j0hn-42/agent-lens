# Remote access

**Remote access is not usable today.** The relay listens on `127.0.0.1` only, and every option that would open it to another address is refused at startup. What works is the local view, on the machine that runs Agent Lens, including on a narrow window (see [Phone-sized window](#phone-sized-window-local-only)).

This page describes what the code does now. For the design and the open steps, see [Not available yet](#not-available-yet).

## What the startup refuses

The standalone app (`node app/dist/app.js`) checks these flags before it sets anything up. A refusal prints `Agent Lens: <reason>` on stderr and exits with code 2 (`app/src/app.ts:27-31`, rules in `remoteStartupError`, `scripts/remote-access.ts:209`).

| Command | Result |
| --- | --- |
| `--host <address>` with an address other than `127.0.0.1` or `localhost` | refused: another address needs `--remote`, and is refused even with it |
| `--remote` alone, or `--remote` with `--host 127.0.0.1` / `localhost` | refused: `--remote` needs an explicit non-loopback `--host`, and there is never an implicit `0.0.0.0` |
| `--remote --host <address>` | refused: listening outside loopback waits for token authentication and TLS |
| `--allow-host <name>` | refused: the token pairing is not wired into the command yet |

`--host` and `--remote` are only read as flags. No environment variable turns them on: `AGENT_LENS_HOST`, `AGENT_LENS_REMOTE` and `HOST` are ignored, and the server still binds `127.0.0.1` (`scripts/entrypoints-hardening.test.ts:361`).

`--allow-host` is refused at startup because `REMOTE_AUTH_AVAILABLE` is `false` (`scripts/remote-access.ts:28`). It stays refused until the pairing token exists and is wired into the command (see [Not available yet](#not-available-yet)).

The development relay (`scripts/dev-relay.ts`) takes none of these flags: it refuses `--host`, `--remote` and `--allow-host` outright (`scripts/dev-relay.ts:14`, `:37-39`).

## What the request guard does

The app's server runs every request through the same host check before it answers (`app/src/server.ts:48`, `gateRemoteRequest` in `scripts/remote-access.ts`):

- a `Host` that is loopback (`127.0.0.1`, `localhost`, `[::1]`, any port) is served as before;
- any other `Host` gets `403`. While no `--allow-host` name can be set, every non-loopback `Host` is foreign (`scripts/remote-access.ts:74-77`);
- a request with two `Host` headers gets `403` (`scripts/remote-access.ts:85`).

The remote read-only surface (`/events`, `/status` and the static app, through an allowed name only) is described in [Remote access: guards only](relay-sources.md#remote-access-guards-only-241-step-1). It is unreachable today, because no name can be allowed.

## Tunnels

Do not use an SSH `-L` tunnel as a remote access path. Its browser opens `http://localhost:<port>`, which is a loopback `Host`, so it gets the full loopback surface, and `--allow-host` does not cover it. The relay does not know who is on the other end of the tunnel. See [Remote access: guards only](relay-sources.md#remote-access-guards-only-241-step-1) for the details.

Agent Lens has no built-in TLS. A named tunnel such as Tailscale serve is the planned v1 path, and it is not usable yet.

## Phone-sized window (local only)

Below 768 px wide, the local view changes: an open panel becomes a full-width drawer, the controls are at least 44 by 44 px, and Escape closes the drawer. The behaviour is described in [Reading the UI](reading-the-ui.md), under **Phone width (below 768 px)**.

This is a layout on the same loopback page. You can try it by narrowing a desktop browser window. It does not prove anything about a remote device: the view never says whether it runs on the relay's machine or elsewhere, because the event stream does not show it.

## Not available yet

These items are not in the code. Nothing on this page describes a command, a flag or a URL that does not exist yet.

- **Pairing token and read-only remote surface** ([#475](https://github.com/j0hn-42/agent-lens/issues/475)): the token a remote browser uses to pair, and the read-only surface it then reads.
- **Wiring into the command** ([#517](https://github.com/j0hn-42/agent-lens/issues/517)): how the token is given to the command, the pairing address the startup prints, and turning `--allow-host` on once the token is required.
- **The mobile and desktop plan** ([#241](https://github.com/j0hn-42/agent-lens/issues/241)): the umbrella issue. The system tray icon is tracked in [#335](https://github.com/j0hn-42/agent-lens/issues/335).

Until #517 lands, `--allow-host` is refused and remote access stays off.

## See also

- [Remote access: guards only](relay-sources.md#remote-access-guards-only-241-step-1) in the event-source guide (the guards, the read-only surface and their limits)
- [Reading the UI](reading-the-ui.md) (the views, including the phone-width drawer)
- `node app/dist/app.js --help` (the flags, with the same refusals as above)
