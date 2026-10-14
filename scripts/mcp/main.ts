/**
 * Entry point of the "agent-lens" MCP server (#235), started by Claude Code from .mcp.json:
 *   pnpm --silent --dir <agent-lens> run mcp
 * stdout carries JSON-RPC only; diagnostics go to stderr. See docs/mcp-server.md.
 */
import { createMcpServer, createRelayGet, parseRelayUrl, runStdio } from './server'

const relay = parseRelayUrl(process.env.AGENT_LENS_RELAY_URL)
if (!relay.ok) {
  process.stderr.write(`agent-lens MCP: ${relay.error}\n`)
  process.exit(1)
}
void runStdio(createMcpServer(createRelayGet(relay.url)), process.stdin, process.stdout).then(() => process.exit(0))
