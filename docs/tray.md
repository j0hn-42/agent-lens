# Tray icon (driver, not shipped yet)

The standalone app can get a system tray icon (#335): open the interface, see how many sessions are tracked, copy the local URL, quit. The icon is **optional and separate**: `agent-lens` (the CLI in `app/`) does not change and gains no dependency, and everything the menu offers already exists in the console output, the web UI and [`/statusline`](headless.md).

## What exists today

The package `app-tray/` holds the part written in Node:

- `menu-model.ts`: the pure menu logic (what each item says).
- `driver.ts` and `cli.ts`: the driver, which starts the relay, probes it and talks to the native menu binary.
- `protocol.ts`: the JSON line protocol between the driver and that binary.
- `open-url.ts`: opening the browser and copying the URL.

The Go module `app-tray/native/` (package `trayproto`, Go standard library only, #510) holds the protocol side of the native binary:

- strict validation of the driver's lines (the rules of [Protocol](#protocol-driver-and-native-binary): version, exact keys written once each, known and unrepeated item ids, `null` refused, 16 KiB per line at most; the tooltip and the labels are refused when they hold invalid UTF-8, a control character other than tab and line feed, or a bidirectional formatting character such as an override), a bounded line reader, and the three fixed lines the binary writes (`ready`, `click`, `closed`);
- a `Session` that only lets the menu click an **enabled item of the menu on screen**, stops accepting clicks once the driver is gone (`Click` then returns an error and writes nothing; `Ready` and `Closed` still write, and a write to a closed pipe returns its error to the caller), logs a refused line with a fixed reason (never its content) and stops after 20 of them, like the driver;
- a `UI` interface where a native menu plugs in. There is no implementation of it: **no icon is drawn**, nothing is shown on screen.

What its tests prove, on Linux, without any GUI: `app-tray/protocol-fixtures.json` holds the lines both sides exchange (the menus are the ones `deriveMenu` really builds, in French and English); the Node tests check that the driver writes and accepts exactly those lines, the Go tests that the module parses and writes them. The lines the binary must refuse are checked by the Go tests only (the driver has no parser for the lines it writes). A Go test also runs the real driver (`app-tray/src/cli.ts`) with a Go program built on the module and a headless UI, and the test relay: the click on "quit" stops the relay over its IPC channel, and both the driver and the Go program exit `0` (the Go program writes its own exit code, which the test reads). CI runs `gofmt`, `go vet` and `go test` on it (see [CONTRIBUTING](../CONTRIBUTING.md)). It also cross-compiles it, in pure Go (`CGO_ENABLED=0`), for `linux/amd64`, `darwin/arm64` and `windows/amd64`: `go build` and `go vet` must pass for each target (#511). This only proves that the module compiles for these systems: the tests run on Linux only, the module has no `main` package, so no binary is produced or published.

**The native menu binary, the part that draws the icon, is not part of this repository yet.** Without it the driver has nothing to draw the icon with. The GUI binding, the cross-compilation of the GUI binary in CI (only the module is cross-compiled today, see above) and the checks on Windows, macOS and Linux desktops are separate pieces of work, tracked apart from #335. The release workflow already knows how to build, sign and publish that binary once it exists ([Signing and release](#signing-and-release)), but it has never run on a real binary. Until then, use the [fallbacks without an icon](#without-an-icon).

## Running the driver

```bash
pnpm run build:app                        # builds app/dist/app.js, the relay
node --import tsx app-tray/src/cli.ts --tray-bin <path-to-the-native-binary>
```

| Option | Effect |
| --- | --- |
| `--tray-bin <path>` | the native menu binary (or `AGENT_LENS_TRAY_BIN`); required |
| `--attach <port>` | do not start a relay: query the one already listening on `127.0.0.1:<port>` |
| `--relay-entry <file>` | the relay to start instead of `app/dist/app.js` |

Exit codes: `0` quit, `1` failure while running (the relay or the binary died, the relay printed no URL, the relay did not stop), `2` bad command line. Diagnostics go to stderr, prefixed `agent-lens-tray:`. When the state of the `/status` probe changes, one line says so: `/status probe failed: <kind>` (`unreachable`, `timeout`, `http-error` or `invalid-json`, never the answer itself) and `/status probe answers again`. The labels are in French when `LC_ALL`, `LC_MESSAGES` or `LANG` starts with `fr`, in English otherwise (the `tray.*` keys of the UI catalogue).

By default the driver starts `app/dist/app.js --port 0 --no-open --ipc-stop` itself and reads the URL from the relay's `Server running at http://127.0.0.1:<port>` line. Only that exact line is trusted: another host, an invalid port or extra text is ignored.

## What the menu shows, and what it never shows

The menu is rebuilt after every probe of `GET /status` (one request at a time, a 2 second time limit; the next one starts 5 seconds after the previous probe ends, so probes are 5 to 7 seconds apart). It follows [Reading the UI](reading-the-ui.md): nothing is shown that cannot be proven.

- "n sessions tracked" is `sessionCount` of a **valid, recent** `/status` answer from an Agent Lens relay (a `relayVersion` of the expected form). A recent answer is one received less than 15 seconds ago: by then at least two later probes have ended, and a failed probe already says unknown.
- When `/status` does not answer, times out, answers an error, answers something that is not JSON or is larger than 64 KiB, comes from something else than Agent Lens, or lacks `sessionCount`, the item says **unknown**. The last known count is never shown as current.
- "Untracked sessions: at least k" appears only when `skippedSessions` is valid and the total is above zero. Read it as "at least".
- The tooltip (the accessible name of the icon) repeats the state in text. The state is never carried by a colour or an animation alone.

| Item | Click |
| --- | --- |
| Open the interface | opens `http://127.0.0.1:<port>` in the default browser (disabled when the port is unknown) |
| Copy local URL | copies that URL to the clipboard |
| Quit and stop the relay | the driver started the relay: sends it the stop message (see [Stopping the relay](#stopping-the-relay)), which runs its normal clean-up, then closes the icon |
| Close the icon, the relay keeps running | the driver only attached (`--attach`): closes the icon, the relay is not touched |

The state items are not actions (disabled). Open and Copy each run one at a time, at most once per second: a click that arrives while the previous one is still running, or less than a second after it, is ignored.

## Safety

- **Loopback only.** The driver only contacts `127.0.0.1`. The relay it starts keeps its own guards.
- **The binary sends an item id, nothing else.** A click carries one of `open`, `copyUrl`, `state`, `skipped`, `quit`. Never a command, a path or a URL: the URL is built by the driver from the validated port of the relay.
- **No shell.** The browser and the clipboard tool are started with an argument array, only for the exact URL `http://127.0.0.1:<port>` (or `localhost`) of the relay: no credential, path, query or other host. The openers are `xdg-open` (Linux), `open` (macOS) and `rundll32 url.dll,FileProtocolHandler` (Windows, to avoid `cmd /c start`). The clipboard tools are `wl-copy`, `xclip` then `xsel` (Linux), `pbcopy` (macOS), `clip` (Windows).
- **Only its own child is stopped.** The stop message goes to the relay process the driver started, never to a PID found through a port, a file or `/status`. If the relay has not stopped after 5 seconds, the driver says so on stderr, leaves it and exits `1`: it never sends `SIGTERM` or `SIGKILL` in its place.
- **Bounded protocol.** An incoming line is limited to 1024 bytes; a longer line is dropped without being buffered. A line that is not valid JSON, has the wrong version, an unknown type, an unknown item id or an extra key is ignored and logged. After 20 invalid lines the driver stops the binary. In the other direction, a menu is written only once the previous write has reached the pipe; refreshes asked in between (a binary repeating `ready`, for example) are merged into one menu with the latest state. If more than 64 KiB still wait for the binary, it does not read its input: the driver says so on stderr and stops (exit `1`).
- **The relay lives as long as the driver started it.** Quit, a closed icon, a binary that exits, `SIGTERM`, `SIGINT` or `SIGHUP` on the driver all stop the relay it started. If the relay exits by itself, the driver stops (exit `1`).

## Stopping the relay

On Windows, `SIGTERM` ends a Node process without running its handlers, so the relay's clean-up (end of sessions, telemetry, removal of its discovery file) would not run (#513). The driver therefore stops the relay it started over a **Node IPC channel**, on every system:

- The driver starts the relay with an extra `'ipc'` slot in its standard streams (the channel `child_process.fork` uses) and the internal flag `--ipc-stop`. Only the driver, which created the channel when it started the relay, can write on it.
- To stop it, the driver sends exactly `{"v":1,"type":"stop"}`. The relay runs the same clean-up as `SIGINT`/`SIGTERM`/`SIGHUP` (once, whatever arrives first) and exits `0`.
- If the driver dies (killed, crashed), the channel closes and the relay runs the same clean-up: it does not outlive the driver that owns it.
- A stop (or a dead driver) that arrives while the relay is still starting is kept and runs once the server listens. If that clean-up fails, the relay says so with one fixed line on stderr (no detail) and exits `1`.
- Node offers no size limit for a message on an IPC channel (it parses the JSON before the relay sees it), so none is enforced: the guard is that only the process that created the channel can write on it. A message that is not exactly the stop message is dropped unread.
- Any other message (another type or version, an extra key, a string, an array, a message carrying a socket or a handle) is ignored; at most three fixed lines say so on stderr, never the content.
- `--ipc-stop` is internal, absent from `--help`, never read from an environment variable and off by default. Given without the channel (by hand in a terminal, for example) the relay refuses to start (exit `2`). Without the flag nothing changes: no listener, `SIGINT`, `SIGTERM` and `SIGHUP` work as before, and a message on a channel is not read.
- There is no route: no HTTP endpoint stops the relay, not even on loopback, and the relay reads nothing on its standard input.

What is proven, and where: the tests run on Linux (`app/src/ipc-stop.real.test.ts` starts the real relay with a throw-away `HOME`; `app-tray/src/driver.test.ts` uses a fake relay). The IPC channel is a named pipe on Windows instead of a socket pair: the channel is **not tested on Windows** here, neither the stop message nor the clean-up when the driver dies. Until it is checked on Windows, treat a clean stop there as expected, not proven.

## Protocol (driver and native binary)

One JSON object per line on the binary's stdin (driver to binary) and stdout (binary to driver), UTF-8, `"v": 1`. No socket.

```jsonc
// driver -> binary
{"v":1,"type":"menu","tooltip":"Agent Lens: 2 sessions tracked","items":[{"id":"open","label":"Open the interface","enabled":true}]}
{"v":1,"type":"quit"}                       // remove the icon and exit

// binary -> driver
{"v":1,"type":"ready"}                      // the icon is up: the driver resends the menu
{"v":1,"type":"click","id":"open"}
{"v":1,"type":"closed"}                     // the icon is gone
```

The binary draws `label` as the item text and the accessible name, `tooltip` as the icon's name, and greys out `enabled: false`. It must not run anything itself and must open no socket. The driver sends a `menu` message again only when the menu changed (and on `ready`).

## Accessibility of the native menu

All native menus come from the system, so what a screen reader reads depends on the platform. To be checked by hand once a binary exists, on each system.

- **macOS**: VoiceOver reads the items; the menu bar is reachable from the keyboard (Ctrl+F8 with full keyboard access, or VO+M).
- **Windows**: Win+B focuses the notification area, then the arrow keys and Enter or the Menu key open the menu; Narrator and NVDA read it. The tooltip gives the icon its name.
- **Linux**: support varies. GNOME shows no icon without the AppIndicator extension; Orca reading depends on the panel (KDE Plasma is correct, others are partial). Test on at least GNOME with the extension and KDE.

## Limits

- **Windows.** The relay is stopped over the IPC channel rather than `SIGTERM`, whose handlers do not run on Windows ([Stopping the relay](#stopping-the-relay)). That channel is not tested on Windows yet. A relay started by hand (`--attach`) is never stopped by the driver.
- **The clipboard on Linux** is best effort: with none of `wl-copy`, `xclip` or `xsel`, the driver logs the URL on stderr instead.
- **No pairing item.** The only URL is the local one; a pairing item waits for the remote-access token ([#241](https://github.com/j0hn-42/agent-lens/issues/241)).

## Signing and release

The release workflow (`.github/workflows/release.yml`, on a `v*` tag or by hand, never on `develop`) builds the tray binary only when its main package `app-tray/native/cmd/agent-lens-tray` exists (job `tray-detect`). Today it does not: the tray jobs are skipped and a release carries the `.vsix` and its `SHA256SUMS` only. Once the package exists, the job `tray-build` runs after the full CI, on `ubuntu-latest` (`linux/amd64`), `macos-latest` (`darwin/arm64`) and `windows-latest` (`windows/amd64`), and hands each binary to `app-tray/release/sign-tray.mjs`.

### What a binary becomes

For each platform the script looks at its secrets (an empty secret counts as absent):

- **None set**: the binary is published as `agent-lens-tray-<version>-<os>-<arch>-unsigned` (`.exe` on Windows). The release does not fail. Linux binaries are always `-unsigned`: there is no signing on Linux.
- **Some set, not all**: the job fails and names the missing secrets (never a value). Nothing is published: a release with half a configuration is a mistake, not an unsigned release.
- **All set**: the binary is signed, then verified. The name loses `-unsigned` only after every check below passed. If one fails, the job fails, the copy is deleted and the release is not created.

| Platform | Secrets (repository secrets) | Signing | Checks that must pass |
| --- | --- | --- | --- |
| macOS | `MACOS_CERTIFICATE_P12_BASE64` (Developer ID Application certificate and key, `.p12` in base64), `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY` (for example `Developer ID Application: Name (TEAMID)`), `MACOS_NOTARY_APPLE_ID`, `MACOS_NOTARY_TEAM_ID`, `MACOS_NOTARY_PASSWORD` (an app-specific password) | imported into a temporary keychain, deleted at the end; `codesign --sign` with the hardened runtime (`--options runtime`) and a secure timestamp | `codesign --verify --strict` exits `0`; `codesign --display` shows the `runtime` flag and `TeamIdentifier` equal to `MACOS_NOTARY_TEAM_ID`; `xcrun notarytool submit --wait` answers the status `Accepted` |
| Windows | `WINDOWS_CERTIFICATE_PFX_BASE64` (code signing certificate and key, `.pfx` in base64), `WINDOWS_CERTIFICATE_PASSWORD` | `signtool sign` (Windows SDK) with SHA-256 and an RFC 3161 timestamp (`http://timestamp.digicert.com`) | `signtool verify /pa` exits `0` |

Each signing step receives only the secrets of its own platform, as environment variables; no secret is expanded in a script, and the build step sees none. The decoded certificate is written to a `0600` file in the runner's temporary directory and removed. The output of the signing tools is printed only when a step fails, with every secret value replaced by `***` (Actions also masks registered secrets).

### Setting up the secrets

Only the owner of the repository can do this: nothing in the repository creates, holds or tests these values. They are repository secrets of `j0hn-42/agent-lens`, set in GitHub under Settings > Secrets and variables > Actions, or with `gh secret set` as below. Without a value, `gh secret set` asks for it at a hidden prompt, and a file can be piped on its standard input. Never pass a value with `--body`: it would stay in your shell history. Set every secret of a platform, or none of them: a partial set fails the release (see above). `gh secret list --repo j0hn-42/agent-lens` shows the names, never the values.

**macOS (Developer ID and notarization).**

1. The team needs a paid Apple Developer Program membership. Only its Account Holder can create a Developer ID certificate.
2. Create a certificate of type **Developer ID Application** (not Apple Development, not Developer ID Installer), in Xcode (Settings > Accounts > Manage Certificates) or in Certificates, Identifiers & Profiles on developer.apple.com, on the Mac that keeps its private key.
3. In Keychain Access, export that certificate with its private key as a `.p12` file, protected by a password:

   ```bash
   base64 < developer-id.p12 | gh secret set MACOS_CERTIFICATE_P12_BASE64 --repo j0hn-42/agent-lens
   gh secret set MACOS_CERTIFICATE_PASSWORD --repo j0hn-42/agent-lens    # the .p12 export password
   ```

   The line breaks that `base64` adds are accepted.
4. On that Mac, `security find-identity -v -p codesigning` lists the identity between quotes, for example `Developer ID Application: Name (ABCDE12345)`. Copy it exactly:

   ```bash
   gh secret set MACOS_SIGNING_IDENTITY --repo j0hn-42/agent-lens
   ```

5. The Team ID is the ten characters between parentheses at the end of the identity (also in Membership details on developer.apple.com). The release fails if the signature carries another one:

   ```bash
   gh secret set MACOS_NOTARY_TEAM_ID --repo j0hn-42/agent-lens
   ```

6. Notarization needs an Apple ID that is a member of the team, and an app-specific password created for it at account.apple.com (Sign-In and Security > App-Specific Passwords). The Apple ID's own password does not work:

   ```bash
   gh secret set MACOS_NOTARY_APPLE_ID --repo j0hn-42/agent-lens    # the Apple ID email
   gh secret set MACOS_NOTARY_PASSWORD --repo j0hn-42/agent-lens    # the app-specific password
   ```

**Windows (Authenticode).** The script signs with a certificate file (`signtool sign /f <file> /p <password>`), so it needs a code signing certificate whose private key is exportable as a `.pfx`. Since 1 June 2023 the CA/Browser Forum requires the private key of every new code signing certificate (OV and EV) to be generated and kept in hardware, a token or an HSM, so certificate authorities no longer issue such a file. A certificate bought today will most likely not fit this step: signing with it needs a cloud signing service or a hardware token on the runner, which `sign-tray.mjs` does not support and which is separate work. Only a certificate issued before that date, still valid, with an exportable key, fits:

```bash
base64 < code-signing.pfx | gh secret set WINDOWS_CERTIFICATE_PFX_BASE64 --repo j0hn-42/agent-lens
gh secret set WINDOWS_CERTIFICATE_PASSWORD --repo j0hn-42/agent-lens    # the .pfx password
```

In PowerShell, the first line is `[Convert]::ToBase64String([IO.File]::ReadAllBytes("code-signing.pfx")) | gh secret set WINDOWS_CERTIFICATE_PFX_BASE64 --repo j0hn-42/agent-lens`.

**After the secrets are set.** Nothing proves them until a release runs with the tray package present: the job log must print `signed and verified` for each platform, and the published names must have lost `-unsigned`. Anyone can then check a downloaded file: `codesign --verify --strict --verbose=2 <file>` and `codesign --display --verbose=2 <file>` (Developer ID, `runtime` flag, Team ID) on macOS; `signtool verify /pa <file>` or `Get-AuthenticodeSignature <file>` in PowerShell on Windows.

### Checksums

`sign-tray.mjs` writes a `<file>.sha256` next to each binary when it is built. The release job checks them with `sha256sum -c` after downloading the artefacts (a mismatch fails the release), then attaches a `SHA256SUMS` of every file it publishes, the `.vsix` included. Check a download with `sha256sum -c SHA256SUMS --ignore-missing`. A checksum proves that the file is the one the workflow built, not who built it: it is not a signature.

### What is not verified

- **None of this has run.** The tray jobs are skipped until the main package exists, so they have never run: the workflow has never built, signed or published a tray binary, on any runner. The build step (`go build -trimpath`) will likely need the dependencies of the GUI binding (a C toolchain, GTK or AppIndicator headers on Linux), which are unknown today.
- **No real signature has been made.** No certificate is configured. The tests (`scripts/ci-tray-sign.test.ts`) run the script on Linux against fake `codesign`, `security`, `xcrun`, `ditto` and `signtool` (`app-tray/test/fake-signing-tool.mjs`): they prove what the script does with each answer (labels, failures, clean-up, no secret printed), not that Apple or Microsoft accept the signature. `scripts/ci-tray-release.test.ts` reads the structure of the workflow; nothing runs GitHub Actions.
- **Gatekeeper is not assessed.** `spctl --assess` is not run: the binary is a bare executable, not an `.app`, and its result on such a file has not been checked here. The notarization ticket cannot be stapled to a bare binary, so it is not stapled: Gatekeeper looks it up online at first launch, and offline it cannot.
- **SmartScreen is not checked.** SmartScreen trusts a file by the reputation of its certificate and its downloads, which no test can show; a newly signed binary can still be warned about. `signtool verify /pa` only proves that the Authenticode signature is valid and chains to a trusted root.
- **The Windows signer is not compared** with an expected name: any certificate that `signtool verify /pa` accepts passes.
- **A GitHub Release is not signed itself.** Its files are signed (when the secrets exist) and listed in `SHA256SUMS`; no provenance attestation is published.

## Without an icon

The icon is never the only way. Start the app in a terminal (`node app/dist/app.js`, `Ctrl+C` quits), or at the start of your session with `launchd` (macOS), a startup shortcut or scheduled task (Windows) or a `systemd --user` unit (Linux). For the state in a status bar, use `/statusline` in tmux or zellij (see [Headless use](headless.md)).

The design and the options that were compared are in [the design specification](superpowers/specs/2026-10-12-tray-icon-design.md).
