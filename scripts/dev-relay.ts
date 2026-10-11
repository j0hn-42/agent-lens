#!/usr/bin/env node
/**
 * Dev relay server — wraps the shared relay with a standalone HTTP server
 * that includes CORS headers for cross-origin dev mode (Next.js on :3000).
 */
import * as http from 'http'
import { createRelay } from './relay'
import { DEFAULT_RELAY_PORT, HTTP_CONNECTIONS_CHECK_INTERVAL_MS } from '../extension/src/constants'
import { isDevWebOrigin, parseSessionParam, isStatusPath, isContextPath, isIssueLinksPath, isScopePath, observationsRoute } from '../extension/src/relay-guards'
import { setConnectionsCheckingInterval } from '../extension/src/hook-guards'
import { guardRequest, listenLoopback, resolveListenPort } from './server-hardening'

async function main() {
  // dev-relay [workspace] [--import <path>]... (imported transcripts, #294; env: AGENT_LENS_IMPORT)
  const args = process.argv.slice(2)
  const imports: string[] = []
  let workspaceArg: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--import') { if (args[i + 1]) imports.push(args[i + 1]); i++ }
    else if (!workspaceArg) workspaceArg = args[i]
  }
  const workspace = workspaceArg || process.cwd()

  console.log('Starting Agent Lens dev relay...\n')
  console.log(`Workspace: ${workspace}`)

  const relay = await createRelay({ workspace, verbose: true, ...(imports.length > 0 ? { imports } : {}) })

  const server = http.createServer((req, res) => {
    // Echo back the request Origin only for the dev web server's port (3000, or AGENT_LENS_WEB_PORT
    // when Next.js falls back to another one). Other local ports get no CORS header (#201).
    const origin = req.headers.origin
    if (typeof origin === 'string' && isDevWebOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    // Security headers, GET/HEAD/OPTIONS only (405), session parameter validation (400)
    if (guardRequest(req, res, { kind: 'api' })) return

    // Match the path, not the raw URL, so /events?session=<id> reaches the relay
    if (parseSessionParam(req.url).isEvents) {
      return relay.handleSSE(req, res)
    }

    if (isStatusPath(req.url)) {
      return relay.handleStatus(req, res)
    }

    if (isContextPath(req.url)) {
      return relay.handleContext(req, res)
    }

    // Run-time scope (#291): the only POST; JSON body, same-site only, rate-limited
    if (isScopePath(req.url)) {
      return relay.handleScope(req, res)
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

  function cleanup() {
    server.close()
    relay.dispose()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

main().catch(e => {
  console.error('Failed to start dev relay:', e)
  process.exit(1)
})
