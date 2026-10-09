import { WEBVIEW_BG_COLOR } from './constants'
import { themeBootstrapScript } from './theme-bootstrap'

export interface ProductionHtmlParams {
  cspSource: string
  scriptUri: string
  styleUri: string
  nonce: string
}

/** HTML shell of the production webview. The theme script runs first (same nonce) so the first paint has the final theme. */
export function productionHtml({ cspSource, scriptUri, styleUri, nonce }: ProductionHtmlParams): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark" data-theme="graphite" style="height:100%; margin:0; padding:0;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${cspSource} 'unsafe-inline';
      img-src ${cspSource} https: data:;
      font-src ${cspSource} data:;
      script-src 'nonce-${nonce}';"
  />
  <link rel="stylesheet" href="${styleUri}">
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: ${WEBVIEW_BG_COLOR}; }
    #root { height: 100%; }
  </style>
</head>
<body>
  <script nonce="${nonce}">${themeBootstrapScript()}</script>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
