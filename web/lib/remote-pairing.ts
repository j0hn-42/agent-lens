/**
 * Web side of the remote pairing (#241, #517). The start prints https://<tunnel>/#pair=<token> (or
 * http://127.0.0.1:<port>/#pair=<token>): a fragment is never sent to a server nor written in an access log.
 * The page drops the fragment with history.replaceState FIRST, so the token stays neither in the address bar, nor in
 * the history, nor in a bookmark, whatever the answer; then it posts the token to POST /pair, which answers 204 with
 * an HttpOnly pairing cookie (never the token). The event stream and /status then carry that cookie (same origin).
 */

/** 256 bits of base64url, as the relay draws it (scripts/remote-pairing.ts). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const PREFIX = '#pair='

export type PairingResult = 'none' | 'paired' | 'failed'

/** What the function needs from the page: window.location, window.history and fetch (injectable for tests). */
export interface PairingPage {
  location: { hash: string; pathname: string; search: string }
  history: { state: unknown; replaceState: (data: unknown, unused: string, url?: string | URL | null) => void }
  fetch: (input: string, init?: RequestInit) => Promise<Pick<Response, 'status'>>
}

/**
 * 'none' without a #pair= fragment (nothing touched); 'paired' only on the relay's 204; 'failed' otherwise (malformed
 * token, refused token, network error). Never throws.
 */
export async function pairFromFragment(page: PairingPage): Promise<PairingResult> {
  const hash = page.location.hash
  if (!hash.startsWith(PREFIX)) return 'none'
  const token = hash.slice(PREFIX.length)
  // Before anything else, even for a malformed value: the fragment leaves the address bar and the history entry
  page.history.replaceState(page.history.state, '', `${page.location.pathname}${page.location.search}`)
  if (!TOKEN.test(token)) return 'failed'
  try {
    const reply = await page.fetch('/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    return reply.status === 204 ? 'paired' : 'failed'
  } catch {
    return 'failed'
  }
}
