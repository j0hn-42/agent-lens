// #373: a surface covered by the message catalog never mixes the two languages. For each locale, the surfaces
// already translated (Settings in full, the canvas controls and their View panel) are rendered and every visible
// text, accessible name, tooltip and description is checked for words of the other language. Surfaces not yet
// translated (top bar, panels, palette, legend) are out of this test on purpose: see docs/reading-the-ui.md.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { setLocaleChoice } from '@/lib/locale'
import { DEFAULT_RULES } from '@/lib/notification-rules'
import { LOCALES, MESSAGES, type Locale } from '@/lib/messages'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
})

// Function words that belong to one language only. Small on purpose: a hit is a sentence of the wrong language.
const ENGLISH = new Set(['the', 'and', 'for', 'with', 'of', 'when', 'that', 'this', 'your', 'stops', 'nothing', 'each', 'are', 'is', 'was', 'there', 'already', 'hides', 'follow', 'subtitles', 'sensitive', 'seen', 'live', 'what', 'mute'])
const FRENCH = new Set(['le', 'la', 'les', 'des', 'du', 'pour', 'avec', 'et', 'une', 'sont', 'est', 'dans', 'sur', 'aux', 'que', 'qui', 'pas', 'vos', 'votre', 'cette', 'ou', 'rien', 'chaque'])

function wordsOf(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean)
}

/** Every string a person or a screen reader gets from the rendered tree. */
function surfaceStrings(root: Node): string[] {
  const out: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? '').trim()
    if (t) out.push(t)
  }
  const el = root as Element
  el.querySelectorAll('[aria-label],[title],[placeholder]').forEach(e => {
    for (const a of ['aria-label', 'title', 'placeholder']) { const v = e.getAttribute(a); if (v) out.push(v) }
  })
  return out
}

function foreignWords(locale: Locale, strings: string[]): string[] {
  const foreign = locale === 'fr' ? ENGLISH : FRENCH
  const hits: string[] = []
  for (const s of strings) for (const w of wordsOf(s)) if (foreign.has(w)) hits.push(`${w} in "${s}"`)
  return hits
}

const noop = () => {}
const settingsProps = (): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showFinished: false, onShowFinishedChange: noop,
  hideInactive: true, onHideInactiveChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  notifications: { state: 'on', onToggle: noop, rules: { ...DEFAULT_RULES, cost: true }, onRulesChange: noop },
  presentation: { active: false, onActiveChange: noop, options: { subtitles: true, mask: true, follow: true }, onOptionChange: noop },
})

for (const locale of LOCALES) {
  test(`Settings (every section, presentation included) has no word of the other language in ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<SettingsDialog {...settingsProps()} />)
    const strings = surfaceStrings(view.getByRole('dialog'))
    assert.ok(strings.length > 20, 'the dialog was rendered')
    assert.deepEqual(foreignWords(locale, strings), [])
  })

  test(`the canvas controls and their View panel have no word of the other language in ${locale}`, () => {
    const view = render(
      <CanvasControls
        teams={[]} zoomBy={noop} doZoomToFit={noop} animationsPaused={false} pausedBySystem={false}
        locale={locale} calmLayers={DEFAULT_CALM_LAYERS} onToggleCalmLayer={noop}
        neverHide={false} toolExpiryS={120} onToggleAnimationsPaused={noop} onToggleNeverHide={noop} onChangeToolExpiry={noop}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['controls.view'] }))
    const strings = surfaceStrings(document.body)
    assert.ok(strings.length > 5)
    assert.deepEqual(foreignWords(locale, strings), [])
  })
}

test('the detector does catch a sentence of the wrong language', () => {
  assert.notDeepEqual(foreignWords('fr', ['Hides prompts and paths']), [])
  assert.notDeepEqual(foreignWords('en', ['Masque les chemins']), [])
})
