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
import { launchStartupError } from '../../scripts/routes/launch'
import { watchParentStop } from './parent-stop'

const command = process.argv[2]
if (isCliCommand(command)) {
  // Headless commands (#236): clients of an already running relay, no server, no hooks setup
  void runCli(command, process.argv.slice(3), process, process.env).then(code => process.exit(code))
} else {
  const args = parseArgs(process.argv.slice(2))

  // Remote access (#241): fail closed before any setup or listening
  const remoteError = remoteStartupError({ allowHosts: args.allowHosts, host: args.host, remote: args.remote, tokenFile: args.tokenFile })
  if (remoteError) {
    console.error(`Agent Lens: ${remoteError}`)
    process.exit(2)
  }

  // Launching agents (#229): fail closed too
  const launchError = launchStartupError({ allowLaunch: args.allowLaunch, repos: args.launchRepos })
  if (launchError) {
    console.error(`Agent Lens: ${launchError}`)
    process.exit(2)
  }

  // Stop channel of the tray driver (#513): only with the internal --ipc-stop flag and an IPC channel opened by the
  // parent. Watched from here on, so a stop (or a dead parent) during the start is kept and runs once the server is up
  const parentStop = args.ipcStop ? watchParentStop(process, message => console.error(`Agent Lens: ${message}`)) : null
  if (parentStop && !parentStop.ok) {
    console.error(`Agent Lens: ${parentStop.error}`)
    process.exit(2)
  }

  console.log('Agent Lens\n')

  // Ensure hooks are configured
  ensureSetup()

  // Start the server. A failure (a --token-file that cannot be written, #517) stops the start like a refused flag:
  // exit code 2 and the reason on stderr (the token is never part of it)
  startServer({
    port: args.port,
    openBrowser: args.open,
    workspace: process.cwd(),
    verbose: args.verbose,
    allWorkspaces: args.allWorkspaces,
    imports: args.imports,
    webhooks: args.webhooks,
    ...(args.allowLaunch ? { launchRepos: args.launchRepos } : {}),
    // Remote access (#241, #517): remoteStartupError above guarantees a token file whenever a name is allowed
    ...(args.allowHosts.length > 0 && args.tokenFile ? { remote: { allowedHosts: args.allowHosts, tokenFile: args.tokenFile } } : {}),
  }).then(server => {
    // The same clean-up as SIGINT/SIGTERM/SIGHUP (idempotent): close, relay.dispose(), telemetry, exit 0
    if (parentStop?.ok) parentStop.onStop(server.close)
  }, (err: unknown) => {
    console.error(`Agent Lens: ${err instanceof Error ? err.message : 'the server could not start'}`)
    process.exit(2)
  })
}
