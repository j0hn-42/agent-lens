/**
 * Combined HTTP server: serves the visualizer UI and streams events via SSE.
 * Reuses the extension's hook server, transcript parser, and session watcher.
 */
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { exec, execFile } from 'child_process'

import { createRelay, type Relay } from '../../scripts/relay'
import { launchTokenNotice } from '../../scripts/routes/launch'
import { gateRemoteRequest } from '../../scripts/remote-access'
import { createTelemetryClient } from '../../scripts/telemetry'
import { parseSessionParam, isStatusPath, isStatusLinePath, isContextPath, isIssueLinksPath, isScopePath, isLaunchPath, observationsRoute } from '../../extension/src/relay-guards'
import { setConnectionsCheckingInterval } from '../../extension/src/hook-guards'
import { HTTP_CONNECTIONS_CHECK_INTERVAL_MS } from '../../extension/src/constants'
import { serveStatic } from './static'
import { guardRequest, listenLoopback, resolveListenPort } from '../../scripts/server-hardening'

interface ServerOptions {
  port: number
  openBrowser: boolean
  workspace: string
  verbose?: boolean
  /** Discover sessions from every workspace under ~/.claude/projects */
  allWorkspaces?: boolean
  /** --import paths (#294); empty falls back to AGENT_LENS_IMPORT */
  imports?: string[]
  /** --webhook URLs (#236); empty falls back to AGENT_LENS_WEBHOOKS */
  webhooks?: string[]
  /** --launch-repo (#229); present only with --allow-launch */
  launchRepos?: string[]
}

type AppRelay = Pick<Relay, 'allowedHosts' | 'handleSSE' | 'handleStatus' | 'handleStatusLine' | 'handleContext' | 'handleScope' | 'handleLaunch' | 'handleObservations' | 'handleIssueLinks'>

/**
 * Request handler of the standalone app. The tunnel Host names accepted besides loopback (#241) are read from the
 * relay (`relay.allowedHosts`, validated by createRelay): the gate and the relay's own guards share one list and
 * cannot disagree. They reach only the read-only surface (gateRemoteRequest). startServer creates the relay
 * without any until token authentication ships: --allow-host is refused at startup (remoteStartupError).
 */
export function createAppRequestHandler(relay: AppRelay): http.RequestListener {
  const allowedHosts = relay.allowedHosts
  return (req, res) => {
    const isApi = parseSessionParam(req.url).isEvents || isStatusPath(req.url) || isStatusLinePath(req.url) || isContextPath(req.url) || isIssueLinksPath(req.url) || isScopePath(req.url) || isLaunchPath(req.url) || observationsRoute(req.url) !== null
    // Loopback peer, Host loopback or allowed (static files included: DNS rebinding), read-only surface for a tunnel
    if (gateRemoteRequest(req, res, allowedHosts, isApi ? 'api' : 'static')) return
    // Strict headers (API: CSP default-src 'none'; static app: strict same-origin CSP),
    // GET/HEAD/OPTIONS only (405), session parameter validation (400)
    if (guardRequest(req, res, { kind: isApi ? 'api' : 'static' })) return

    // SSE endpoint
    // Match the path, not the raw URL, so /events?session=<id> reaches the relay
    if (parseSessionParam(req.url).isEvents) {
      return relay.handleSSE(req, res)
    }

    // Status snapshot for the empty-state checklist (loopback or allowed tunnel Host, rate-limited)
    if (isStatusPath(req.url)) {
      return relay.handleStatus(req, res)
    }

    // One-line status for a tmux / zellij bar (#236)
    if (isStatusLinePath(req.url)) {
      return relay.handleStatusLine(req, res)
    }

    // Project context (CLAUDE.md, memory) of a session, on demand (#64)
    if (isContextPath(req.url)) {
      return relay.handleContext(req, res)
    }

    // Run-time scope of the discovery (#291): the only POST route, guarded and strictly validated
    if (isScopePath(req.url)) {
      return relay.handleScope(req, res)
    }

    // Launch / stop an agent (#229): 404 unless --allow-launch; loopback, token, caps (never reached through a tunnel Host)
    if (isLaunchPath(req.url)) {
      return relay.handleLaunch(req, res)
    }

    // Typed "observations" action for Claude (whitelisted projection, loopback only, rate-limited)
    if (observationsRoute(req.url)) {
      return relay.handleObservations(req, res)
    }

    // Issue/PR links of an agent role, read through gh (loopback only, rate-limited, cached)
    if (isIssueLinksPath(req.url)) {
      return relay.handleIssueLinks(req, res)
    }

    // Static files (UI): GET/HEAD (other methods were answered 405 above)
    return serveStatic(req, res)
  }
}

export async function startServer(options: ServerOptions): Promise<{ port: number; close: () => void }> {
  const { port, openBrowser, workspace } = options

  const configDir = path.join(os.homedir(), '.agent-lens')
  const telemetry = createTelemetryClient({
    logDir: path.join(configDir, 'telemetry'),
    installIdPath: path.join(configDir, 'installation-id'),
  })
  await telemetry.init()

  const relay = await createRelay({ workspace, verbose: options.verbose, telemetry, allWorkspaces: options.allWorkspaces, ...(options.imports?.length ? { imports: options.imports } : {}), ...(options.webhooks?.length ? { webhooks: { destinations: options.webhooks } } : {}),
    ...(options.launchRepos ? { launch: { repos: options.launchRepos, onToken: token => console.log(`${launchTokenNotice(token, options.launchRepos ?? [])}\n`) } } : {}),
  })

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, createAppRequestHandler(relay))

  server.maxConnections = 256
  server.headersTimeout = 10_000
  setConnectionsCheckingInterval(server, HTTP_CONNECTIONS_CHECK_INTERVAL_MS)
  // `--port 0` or AGENT_LENS_PORT=0 asks the OS for an ephemeral port; the chosen one is printed
  const boundPort = await listenLoopback(server, resolveListenPort(port))
  const url = `http://127.0.0.1:${boundPort}`
  console.log(`Server running at ${url}`)
  console.log('Waiting for agent events...\n')
  if (openBrowser) {
    openURL(url)
  }

  // Cleanup on exit. Idempotent — repeat signals (Ctrl+C spam, SIGTERM+SIGHUP,
  // etc.) would otherwise emit duplicate session_end events and race the
  // telemetry sync loop against itself.
  let shuttingDown = false
  function cleanup() {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    relay.dispose()
    void telemetry.dispose().finally(() => process.exit(0))
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  // SIGHUP fires when the controlling terminal closes (SSH session drops, tmux
  // pane killed). Without a handler, Node's default behavior is to terminate
  // without running cleanup — so session_end never flushes.
  process.on('SIGHUP', cleanup)
  return { port: boundPort, close: cleanup }
}

function openURL(url: string) {
  if (process.platform === 'win32') {
    // 'start' is a shell builtin on Windows — must use exec, not execFile
    exec(`start "" "${url}"`)
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}
