// #373: a surface covered by the message catalog never mixes the two languages. For each locale, the surfaces
// already translated (Settings in full, the canvas controls and their View panel) are rendered and every visible
// text, accessible name, tooltip and description must be a value of that locale's catalog (placeholders filled in)
// or an entry of an explicit allowlist (proper names, symbols). A subtree marked data-i18n-exempt (it carries its own
// lang, for instance the legend, still English) is left out. Surfaces not yet translated (top bar, panels, palette,
// legend) are out of this test on purpose: see docs/reading-the-ui.md.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { setLocaleChoice } from '@/lib/locale'
import { DEFAULT_RULES } from '@/lib/notification-rules'
import { LOCALES, MESSAGES, type Locale, type MessageKey } from '@/lib/messages'
import type { NotifyState } from '@/hooks/use-attention-alerts'

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

const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'aria-description', 'alt', 'aria-valuetext'] as const

/** Every string a person or a screen reader gets from the rendered tree, minus the subtrees marked data-i18n-exempt. */
function surfaceStrings(root: Node): string[] {
  const out: string[] = []
  const exempt = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('[data-i18n-exempt]') != null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? '').trim()
    if (t && !exempt(n)) out.push(t)
  }
  const el = root as Element
  el.querySelectorAll(ATTRIBUTES.map(a => `[${a}]`).join(',')).forEach(e => {
    if (exempt(e)) return
    for (const a of ATTRIBUTES) { const v = e.getAttribute(a); if (v) out.push(v) }
  })
  return out
}

function foreignWords(locale: Locale, strings: string[]): string[] {
  const foreign = locale === 'fr' ? ENGLISH : FRENCH
  const hits: string[] = []
  for (const s of strings) for (const w of wordsOf(s)) if (foreign.has(w)) hits.push(`${w} in "${s}"`)
  return hits
}

// Not in the catalog on purpose, the same in both languages: proper names of themes (THEME_LABELS) and symbols.
const ALLOWLIST = new Set(['Catppuccin Macchiato', 'Catppuccin Mocha', 'Catppuccin Frappe', 'Midnight', 'Graphite', 'Neon', 'Ember', 'Anthropic', '✓', '✕', '▸', '▾'])

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One regex per catalog value: a {placeholder} stands for a number or a short word. A shortcut hint " (+)" may follow. */
function catalogPatterns(locale: Locale): RegExp[] {
  return (Object.values(MESSAGES[locale]) as string[]).map(v => {
    const body = v.split(/\{\w+\}/).map(escapeRe).join('[\\p{L}\\p{N}.,]+')
    return new RegExp(`^${body}(?: \\([+\\-0]\\))?$`, 'u')
  })
}

/** The rendered strings that are neither a value of the locale's catalog nor an allowlisted name. */
function strangers(locale: Locale, strings: string[]): string[] {
  const patterns = catalogPatterns(locale)
  return strings.filter(s => !ALLOWLIST.has(s) && !patterns.some(p => p.test(s)))
}

/** The nearest declared language of an element. */
const langOf = (el: Element) => el.closest('[lang]')?.getAttribute('lang')

const noop = () => {}
const settingsProps = (state: NotifyState): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showFinished: false, onShowFinishedChange: noop,
  hideInactive: true, onHideInactiveChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  notifications: { state, onToggle: noop, rules: { ...DEFAULT_RULES, cost: true }, onRulesChange: noop },
  presentation: { active: false, onActiveChange: noop, options: { subtitles: true, mask: true, follow: true }, onOptionChange: noop },
})

const NOTIFY_STATES: NotifyState[] = ['on', 'off', 'denied', 'unsupported']

for (const locale of LOCALES) {
  test(`Settings (every section and notification state, an invalid threshold included) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    for (const state of NOTIFY_STATES) {
      const view = render(<SettingsDialog {...settingsProps(state)} />)
      const dialog = view.getByRole('dialog')
      assert.equal(langOf(dialog), locale, `the dialog declares lang=${locale}`)
      if (state === 'on') {
        fireEvent.change(view.getByLabelText(MESSAGES[locale]['settings.notify.threshold']), { target: { value: '-1' } })
        assert.ok(view.getByRole('alert'), 'the invalid threshold message is rendered')
      }
      strings.push(...surfaceStrings(dialog))
      cleanup()
    }
    for (const key of ['settings.notify.unsupported', 'settings.notify.denied', 'settings.notify.rulesPending', 'settings.notify.invalid'] as MessageKey[]) {
      assert.ok(strings.includes(MESSAGES[locale][key]), `${key} was rendered`)
    }
    assert.ok(strings.length > 20, 'the dialog was rendered')
    assert.deepEqual(foreignWords(locale, strings), [])
    assert.deepEqual(strangers(locale, strings), [])
  })

  test(`the canvas controls and their View panel speak only ${locale}`, () => {
    const view = render(
      <CanvasControls
        teams={[]} zoomBy={noop} doZoomToFit={noop} animationsPaused={false} pausedBySystem={false}
        locale={locale} calmLayers={DEFAULT_CALM_LAYERS} onToggleCalmLayer={noop}
        neverHide={false} toolExpiryS={120} onToggleAnimationsPaused={noop} onToggleNeverHide={noop} onChangeToolExpiry={noop}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['controls.view'] }))
    const panel = view.getByRole('dialog', { name: MESSAGES[locale]['controls.viewSettings'] })
    assert.equal(langOf(panel), locale, `the View panel declares lang=${locale}`)
    // An exempt subtree (the legend, still English) must say so to a screen reader with its own lang
    for (const e of Array.from(document.querySelectorAll('[data-i18n-exempt]'))) assert.equal(e.getAttribute('lang'), 'en', 'an exempt subtree declares lang=en')
    const strings = surfaceStrings(document.body)
    assert.ok(strings.length > 5)
    assert.deepEqual(foreignWords(locale, strings), [])
    assert.deepEqual(strangers(locale, strings), [])
  })
}

test('the theme tooltip names the themes as the options do', () => {
  for (const locale of LOCALES) {
    setLocaleChoice(locale)
    const view = render(<SettingsDialog {...settingsProps('on')} />)
    const select = view.getByRole('combobox', { name: MESSAGES[locale]['settings.theme'] }) as HTMLSelectElement
    const tooltip = (select.getAttribute('title') ?? '').toLowerCase()
    for (const option of Array.from(select.options)) {
      const label = (option.textContent ?? '').toLowerCase()
      const name = label.startsWith('catppuccin') ? 'catppuccin' : label
      assert.ok(tooltip.includes(name), `${locale}: the tooltip "${tooltip}" names the option "${option.textContent}"`)
    }
    cleanup()
  }
})

test('the detector does catch a sentence or a short label of the wrong language', () => {
  assert.notDeepEqual(foreignWords('fr', ['Hides prompts and paths']), [])
  assert.notDeepEqual(foreignWords('en', ['Masque les chemins']), [])
  // A short untranslated label has no function word: only the catalog check sees it
  assert.deepEqual(foreignWords('fr', ['Cost threshold (USD)']), [])
  assert.deepEqual(strangers('fr', ['Cost threshold (USD)']), ['Cost threshold (USD)'])
  assert.deepEqual(strangers('fr', ['Legend']), ['Legend'])
  assert.deepEqual(strangers('fr', [MESSAGES.fr['settings.notify.threshold'], '2 min', `${MESSAGES.fr['controls.zoomIn']} (+)`, 'Midnight']), [])
})
