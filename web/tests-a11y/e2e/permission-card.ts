// Shared by the e2e files that need a REAL permission card: the demo app in an iframe of a same-origin host page that
// plays the VS Code extension (it posts `__vscode-bridge-init`, then a `permission-request`), plus the Tab / focus
// probes used to prove that a focused control is drawn, has an indicator and is not covered. No production code.
import { strict as assert } from 'node:assert'
import type { Browser, Frame, Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import type { DemoServer } from './demo-server'

const HOST_PATH = '/__e2e-extension-host'
export const NONCE = '0123456789abcdef0123456789abcdef'
const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100vw;height:100vh;display:block}</style></head>
<body><iframe id="app" title="app" src="/"></iframe></body></html>`

export interface Opened { page: Page; app: Frame }

/**
 * The demo inside a frame, told by its parent that it runs in VS Code, with one permission request waiting.
 * `tourOffered`: the first-run tour offer (#377) is marked as already made, as on any launch after the first, so a test
 * measures its own subject and not that card (which is drawn from 600 px wide, tour-offer.tsx).
 */
export async function openWithCard(browser: Browser, server: DemoServer, w: number, h: number, mobile = true, opts: { tourOffered?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile })
  if (opts.tourOffered) await context.addInitScript(`try { localStorage.setItem('agent-lens:tour-offered', '1') } catch {}`)
  const page = await context.newPage()
  await page.route(`${server.url}${HOST_PATH}`, route => route.fulfill({ contentType: 'text/html', body: HOST_HTML }))
  await page.goto(`${server.url}${HOST_PATH}`)
  const handle = await page.locator('#app').elementHandle()
  const app = (await handle!.contentFrame())!
  await app.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  // Same conversation as the extension, from the parent window (the bridge checks e.source === window.parent):
  // init, then the request once the page declared its decision surface (the extension holds requests until then).
  // The bridge listens only once React has hydrated and an init sent before that is lost: like the extension, which
  // waits for the page's answer, init is repeated until the page answers with its public `permission-surface`
  // message (no React internal involved). Same handshake as postWhenListening (bridge-ready.ts), kept apart on purpose
  // (#613): with that helper, popup-permission.e2e.ts failed 3 then 6 times out of 14 against 14/14 with this loop
  // (measured twice in #624), and the cause was not found. Do not merge the two without finding it.
  await page.evaluate(`new Promise((resolve, reject) => {
    const win = document.getElementById('app').contentWindow
    const retry = setInterval(() => win.postMessage({ type: '__vscode-bridge-init' }, '*'), 100)
    const giveUp = setTimeout(() => { clearInterval(retry); reject(new Error('the page never declared its permission surface')) }, 20000)
    window.addEventListener('message', function onMsg(e) {
      if (e.source !== win || !e.data || e.data.type !== 'permission-surface' || e.data.ready !== true) return
      window.removeEventListener('message', onMsg)
      clearInterval(retry)
      clearTimeout(giveUp)
      win.postMessage({ type: 'permission-request', request: {
        sessionId: 'sess-e2e', toolUseId: 'toolu_e2e', nonce: ${JSON.stringify(NONCE)}, toolName: 'Bash',
        inputPreview: '{"command":"npm test"}', inputTruncated: false, inputSha256: ${JSON.stringify('c'.repeat(64))},
        requestedAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 } }, '*')
      resolve(true)
    })
  })`)
  await app.locator('[data-permission-requests] [data-nonce]').waitFor()
  await waitForStableLayout(app)
  return { page, app }
}

export const noHorizontalScroll = (app: Frame) => app.evaluate('document.documentElement.scrollWidth <= window.innerWidth') as Promise<boolean>

/** Reflow (1.4.10): scrollWidth alone misses a box overflowing a clipped ancestor, so the boxes are measured too. */
export async function outsideWindow(app: Frame): Promise<string[]> {
  return app.evaluate(`(() => {
    const out = []
    const w = window.innerWidth
    const els = [...document.querySelectorAll('[data-permission-requests], [data-permission-requests] [data-nonce], [data-permission-requests] button')]
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.left < -0.5 || r.right > w + 0.5) out.push((el.getAttribute('aria-label') || el.tagName).slice(0, 40) + ' spans ' + r.left.toFixed(1) + '..' + r.right.toFixed(1) + ' of ' + w)
    }
    return out
  })()`) as Promise<string[]>
}

export interface Box { l: number; t: number; r: number; b: number }
export interface Ring { color: string; alpha: number; contrast: number; sig: string; box: Box; clip: (Box & { by: string }) | null }
export interface Probe { id: string; name: string; inCards: boolean; inDrawer: boolean; visible: boolean; inViewport: boolean; hiddenBy: string | null; entirelyHidden: boolean; indicator: boolean; stop: number; ring: Ring | null; unfocusedSig?: string }

/**
 * The focused element, and whether it can be seen: its box lies in the window and the topmost element at its centre
 * and at its four corners (1 px in) is itself or a descendant, i.e. nothing is drawn over it (hiddenBy: some point is
 * covered, 2.4.12 and the project rule; entirelyHidden: all five are, 2.4.11). `indicator`: a computed focus
 * indicator exists, an outline with a style and a width, or a box-shadow (2.4.7). `ring` describes it: its colour
 * (alpha composited over the opaque background found behind the element) and the contrast of that colour against the
 * background, a signature of the whole indicator (compared with the unfocused state afterwards, `unfocusedSig`), and
 * the box the ring paints (border box grown by outline offset and width), to be compared with clipping ancestors.
 * The element is tagged `data-e2e-stop` so that the same element can be measured again once it lost the focus.
 */
export const SIG = `(el) => { const cs = getComputedStyle(el); return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.outlineOffset, cs.boxShadow].join('|') }`
export const PROBE = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const sig = ${SIG}
  window.__e2eStops = (window.__e2eStops || 0) + 1
  if (!el.hasAttribute('data-e2e-stop')) el.setAttribute('data-e2e-stop', String(window.__e2eStops)); const stopId = Number(el.getAttribute('data-e2e-stop'))
  const r = el.getBoundingClientRect()
  const inViewport = r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5
  const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]]
  let hiddenBy = null
  let covered = 0
  for (const [x, y] of pts) {
    const top = document.elementFromPoint(x, y)
    if (!top || !(top === el || el.contains(top) || top.contains(el))) {
      covered++
      if (hiddenBy === null) hiddenBy = top ? top.tagName + (top.id ? '#' + top.id : '') + '.' + String(top.className).slice(0, 40) : 'nothing'
    }
  }
  const cs = getComputedStyle(el)
  const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
  const hasShadow = cs.boxShadow !== 'none' && cs.boxShadow !== ''
  const indicator = hasOutline || hasShadow
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const rgba = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 } }
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 })
  const lum = (c) => { const ch = [c.r, c.g, c.b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] }
  // background behind the ring: the layers of the ancestors, composited until one is opaque (white if none is)
  const layers = []
  for (let a = el.parentElement; a; a = a.parentElement) { const c = rgba(getComputedStyle(a).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 1) break } }
  let bg = { r: 255, g: 255, b: 255, a: 1 }
  if (layers.length && layers[layers.length - 1].a < 1) layers.push(bg)
  bg = layers.length ? layers.reduceRight((acc, l) => over(l, acc)) : bg
  let ring = null
  if (indicator) {
    const css = hasOutline ? cs.outlineColor : ((cs.boxShadow.match(/(rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]+)/i) || [])[0] || 'transparent')
    const c = rgba(css)
    const shown = over(c, bg)
    const l1 = lum(shown), l2 = lum(bg)
    const grow = hasOutline ? parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth) : 0
    // the drawer is the scroll container a card creates (overflow-y: auto, so overflow-x too): what a ring paints outside
    // its padding box is cut. Other clipping ancestors (the session list has its own) are not this test's subject.
    let clip = null
    const dr = el.closest('[data-mobile-drawer]')
    if (dr && dr !== el) {
      const o = getComputedStyle(dr)
      if (o.overflowX !== 'visible' || o.overflowY !== 'visible') {
        const ar = dr.getBoundingClientRect()
        clip = { l: ar.left + dr.clientLeft, t: ar.top + dr.clientTop, r: ar.left + dr.clientLeft + dr.clientWidth, b: ar.top + dr.clientTop + dr.clientHeight, by: 'DIV[data-mobile-drawer]' }
      }
    }
    ring = { color: css, clip, alpha: c.a, contrast: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), sig,
      box: { l: r.left - grow, t: r.top - grow, r: r.right + grow, b: r.bottom + grow } }
  }
  return { id: el.id, name: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30),
    inCards: !!el.closest('[data-permission-requests]'), inDrawer: !!el.closest('[data-mobile-drawer]'),
    visible: r.width > 0 && r.height > 0, inViewport, hiddenBy, entirelyHidden: covered === pts.length, indicator, stop: stopId, ring }
})()`

