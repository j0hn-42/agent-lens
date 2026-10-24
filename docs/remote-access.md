# Remote access

Remote access goes through a **named tunnel** (for example Tailscale serve) that forwards to `127.0.0.1`. The standalone app accepts the tunnel's name with `--allow-host <name>`, and a device reads the event stream only after it has paired with the token of this start. The server itself still listens on `127.0.0.1` only, and Agent Lens has no built-in TLS: the tunnel provides HTTPS.

This page describes what the code does now. What is not done is listed in [Not available yet](#not-available-yet).

## Start it

```bash
node app/dist/app.js --allow-host box.tail1234.ts.net --token-file ~/.agent-lens/pair-token
```

- `--allow-host` needs `--token-file`, and `--token-file` needs `--allow-host`; otherwise the start stops (see [What the startup refuses](#what-the-startup-refuses)).
- At every start, a new pairing token of 256 random bits is drawn (`createRemotePairing`, `scripts/remote-pairing.ts`). It is written to the `--token-file` path, which is replaced at every start and never read back. On Linux and macOS the file is owner only (mode `0600`), even when a wider file was there before. On Windows the mode is ignored and the file inherits the access rights of its folder: pick a folder only you can read. A file that cannot be written (a missing folder, for example) stops the start with exit code 2.
- After the line `Server running at http://127.0.0.1:<port>`, the start prints the pairing URLs: `https://<name>/#pair=<token>` for each allowed name, and `http://127.0.0.1:<port>/#pair=<token>` for this machine (`app/src/pairing-banner.ts`). The token is only in the part after `#`, which a browser never sends to a server.
- The token is printed only when the standard output is a terminal. In a pipe or a service log, the URLs end with `#pair=<the token in the file above>`: read the token from the `--token-file` file. The relay never logs the token and never sends it over HTTP.
- While `--allow-host` is on, the browser is not opened automatically: the bare address would read nothing, and the pairing URL would put the token on a command line. Open one of the printed URLs.

## Pair a device

Open the pairing URL on the device. Before anything else, the page removes the fragment from the address bar with `history.replaceState`, so the token stays neither in the address bar, nor in the history, nor in a bookmark. Then it posts the token to `POST /pair` (`web/lib/remote-pairing.ts`, called by `web/app-entry.tsx` before the first connection).

`POST /pair` compares the token in constant time. The right token gets `204` and a cookie `__Host-agent-lens-pair` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`). The cookie holds a separate random id, never the token. Every failure (wrong token, missing token, malformed body, wrong `Content-Type`) is the same `401 Unauthorized`, then `429` once the failure budget of that name is spent; the right token still pairs.

Lifetime, in this first version:

- the token can be used again by every device that has it, for the whole run;
- a pairing lasts 12 hours, then the device pairs again with the token;
- at most 8 pairings at once (`503` past that, until one expires);
- nothing revokes one pairing: restarting Agent Lens draws a new token and forgets every pairing.

The cookie was checked in Chromium on `http://127.0.0.1:<port>` and `http://localhost:<port>`. Firefox and Safari were not checked. A browser that does not keep the cookie reads nothing (`401`).

## What a tunnel name reaches

A request whose `Host` is exactly an allowed name (same port, case-insensitive) reaches a strict read-only surface (`gateRemoteRequest`, `scripts/remote-access.ts`):

- `GET`/`HEAD` on `/events` and `/status`, with a live pairing cookie; `401` without one;
- the static app (the page that pairs, it holds no data), without a cookie;
- `POST /pair`.

Everything else gets `403`: `/context`, `/issue-links`, `/observations`, `/statusline`, `POST /scope`, `/launch`, any other method. So does a request with an `Origin` other than `https://<name>` or a `Sec-Fetch-Site` other than `same-origin` / `none`, a request with two `Host` headers, and any `Host` that is neither loopback nor allowed (DNS rebinding). The tests are in `scripts/remote-guards.test.ts`, `scripts/remote-pairing.test.ts` and, through the real command, `scripts/entrypoints-hardening.test.ts`. The details are in [Remote access: guards and pairing](relay-sources.md#remote-access-guards-and-pairing-241).

## While `--allow-host` is on, a loopback `Host` needs the pairing too

An SSH `-L` tunnel, the port forwarding of an editor, a container with a redirected port, or a proxy that rewrites `Host` to `127.0.0.1` all show a loopback `Host`: the relay cannot tell them from a local tab. So while `--allow-host` is on, every loopback route answers `401` without a live pairing cookie (`requiresRemotePairing`, `scripts/remote-access.ts`): `/events`, `/status`, `/context`, `/issue-links`, `/observations`, `/statusline`, `POST /scope` and `/launch`. Only the static app and `POST /pair` answer without it. On a loopback `Host`, `POST /pair` accepts only the page's own origin, `http://<Host>`.

This includes your own browser on the machine that runs Agent Lens: pair it with the `http://127.0.0.1:<port>/#pair=` URL. With the cookie, a loopback `Host` gets the whole loopback surface, as before. The headless commands (`agent-lens ps`, `tail`, `statusline`, see [Headless use](headless.md)) send no cookie: while `--allow-host` is on they get `relay answered HTTP 401`.

## Without `--allow-host`, nothing changes

Without `--allow-host`, there is no token and no pairing. The server listens on `127.0.0.1` only, a request whose `Host` is not loopback gets `403`, and a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`, any port) is served as before.

**Not protected in that mode: a port forward that shows a loopback `Host`.** An SSH `-L` tunnel, an editor's port forwarding or a proxy that rewrites `Host` reaches the whole loopback surface with no token, because the relay cannot tell it from a local request. Do not forward the port of an Agent Lens started without `--allow-host` to a network you do not trust.

## What the startup refuses

The standalone app checks these flags before it sets anything up (`remoteStartupError`, `scripts/remote-access.ts`). A refusal prints `Agent Lens: <reason>` on stderr and exits with code 2.

| Command | Result |
| --- | --- |
| `--allow-host <name>` without `--token-file` | refused: the token needs a file |
| `--token-file <path>` without `--allow-host`, or `--token-file` without a path | refused: a security flag is never a no-op |
| `--allow-host <name>` with a malformed name (IP address, wildcard, loopback name, default port, more than 4 names) | refused, with its own message |
| `--allow-host <name> --token-file <path>` whose file cannot be written | stops with exit code 2 before listening |
| `--host <address>` with an address other than `127.0.0.1` or `localhost` | refused: another address needs `--remote`, and is refused even with it |
| `--host ::1` | refused: the server listens on `127.0.0.1` only (IPv4 loopback); leave out `--host` |
| `--remote` alone, or `--remote` with `--host 127.0.0.1` / `localhost` | refused: `--remote` needs an explicit non-loopback `--host`, and there is never an implicit `0.0.0.0` |
| `--remote --host <address>` | refused until TLS ships: without it the token and the stream would travel in clear text |

`--host` and `--remote` are only read as flags. No environment variable turns them on: `AGENT_LENS_HOST`, `AGENT_LENS_REMOTE` and `HOST` are ignored, and the server still binds `127.0.0.1` (`scripts/entrypoints-hardening.test.ts`).

The development relay (`scripts/dev-relay.ts`) takes none of these flags: it refuses `--host`, `--remote` and `--allow-host` outright.

## Phone-sized window

Below 768 px wide, the view changes: an open panel becomes a full-width drawer, the controls are at least 44 by 44 px, and Escape closes the drawer. The behaviour is described in [Reading the UI](reading-the-ui/small-screens.md), under **Phone width (below 768 px)**.

The view comes from issue [#476](https://github.com/j0hn-42/agent-lens/issues/476), delivered by PR [#481](https://github.com/j0hn-42/agent-lens/pull/481). You can try it by narrowing a desktop browser window. The view never says whether it runs on the relay's machine or elsewhere, because the event stream does not show it.

## Not available yet

- **Listening outside loopback** (`--remote --host <address>`): refused until TLS ships. Use a named tunnel.
- **Revoking one pairing, or a token for one use only**: not done. Restarting Agent Lens revokes everything.
- **A pairing step in the tray icon**: tracked in [#335](https://github.com/j0hn-42/agent-lens/issues/335).
- **The mobile and desktop plan**: the umbrella issue [#241](https://github.com/j0hn-42/agent-lens/issues/241). The token came with [#475](https://github.com/j0hn-42/agent-lens/issues/475) (PR #493); [#517](https://github.com/j0hn-42/agent-lens/issues/517) wired it into the command.

## See also

- [Remote access: guards and pairing](relay-sources.md#remote-access-guards-and-pairing-241) in the event-source guide (the guards, the read-only surface and their limits)
- [Reading the UI](reading-the-ui/small-screens.md) (the small-screen views, including the phone-width drawer)
- `node app/dist/app.js --help` (the flags)
