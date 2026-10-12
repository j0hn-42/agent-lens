/**
 * Agent Lens — standalone web app for visualizing AI agent orchestration.
 *
 * Starts a local server that:
 *   1. Receives events from agent hooks
 *   2. Watches JSONL transcript files for active sessions
 *   3. Serves the visualizer UI and streams events via SSE
 *   4. Opens the browser automatically
 *
 * Usage: node app/dist/app.js [--port <number>] [--no-open]
 */
import { parseArgs } from './args'
import { isCliCommand, runCli } from '../../scripts/headless-cli'
import { ensureSetup } from '../../scripts/setup'
import { startServer } from './server'
import { remoteStartupError } from '../../scripts/remote-access'

const command = process.argv[2]
if (isCliCommand(command)) {
  // Headless commands (#236): clients of an already running relay, no server, no hooks setup
  void runCli(command, process.argv.slice(3), process, process.env).then(code => process.exit(code))
} else {
  const args = parseArgs(process.argv.slice(2))

  // Remote access (#241): fail closed before any setup or listening
  const remoteError = remoteStartupError({ allowHosts: args.allowHosts, host: args.host })
  if (remoteError) {
    console.error(`Agent Lens: ${remoteError}`)
    process.exit(2)
  }

  console.log('Agent Lens\n')

  // Ensure hooks are configured
  ensureSetup()

  // Start the server
  startServer({
    port: args.port,
    openBrowser: args.open,
    workspace: process.cwd(),
    verbose: args.verbose,
    allWorkspaces: args.allWorkspaces,
    imports: args.imports,
    webhooks: args.webhooks,
  })
}
