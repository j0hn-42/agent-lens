/**
 * What the start prints once remote access is on (#241, #517): the pairing URLs. The token travels only in the URL
 * fragment (#pair=<token>), which a browser never sends to a server nor writes in an access log.
 * The token is printed only when the standard output is a terminal: a pipe or a service manager may keep the output
 * in a log, so there the URLs point to --token-file instead.
 */
import { pairingUrl } from '../../scripts/remote-pairing'

export interface PairingBannerOptions {
  /** Validated tunnel names (--allow-host) */
  allowedHosts: readonly string[]
  /** Port the server listens on (127.0.0.1) */
  port: number
  token: string
  tokenFile: string
  /** process.stdout.isTTY */
  isTTY: boolean
}

export function pairingBanner(o: PairingBannerOptions): string {
  const fragment = o.isTTY ? o.token : '<the token in the file above>'
  const lines = [
    `Remote access (#241): the pairing token of this start is written to ${o.tokenFile}`,
    ...(o.isTTY ? [] : ['  The standard output is not a terminal: the token is not printed here.']),
    ...o.allowedHosts.map(host => `  Pair through the tunnel:  ${pairingUrl(host, fragment)}`),
    `  Pair on this machine (or through an SSH -L tunnel to port ${o.port}):  http://127.0.0.1:${o.port}/#pair=${fragment}`,
    '  The token is only after \'#\': the browser never sends that part, and the page removes it before pairing.',
    '  Every page needs a pairing while --allow-host is on, on this machine too. Restart Agent Lens to revoke every pairing.',
    '  The browser is not opened automatically: open one of the URLs above.',
  ]
  return lines.join('\n')
}
