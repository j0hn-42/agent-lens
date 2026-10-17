import { DEFAULT_RELAY_PORT } from '../../extension/src/constants'

/** Value of an option, or undefined when it is missing or is the next flag: a flag is never swallowed (#474). */
function optionValue(next: string | undefined): string | undefined {
  return next === undefined || next.startsWith('-') ? undefined : next
}

/** --host=<v>, --allow-host=<v>, --remote=<v>, --token-file=<v>: read, never ignored as an unknown argument (#474, #517). */
const SECURITY_FLAG_WITH_EQUALS = /^(--host|--allow-host|--remote|--token-file)=(.*)$/s

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = DEFAULT_RELAY_PORT
  let open = true
  let verbose = false
  let allWorkspaces = false
  const imports: string[] = []
  const webhooks: string[] = []
  const allowHosts: string[] = []
  let allowLaunch = false
  const launchRepos: string[] = []
  let host: string | undefined
  let remote = false
  let tokenFile: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const withEquals = SECURITY_FLAG_WITH_EQUALS.exec(arg)
    if (withEquals) {
      const [, flag, value] = withEquals
      if (flag === '--host') host = value
      else if (flag === '--allow-host') allowHosts.push(value)
      else if (flag === '--token-file') tokenFile = value
      // Whatever its value, --remote=<v> is an explicit request: fail closed, the start decides
      else remote = true
    } else if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      // 0 = ephemeral port chosen by the OS (printed at startup)
      if (!isNaN(n) && n >= 0 && n < 65536) port = n
      i++
    } else if (arg === '--no-open') {
      open = false
    } else if (arg === '--import') {
      const value = optionValue(argv[i + 1])
      if (value !== undefined) { imports.push(value); i++ }
    } else if (arg === '--webhook') {
      const value = optionValue(argv[i + 1])
      if (value !== undefined) { webhooks.push(value); i++ }
    } else if (arg === '--allow-host') {
      // Without value, '' is kept so that the start refuses it (#241): a security flag is never ignored
      const value = optionValue(argv[i + 1])
      allowHosts.push(value ?? '')
      if (value !== undefined) i++
    } else if (arg === '--token-file') {
      // Without value, '' is kept so that the start refuses it (#517)
      const value = optionValue(argv[i + 1])
      tokenFile = value ?? ''
      if (value !== undefined) i++
    } else if (arg === '--remote') {
      // The only way to ask for listening outside loopback (#474): never an environment variable
      remote = true
    } else if (arg === '--allow-launch') {
      allowLaunch = true
    } else if (arg === '--launch-repo') {
      const value = optionValue(argv[i + 1])
      if (value !== undefined) { launchRepos.push(value); i++ }
    } else if (arg === '--host') {
      // Kept so that the start refuses it (#241): an unknown flag would be silently ignored
      const value = optionValue(argv[i + 1])
      host = value ?? ''
      if (value !== undefined) i++
    } else if (arg === '--all-workspaces') {
      allWorkspaces = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: agent-lens [options]
       agent-lens ps | tail | statusline [--port <n>]   (headless, see docs/headless.md)

Options:
  -p, --port <number>  Port for the server (default: ${DEFAULT_RELAY_PORT}; 0 = ephemeral,
                       env: AGENT_LENS_PORT=0)
  --no-open            Don't open the browser automatically
  --all-workspaces     Start by discovering Claude sessions from every workspace
                       (env: AGENT_LENS_ALL_WORKSPACES=1); the scope selector
                       in the UI changes it later without a restart
  --import <path>      Read a session transcript fetched from a cloud agent: a
                       <session id>.jsonl file or a folder of them. Read once,
                       listed as imported, never live. Repeatable
                       (env: AGENT_LENS_IMPORT, paths separated by '${process.platform === 'win32' ? ';' : ':'}')
  --webhook <url>      Notify this URL when a live agent completes, asks for a permission
                       or fails (https, or http to loopback). Repeatable, 4 at most
                       (env: AGENT_LENS_WEBHOOKS, URLs separated by commas; prefer the
                       variable, a flag is visible in the process list). See docs/headless.md
  --allow-host <name>  Accept requests whose Host is exactly <name> (a named tunnel such
                       as Tailscale serve; the server stays on 127.0.0.1). Read-only
                       surface only, after pairing with the token printed at startup.
                       Needs --token-file. While it is on, every page needs the pairing,
                       on a loopback Host too (an SSH -L tunnel looks local; #517).
                       See docs/remote-access.md
  --token-file <path>  With --allow-host: the pairing token of this start is written there
                       (owner only on Linux and macOS; on Windows the file inherits its
                       folder's access rights). Replaced at every start. See docs/remote-access.md
  --allow-launch       Let the UI start a headless agent on an issue (#229). OFF by default.
                       Needs --launch-repo; a token is printed once at startup and must be
                       sent as "Authorization: Bearer". Loopback only, never through a tunnel.
                       See docs/launch-security.md
  --launch-repo <o/n>  Repository (owner/name) an agent may be launched on. Repeatable. It
                       must also be the workspace's origin remote
  --host <address>     Only loopback (127.0.0.1) is accepted (not ::1). Any other address
                       needs --remote, and is refused even then until TLS ships
                       (#241): use a tunnel and --allow-host
  --remote             Explicit opt-in for --host outside loopback (no environment
                       variable, no default address: never 0.0.0.0 implicitly).
                       Refused at startup for now (#241)
  -v, --verbose        Show detailed event logs
  -h, --help           Show this help message
`)
      process.exit(0)
    }
  }

  return { port, open, verbose, allWorkspaces, imports, webhooks, allowHosts, tokenFile, host, remote, allowLaunch, launchRepos }
}
