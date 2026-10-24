/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { themeBootstrapScript } from '../../extension/src/theme-bootstrap'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

export const HTML_SHELL = `<!DOCTYPE html>
<html lang="en" class="dark" data-theme="catppuccin-macchiato">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Lens</title>
  <link rel="stylesheet" href="/index.css">
  <style>html, body { height: 100%; margin: 0; padding: 0; }</style>
</head>
<body class="font-sans antialiased" style="background: #0a0a1a;">
  <script src="/theme.js"></script>
  <div id="root" style="height: 100%;"></div>
  <script src="/index.js"></script>
</body>
</html>`

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
}

/**
 * Webview assets kept in memory (#654): a request costs one stat, the disk is read again only when the file
 * changed (rebuild). The ETag lets the browser revalidate (304) instead of downloading the bundle again.
 */
interface CachedAsset { mtimeMs: number; size: number; content: Buffer; etag: string }
const assetCache = new Map<string, CachedAsset>()

function loadAsset(filePath: string): CachedAsset {
  const st = fs.statSync(filePath)
  const hit = assetCache.get(filePath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
  const content = fs.readFileSync(filePath)
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  const asset = { mtimeMs: st.mtimeMs, size: st.size, content, etag }
  assetCache.set(filePath, asset)
  return asset
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, webviewDir = WEBVIEW_DIR) {
  const url = (req.url || '/').split('?')[0]

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML_SHELL)
    return
  }

  // Same-origin so CSP_STATIC_APP (script-src 'self', no inline) lets the theme bootstrap run before first paint
  if (url === '/theme.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    res.end(themeBootstrapScript())
    return
  }

  // Only serve known asset files from the webview directory
  const basename = path.basename(url)
  const ext = path.extname(basename)
  const mime = MIME_TYPES[ext]

  if (!mime) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const filePath = path.join(webviewDir, basename)

  // Prevent path traversal
  if (!filePath.startsWith(webviewDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const asset = loadAsset(filePath)
    // no-cache: the browser keeps a copy but asks again each time (ETag), so a rebuilt bundle is never stale
    const headers = { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'ETag': asset.etag }
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    res.writeHead(200, headers)
    res.end(asset.content)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}