export async function probe(app: Frame): Promise<Probe | null> {
  return app.evaluate(PROBE) as Promise<Probe | null>
}

/** Blurs the focus, then reads again the indicator signature of every stop met: what the control looks like without focus (2.4.7 needs a change). */
export async function attachUnfocused(app: Frame, stops: Probe[]): Promise<void> {
  await app.evaluate(`document.activeElement && document.activeElement.blur()`)
  const sigs = await app.evaluate(`(() => { const sig = ${SIG}; const out = {}
    for (const el of document.querySelectorAll('[data-e2e-stop]')) out[el.getAttribute('data-e2e-stop')] = sig(el)
    return out })()`) as Record<string, string>
  for (const s of stops) s.unfocusedSig = sigs[String(s.stop)]
}

/** Presses Tab until the cycle comes back to its first stop; returns every stop met. */
export async function tabAround(page: Page, app: Frame, max = 40): Promise<Probe[]> {
  const stops: Probe[] = []
  const key = (s: Probe) => `${s.inCards}|${s.inDrawer}|${s.name}`
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const p = await probe(app)
    assert.ok(p, `Tab ${i + 1}: the focus is on an element`)
    stops.push(p)
    if (stops.length > 2 && key(p) === key(stops[0])) break
  }
  await attachUnfocused(app, stops)
  return stops
}

