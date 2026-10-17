#!/usr/bin/env node
/**
 * Dev relay server — wraps the shared relay with a standalone HTTP server
 * that includes CORS headers for cross-origin dev mode (Next.js on :3000).
 */
import * as http from 'http'
import { createRelay } from './relay'
import { DEFAULT_RELAY_PORT, HTTP_CONNECTIONS_CHECK_INTERVAL_MS } from '../extension/src/constants'
import { isDevWebOrigin, parseSessionParam, isStatusPath, isStatusLinePath, isContextPath, isIssueLinksPath, isScopePath, isQuotaPath, isLaunchPath, observationsRoute } from '../extension/src/relay-guards'
import { setConnectionsCheckingInterval } from '../extension/src/hook-guards'
import { guardRequest, listenLoopback, resolveListenPort } from './server-hardening'
import { launchStartupError, launchTokenNotice } from './routes/launch'

async function main() {
  // dev-relay [workspace] [--import <path>]... (imported transcripts, #294; env: AGENT_LENS_IMPORT)
  const args = process.argv.slice(2)
  const imports: string[] = []
  let allowLaunch = false
  const launchRepos: string[] = []
  let workspaceArg: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--import') { if (args[i + 1]) imports.push(args[i + 1]); i++ }
    else if (args[i] === '--allow-launch') allowLaunch = true
    else if (args[i] === '--launch-repo') { if (args[i + 1]) launchRepos.push(args[i + 1]); i++ }
    else if (!workspaceArg) workspaceArg = args[i]
  }
  // Launching an agent from the UI (#229) is OFF unless asked for, and then needs an explicit repository list (fail closed)
  const launchError = launchStartupError({ allowLaunch, repos: launchRepos })
  if (launchError) { console.error(`Agent Lens: ${launchError}`); process.exit(2) }
  const workspace = workspaceArg || process.cwd()

  console.log('Starting Agent Lens dev relay...\n')
  console.log(`Workspace: ${workspace}`)

  const relay = await createRelay({
    workspace, verbose: true, ...(imports.length > 0 ? { imports } : {}),
    ...(allowLaunch ? { launch: { repos: launchRepos, onToken: token => console.log(`\n${launchTokenNotice(token, launchRepos)}\n`) } } : {}),
  })

  const server = http.createServer((req, res) => {
    // Echo back the request Origin only for the dev web server's port (3000, or AGENT_LENS_WEB_PORT
    // when Next.js falls back to another one). Other local ports get no CORS header (#201).
    const origin = req.headers.origin
    if (typeof origin === 'string' && isDevWebOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    // Security headers, GET/HEAD/OPTIONS only (405), session parameter validation (400)
    if (guardRequest(req, res, { kind: 'api' })) return

    // Match the path, not the raw URL, so /events?session=<id> reaches the relay
    if (parseSessionParam(req.url).isEvents) {
      return relay.handleSSE(req, res)
    }

    if (isStatusPath(req.url)) {
      return relay.handleStatus(req, res)
    }

    if (isStatusLinePath(req.url)) {
      return relay.handleStatusLine(req, res)
    }

    if (isContextPath(req.url)) {
      return relay.handleContext(req, res)
    }

    // Run-time scope (#291): the only POST; JSON body, same-site only, rate-limited
    if (isScopePath(req.url)) {
      return relay.handleScope(req, res)
    }

    // Subscription quota posted by the status line script (#467): same guards as /scope
    if (isQuotaPath(req.url)) {
      return relay.handleQuota(req, res)
    }

    // Launch / stop an agent (#229): 404 unless --allow-launch; loopback, token, caps
    if (isLaunchPath(req.url)) {
      return relay.handleLaunch(req, res)
    }

    if (observationsRoute(req.url)) {
      return relay.handleObservations(req, res)
    }

    // Issue/PR links of an agent role, read through gh (loopback only, rate-limited, cached)
    if (isIssueLinksPath(req.url)) {
      return relay.handleIssueLinks(req, res)
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Agent Lens Dev Relay')
  })

  setConnectionsCheckingInterval(server, HTTP_CONNECTIONS_CHECK_INTERVAL_MS)
  // Default port unless AGENT_LENS_PORT=0 asks for an ephemeral one (the chosen port is printed)
  const port = await listenLoopback(server, resolveListenPort(DEFAULT_RELAY_PORT))
  console.log(`\nSSE relay on http://127.0.0.1:${port}/events`)
  console.log('Ready! Events will appear in the web app.')

  // Idempotent: repeated signals (Ctrl+C spam, SIGTERM then SIGHUP) must not dispose twice
  let shuttingDown = false
  function cleanup() {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    relay.dispose()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  // The terminal closing (tab, SSH, tmux pane) sends SIGHUP: without a handler Node dies before relay.dispose(), and a
  // launched agent (detached, no controlling terminal) would keep running with no wall-clock cap (#229)
  process.on('SIGHUP', cleanup)
}

main().catch(e => {
  console.error('Failed to start dev relay:', e)
  process.exit(1)
})
