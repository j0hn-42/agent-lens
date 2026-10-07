/**
 * Combined HTTP server: serves the visualizer UI and streams events via SSE.
 * Reuses the extension's hook server, transcript parser, and session watcher.
 */
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { exec, execFile } from 'child_process'

import { createRelay } from '../../scripts/relay'
import { createTelemetryClient } from '../../scripts/telemetry'
import { parseSessionParam, isStatusPath, isContextPath } from '../../extension/src/relay-guards'
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
}

export async function startServer(options: ServerOptions): Promise<{ port: number; close: () => void }> {
  const { port, openBrowser, workspace } = options

  const configDir = path.join(os.homedir(), '.agent-lens')
  const telemetry = createTelemetryClient({
    logDir: path.join(configDir, 'telemetry'),
    installIdPath: path.join(configDir, 'installation-id'),
  })
  await telemetry.init()

  const relay = await createRelay({ workspace, verbose: options.verbose, telemetry, allWorkspaces: options.allWorkspaces })

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    // Strict headers (API: CSP default-src 'none'; static app: strict same-origin CSP),
    // GET/HEAD/OPTIONS only (405), session parameter validation (400)
    const isApi = parseSessionParam(req.url).isEvents || isStatusPath(req.url) || isContextPath(req.url)
    if (guardRequest(req, res, { kind: isApi ? 'api' : 'static' })) return

    // SSE endpoint
    // Match the path, not the raw URL, so /events?session=<id> reaches the relay
    if (parseSessionParam(req.url).isEvents) {
      return relay.handleSSE(req, res)
    }

    // Status snapshot for the empty-state checklist (loopback only, rate-limited)
    if (isStatusPath(req.url)) {
      return relay.handleStatus(req, res)
    }

    // Project context (CLAUDE.md, memory) of a session, on demand (#64)
    if (isContextPath(req.url)) {
      return relay.handleContext(req, res)
    }

    // Static files (UI): GET/HEAD (other methods were answered 405 above)
    return serveStatic(req, res)
  })

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