export const fmt = (b: Box) => `${b.l.toFixed(1)},${b.t.toFixed(1)}..${b.r.toFixed(1)},${b.b.toFixed(1)}`

/** What is wrong with the Tab stops: out of the window, no focus indicator (2.4.7), hidden (2.4.11) or partly covered by another element (2.4.12), or outside the cycle. */
export function focusProblems(stops: Probe[], cycle: (s: Probe) => boolean = s => s.inCards || s.inDrawer): string[] {
  const problems: string[] = []
  for (const s of stops) {
    if (!s.visible || !s.inViewport) problems.push(`"${s.name}" has focus but is not inside the window`)
    if (!s.indicator || !s.ring) problems.push(`"${s.name}" has focus but no focus indicator is computed (2.4.7)`)
    else {
      if (s.ring.sig === s.unfocusedSig) problems.push(`"${s.name}" looks the same with and without focus (2.4.7): ${s.ring.sig}`)
      const c = s.ring.clip
      if (c) {
        const cut = [s.ring.box.l < c.l - 0.5 && 'left', s.ring.box.t < c.t - 0.5 && 'top', s.ring.box.r > c.r + 0.5 && 'right', s.ring.box.b > c.b + 0.5 && 'bottom'].filter(Boolean)
        if (cut.length) problems.push(`"${s.name}" focus ring is cut on its ${cut.join(', ')} side by ${c.by} (ring ${fmt(s.ring.box)}, visible area ${fmt(c)})`)
      }
      if (s.ring.alpha < 0.05) problems.push(`"${s.name}" has a focus indicator of transparent colour ${s.ring.color} (2.4.7)`)
      else if (s.ring.contrast < 3) problems.push(`"${s.name}" focus indicator ${s.ring.color} has a contrast of ${s.ring.contrast.toFixed(2)}:1 against its background, 3:1 needed (1.4.11, 2.4.13)`)
    }
    if (s.entirelyHidden) problems.push(`"${s.name}" has focus but is entirely hidden by ${s.hiddenBy} (2.4.11)`)
    else if (s.hiddenBy !== null) problems.push(`"${s.name}" has focus but is partly covered by ${s.hiddenBy} (2.4.12, project rule)`)
    if (!cycle(s)) problems.push(`Tab left the cycle for "${s.name}" (${s.id})`)
  }
  return problems
}

export const APPROVE = /^(Approve|Approuver)/i
export const DENY = /^(Deny|Refuser)/i
