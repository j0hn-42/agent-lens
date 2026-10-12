import { DEFAULT_RELAY_PORT } from '../../extension/src/constants'

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = DEFAULT_RELAY_PORT
  let open = true
  let verbose = false
  let allWorkspaces = false
  const imports: string[] = []
  const webhooks: string[] = []
  const allowHosts: string[] = []
  let host: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      // 0 = ephemeral port chosen by the OS (printed at startup)
      if (!isNaN(n) && n >= 0 && n < 65536) port = n
      i++
    } else if (arg === '--no-open') {
      open = false
    } else if (arg === '--import' && argv[i + 1]) {
      imports.push(argv[i + 1])
      i++
    } else if (arg === '--webhook' && argv[i + 1]) {
      webhooks.push(argv[i + 1])
      i++
    } else if (arg === '--allow-host' && argv[i + 1]) {
      allowHosts.push(argv[i + 1])
      i++
    } else if (arg === '--host' && argv[i + 1]) {
      // Kept so that the start refuses it (#241): an unknown flag would be silently ignored
      host = argv[i + 1]
      i++
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
  --allow-host <name>  Accept requests whose Host is exactly <name> (a tunnel such as
                       SSH -L or Tailscale serve; the server stays on 127.0.0.1).
                       Read-only surface only. Refused at startup until token
                       authentication ships (#241). See docs/relay-sources.md
  --host <address>     Only loopback (127.0.0.1) is accepted: there is no listening
                       outside loopback, use a tunnel and --allow-host
  -v, --verbose        Show detailed event logs
  -h, --help           Show this help message
`)
      process.exit(0)
    }
  }

  return { port, open, verbose, allWorkspaces, imports, webhooks, allowHosts, host }
}
