# Remote access

**Remote access is not usable today.** What works is the local view, on the machine that runs Agent Lens, including on a narrow window (see [Phone-sized window](#phone-sized-window-local-only)).

This page describes what the code does now. For the design and the open steps, see [Not available yet](#not-available-yet).

## What is protected, and what is not

Protected, with or without any flag:

- The server listens on `127.0.0.1` only. Every option of the relay that would open another address is refused at startup (next section), and no environment variable changes the address (`scripts/entrypoints-hardening.test.ts:361`).
- A request whose `Host` is not loopback gets `403` (see [What the request guard does](#what-the-request-guard-does)).
- On a loopback `Host`, `/events` refuses a foreign `Origin` or `Sec-Fetch-Site` (`isCrossOriginRequest`, `scripts/relay.ts:1288`).

**Not protected: anything that forwards a port to `127.0.0.1` and shows a loopback `Host`.** An SSH `-L` tunnel, the port forwarding of an editor or an IDE, a container or a virtual machine with a redirected port, or a proxy that rewrites `Host` to `127.0.0.1` all reach the whole loopback surface with no token and no authentication: `/events`, `/status`, but also `/context`, `/issue-links`, `/observations`, `/statusline` and `POST /scope`. The relay cannot tell such a request from a local one: its peer is loopback and its `Host` is loopback, and `gateRemoteRequest` lets it through untouched (`scripts/remote-access.ts:178`). This is documented in [Remote access: guards only](relay-sources.md#remote-access-guards-only-241-step-1) (the paragraph on SSH `-L`). So the refusals below do not make the relay "closed": do not forward its port to a network you do not trust.

## What the startup refuses

The standalone app (`node app/dist/app.js`) checks these flags before it sets anything up. A refusal prints `Agent Lens: <reason>` on stderr and exits with code 2 (`app/src/app.ts:27-31`, rules in `remoteStartupError`, `scripts/remote-access.ts:209`).

| Command | Result |
| --- | --- |
| `--host <address>` with an address other than `127.0.0.1` or `localhost` | refused: another address needs `--remote`, and is refused even with it |
| `--remote` alone, or `--remote` with `--host 127.0.0.1` / `localhost` | refused: `--remote` needs an explicit non-loopback `--host`, and there is never an implicit `0.0.0.0` |
| `--remote --host <address>` | refused: listening outside loopback waits for token authentication and TLS |
| `--allow-host <name>` | refused: a malformed name (IP address, wildcard, loopback name, default port, more than 4 names) with its own message; a valid name because the token pairing is not wired into the command yet |

`--host` and `--remote` are only read as flags. No environment variable turns them on: `AGENT_LENS_HOST`, `AGENT_LENS_REMOTE` and `HOST` are ignored, and the server still binds `127.0.0.1` (`scripts/entrypoints-hardening.test.ts:361`).

`--allow-host` is refused at startup because `REMOTE_AUTH_AVAILABLE` is `false` (`scripts/remote-access.ts:28`). It stays refused until the pairing token exists and is wired into the command (see [Not available yet](#not-available-yet)).

The development relay (`scripts/dev-relay.ts`) takes none of these flags: it refuses `--host`, `--remote` and `--allow-host` outright (`scripts/dev-relay.ts:14`, `:37-39`).

## What the request guard does

The app's server runs every request through the same host check before it answers (`app/src/server.ts:48`, `gateRemoteRequest` in `scripts/remote-access.ts`):

- a `Host` that is loopback (`127.0.0.1`, `localhost`, `[::1]`, any port) is served as before, with no token (see the warning above);
- any other `Host` gets `403`. While no `--allow-host` name can be set, every non-loopback `Host` is foreign (`scripts/remote-access.ts:74-77`);
- a request with two `Host` headers gets `403` (`scripts/remote-access.ts:85`).

For a name on the allow list, the guard is already written in `scripts/remote-access.ts` and tested (`scripts/remote-guards.test.ts`): only `GET`/`HEAD` on `/events`, `/status` and the static app, plus `POST /pair`. `/events` and `/status` answer `401` to a request without a pairing cookie (`scripts/remote-access.ts:197`); the static app is served without it, because it is the page that pairs. This is described in [Remote access: guards only](relay-sources.md#remote-access-guards-only-241-step-1). It is unreachable today, because no name can be allowed: `--allow-host` is refused, and `app/src/app.ts` does not pass any allowed name to the server.

## Tunnels

Do not use an SSH `-L` tunnel, or any port forward that shows a loopback `Host`, as a remote access path. Its browser opens `http://localhost:<port>`, which is a loopback `Host`, so it gets the full loopback surface with no token, and `--allow-host` does not cover it. The same holds for a proxy that rewrites `Host` to `127.0.0.1`, which includes a named tunnel configured that way. The relay does not know who is on the other end. The pairing token is planned to be required on a loopback `Host` too when the access is remote, but nothing does that yet. See [Remote access: guards only](relay-sources.md#remote-access-guards-only-241-step-1) for the details.

Agent Lens has no built-in TLS. A named tunnel such as Tailscale serve is the planned v1 path, and it is not usable yet.

## Phone-sized window (local only)

Below 768 px wide, the local view changes: an open panel becomes a full-width drawer, the controls are at least 44 by 44 px, and Escape closes the drawer. The behaviour is described in [Reading the UI](reading-the-ui.md), under **Phone width (below 768 px)**.

The view comes from issue [#476](https://github.com/j0hn-42/agent-lens/issues/476), delivered by PR [#481](https://github.com/j0hn-42/agent-lens/pull/481). This is a layout on the same loopback page. You can try it by narrowing a desktop browser window. It does not prove anything about a remote device: the view never says whether it runs on the relay's machine or elsewhere, because the event stream does not show it.

## Not available yet

Nothing on this page describes a command, a flag or a URL that does not exist yet.

**The pairing token exists in the code, but nothing uses it.** `scripts/remote-pairing.ts` holds the 256-bit token, the `--token-file` writer, the cookie and `createRemotePairing`, whose `handlePair` answers `POST /pair`. Both it and the `401` without a cookie are tested (`scripts/remote-pairing.test.ts`, `scripts/remote-guards.test.ts`). It came with [#475](https://github.com/j0hn-42/agent-lens/issues/475) (PR #493). But no command creates a pairing today: `app/src/args.ts` has no `--token-file`, `app/src/app.ts` passes neither `allowedHosts` nor a pairing to the server, and `REMOTE_AUTH_AVAILABLE` stays `false`. So no remote browser can pair or read anything.

- **Wiring into the command** ([#517](https://github.com/j0hn-42/agent-lens/issues/517)): `--token-file` in the command, passing the allowed names and the pairing to the server, the pairing address the startup prints, the pairing step in the web page, and turning `--allow-host` on.
- **The mobile and desktop plan** ([#241](https://github.com/j0hn-42/agent-lens/issues/241)): the umbrella issue. The system tray icon is tracked in [#335](https://github.com/j0hn-42/agent-lens/issues/335).

Until #517 lands, `--allow-host` is refused and remote access stays off.

## See also

- [Remote access: guards only](relay-sources.md#remote-access-guards-only-241-step-1) in the event-source guide (the guards, the read-only surface and their limits)
- [Reading the UI](reading-the-ui.md) (the views, including the phone-width drawer)
- `node app/dist/app.js --help` (the flags, with the same refusals as above)
