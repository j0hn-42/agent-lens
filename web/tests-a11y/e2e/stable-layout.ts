import type { Page } from 'playwright'

// Plain JS string (tsx would inject a __name helper the page lacks). Resolves once the bounding
// boxes of all visible interactive elements and landmarks are unchanged over two consecutive
// animation frames AND have not changed for QUIET_MS, so late-rendering content (Conversation rows,
// panels animating in) is measured only after it exists. Rejects after the timeout.
const QUIET_MS = 750
const STABLE_SCRIPT = `new Promise((resolve, reject) => {
  const sel = 'button, a[href], input, select, textarea, [role], [tabindex], main, aside, section, nav'
  const snap = () => Array.from(document.querySelectorAll(sel)).map(el => {
    const r = el.getBoundingClientRect()
    return [el.tagName, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',')
  }).join('|')
  const start = performance.now()
  let prev = snap(), lastChange = start, same = 0
  const tick = () => {
    const now = performance.now()
    const cur = snap()
    if (cur === prev) same++; else { same = 0; lastChange = now; prev = cur }
    if (same >= 2 && now - lastChange >= ${QUIET_MS}) return resolve(true)
    if (now - start > 15000) return reject(new Error('layout did not settle within 15 s'))
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})`

export async function waitForStableLayout(page: Page) {
  await page.evaluate(STABLE_SCRIPT)
}
