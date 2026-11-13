// Burrow view: the name tag under an animal carries the graph's loop badge when a loop is proven for its agent. The tag
// is aria-hidden (the agent list row says the same); the badge has the agent card's words and the theme's colours.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'

import { fillTag } from '@/components/agent-visualizer/burrow-tag'

afterEach(() => { document.body.replaceChildren() })

test('a tag without a loop is the name alone', () => {
  const el = document.createElement('div')
  fillTag(el, 'alpha', null, 3)
  assert.equal(el.textContent, 'alpha')
  assert.equal(el.querySelector('[data-burrow-loop]'), null)
})

test('a proven loop adds a badge beside the name, with the words of the graph, in theme colours', () => {
  const el = document.createElement('div')
  fillTag(el, 'alpha', 'Loop observed', 3)
  const badge = el.querySelector<HTMLElement>('[data-burrow-loop]')
  assert.ok(badge)
  assert.match(badge.textContent ?? '', /Loop observed/)
  assert.match(el.textContent ?? '', /^alpha.*Loop observed$/)
  assert.match(badge.style.border, /var\(--lens-warn\)/)
  assert.match(badge.style.background, /var\(--lens-surface-raised\)/)
  assert.match(badge.style.color, /var\(--lens-ink\)/)
})

test('filling a tag again with the same content leaves its nodes alone, and the badge goes when the loop does', () => {
  const el = document.createElement('div')
  fillTag(el, 'alpha', 'Loop observed', 3)
  const badge = el.querySelector('[data-burrow-loop]')
  fillTag(el, 'alpha', 'Loop observed', 3)
  assert.equal(el.querySelector('[data-burrow-loop]'), badge, 'no node rebuilt every frame')
  fillTag(el, 'alpha', null, 3)
  assert.equal(el.querySelector('[data-burrow-loop]'), null)
  assert.equal(el.textContent, 'alpha')
  fillTag(el, 'beta', 'Boucle observée', 3)
  assert.match(el.textContent ?? '', /^beta.*Boucle observée$/)
})
