import { DEFAULT_RELAY_PORT } from '../../extension/src/constants'

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = DEFAULT_RELAY_PORT
  let open = true
  let verbose = false
  let allWorkspaces = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      if (!isNaN(n) && n > 0 && n < 65536) port = n
      i++
    } else if (arg === '--no-open') {
      open = false
    } else if (arg === '--all-workspaces') {
      allWorkspaces = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: agent-lens [options]

Options:
  -p, --port <number>  Port for the server (default: ${DEFAULT_RELAY_PORT})
  --no-open            Don't open the browser automatically
  --all-workspaces     Also discover Claude sessions from other workspaces
                       (env: AGENT_FLOW_ALL_WORKSPACES=1)
  -v, --verbose        Show detailed event logs
  -h, --help           Show this help message
`)
      process.exit(0)
    }
  }

  return { port, open, verbose, allWorkspaces }
}
