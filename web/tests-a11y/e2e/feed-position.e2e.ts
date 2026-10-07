// Real-layout check for the message feed position (issue #12, D4): the REAL MessageFeedPanel pill is
// server-rendered into a page whose bar wraps onto several rows, and the REAL topbarOffsetPx (the
// function the shell uses, which publishes measured height + 20) sets --topbar-h. Only the bar's content is
// fake. No dev server needed; without chromium the tests are skipped locally (and fail in CI).
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Browser } from 'playwright'
import { MessageFeedPanel } from '../../components/agent-visualizer/message-feed-panel'
import { topbarOffsetPx } from '../../lib/chrome-utils'
import type { Agent } from '../../lib/agent-types'
import type { ConversationMessage } from '../../hooks/simulation/types'

let browser: Browser | null = null
before(async () => {
  try { browser = await chromium.launch() } catch (err) {
    if (process.env.CI) throw err
    console.warn(`feed-position e2e skipped: chromium not available (${(err as Error).message.split('\n')[0]})`)
  }
})
after(async () => { await browser?.close() })

const agent = { id: 'o', agentKey: 'o', sessionId: 's', localId: 'o', displayName: 'orchestrator', name: 'orchestrator', parentKey: null, state: 'idle', isMain: true } as unknown as Agent
const message = { id: 'a1', type: 'assistant', timestamp: 1, content: 'plan the work' } as ConversationMessage
const feedHtml = renderToStaticMarkup(
  React.createElement(MessageFeedPanel, {
    conversations: new Map([['o', [message]]]), agents: new Map([['o', agent]]), links: new Map(),
    onAgentClick: () => {}, selectedAgentId: null,
  }),
)

const VIEWPORTS: Array<[number, number, number]> = [[1600, 900, 14], [1024, 768, 9], [390, 844, 5]]

for (const [width, height, items] of VIEWPORTS) {
  test(`the real feed pill never overlaps a wrapped top bar at ${width}x${height}`, async (t) => {
    if (!browser) return t.skip('chromium not available')
    const page = await browser.newPage({ viewport: { width, height } })
    try {
      // the utility classes the pill relies on (Tailwind is not loaded here)
      await page.setContent(`<!doctype html><style>.absolute{position:absolute}</style>
        <body style="margin:0;position:relative;height:100vh">
        <header id="bar" style="position:absolute;top:12px;left:12px;right:12px;display:flex;flex-wrap:wrap;gap:8px;padding:8px 12px">
          ${Array.from({ length: items }, (_, i) => `<span style="min-width:150px;height:28px;display:inline-block">c${i}</span>`).join('')}
        </header>${feedHtml}</body>`)
      // the shell's job, with its real formula: publish measured height (wrapped rows included) + offsets
      const measured = await page.evaluate(() => document.getElementById('bar')!.getBoundingClientRect().height)
      const published = topbarOffsetPx(measured)
      await page.evaluate((px) => document.documentElement.style.setProperty('--topbar-h', `${px}px`), published)
      const { bar, pill, cssVar } = await page.evaluate(() => ({
        bar: document.getElementById('bar')!.getBoundingClientRect().toJSON(),
        pill: document.querySelector('button[aria-label^="Expand messages"]')!.getBoundingClientRect().toJSON(),
        cssVar: document.documentElement.style.getPropertyValue('--topbar-h'),
      }))
      assert.ok(bar.height > 48, `top bar should have wrapped (height ${bar.height})`)
      assert.equal(cssVar, `${published}px`)
      assert.ok(pill.top >= bar.bottom, `feed pill top ${pill.top} overlaps bar bottom ${bar.bottom}`)
    } finally {
      await page.close()
    }
  })
}
