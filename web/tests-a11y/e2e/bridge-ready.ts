// Feeds the app embedded in `#app` like a VS Code webview, only once it listens (#567 flake, Refs #575).
//
// The Sessions button is in the server HTML: it is there before React hydrates, so seeing it proves nothing about the
// bridge. The bridge hook subscribes to events in a React effect; a message posted before that effect ran is dropped
// (proven under load: the reload scenario of truncation-dismiss.e2e.ts then never shows its indicator). Like the
// extension, which waits for the page's answer, the parent repeats `__vscode-bridge-init` until the page answers with
// its public `permission-surface` message. That answer is posted by an effect of PermissionRequests, a child of the
// component whose effect subscribes the bridge, in a commit that follows the one where the init reached React: by
// then the event and session listeners are attached. No React internal is read.
import type { Page } from 'playwright'

/** Posts `messages` to the frame `#app` of `page` after the app answered the init; rejects after `timeoutMs`. */
export async function postWhenListening(page: Page, messages: unknown[], timeoutMs = 60_000): Promise<void> {
  // A string (not a function) so the TS transpiler's helpers are not injected into the page
  await page.evaluate(`new Promise((resolve, reject) => {
    const msgs = ${JSON.stringify(messages)}
    const win = document.getElementById('app').contentWindow
    const init = () => win.postMessage({ type: '__vscode-bridge-init' }, '*')
    const retry = setInterval(init, 100)
    const onMsg = (e) => {
      if (e.source !== win || !e.data || e.data.type !== 'permission-surface' || e.data.ready !== true) return
      window.removeEventListener('message', onMsg)
      clearInterval(retry)
      clearTimeout(giveUp)
      for (const m of msgs) win.postMessage(m, '*')
      resolve(true)
    }
    const giveUp = setTimeout(() => {
      window.removeEventListener('message', onMsg)
      clearInterval(retry)
      reject(new Error('the app never answered __vscode-bridge-init with permission-surface'))
    }, ${Number(timeoutMs)})
    window.addEventListener('message', onMsg)
    init()
  })`)
}
