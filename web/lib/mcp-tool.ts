/** An MCP tool call, split from the `mcp__<server>__<tool>` name Claude uses. */
export interface McpToolInfo {
  server: string
  tool: string
}

const MCP_PREFIX = 'mcp__'

/**
 * Parse an MCP tool name (`mcp__<server>__<tool>`). Returns null for native tools.
 * Server names may contain single underscores, so we split on the LAST `__`
 * (the tool name is the final segment).
 */
export function parseMcpTool(name: string | undefined | null): McpToolInfo | null {
  if (!name || !name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.lastIndexOf('__')
  if (sep <= 0 || sep + 2 >= rest.length) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/** Human label: "server › tool" for MCP tools, the raw name otherwise. */
export function formatToolName(name: string | undefined | null): string {
  const mcp = parseMcpTool(name)
  return mcp ? `${mcp.server} › ${mcp.tool}` : (name ?? '')
}
