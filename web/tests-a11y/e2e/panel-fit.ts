// Fit audit of a panel (#599, shared with #518): nothing leaves the window, is cut, covers another button or sticks out of the panel.
import { strict as assert } from 'node:assert'
import type { Page } from 'playwright'

// A string so the TS transpiler injects no helper into the page.
export const AUDIT = (selector: string) => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)})
  if (!root) return { missing: true }
  const vw = document.documentElement.clientWidth, vh = window.innerHeight
  const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const inside = r => r.l >= -0.5 && r.r <= vw + 0.5 && r.t >= -0.5 && r.b <= vh + 0.5
  const name = el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)
  const outside = [], cut = [], sticks = []
  const buttons = [...root.querySelectorAll('button')].filter(b => b.getClientRects().length > 0)
  for (const b of [root, ...buttons]) {
    // a button inside the scrolling message list may sit above or below the visible part: only the sides count for it
    const r0 = rect(b)
    if (b === root ? !inside(r0) : (r0.l < -0.5 || r0.r > vw + 0.5)) outside.push(name(b) + ' ' + JSON.stringify(rect(b)))
    if (b.scrollWidth > b.clientWidth + 1) cut.push(name(b) + ' scroll ' + b.scrollWidth + ' > client ' + b.clientWidth)
  }
  const rr = rect(root)
  for (const e of root.querySelectorAll('*')) {
    if (e.getClientRects().length === 0 || e.closest('.sr-only')) continue
    // a row inside a scroller of its own (the message list, a long path) may be wider: only the panel box counts
    if (rect(e).r > rr.r + 1) sticks.push(name(e) + ' ' + JSON.stringify(rect(e)))
  }
  const overlap = []
  // a row scrolled under the header is clipped by its scroller: only a button that is really drawn at its centre counts
  const drawn = buttons.filter(b => {
    const r = rect(b), hit = document.elementFromPoint((r.l + r.r) / 2, (r.t + r.b) / 2)
    return !!hit && b.contains(hit)
  })
  for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++) {
    const a = rect(drawn[i]), c = rect(drawn[j])
    if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) overlap.push(name(drawn[i]) + ' / ' + name(drawn[j]))
  }
  return { missing: false, outside, cut, overlap, sticks, docScroll: document.documentElement.scrollWidth, vw }
})()`

export interface Audit { missing: boolean; outside: string[]; cut: string[]; overlap: string[]; sticks: string[]; docScroll: number; vw: number }

export async function expectFits(page: Page, selector: string, scenario: string) {
  const a = await page.evaluate(AUDIT(selector)) as Audit
  assert.ok(!a.missing, `[${scenario}] ${selector} is drawn`)
  assert.deepEqual(a.outside, [], `[${scenario}] nothing leaves the window`)
  assert.deepEqual(a.cut, [], `[${scenario}] no text is cut`)
  assert.deepEqual(a.overlap, [], `[${scenario}] no button covers another`)
  assert.deepEqual(a.sticks, [], `[${scenario}] nothing sticks out of the panel`)
  assert.ok(a.docScroll <= a.vw, `[${scenario}] no sideways scroll (${a.docScroll} > ${a.vw})`)
}

