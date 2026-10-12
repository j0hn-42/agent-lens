// Comportement clavier et pointeur que les correctifs jsx-a11y de #258 ne doivent pas casser :
// les gestionnaires (Échap, piège de Tab, stopPropagation, pause des toasts, navigation fléchée)
// peuvent changer d'élément porteur, mais ce que voit l'utilisateur reste identique.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { ShortcutsDialog } from '@/components/agent-visualizer/shortcuts-dialog'
import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { DetailPopup } from '@/components/agent-visualizer/shared-ui'
import { GlassContextMenu } from '@/components/agent-visualizer/glass-context-menu'
import { ToastRegion } from '@/components/agent-visualizer/toast-region'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

/** Écouteur natif sur window : reçoit-il l'événement (donc la touche a-t-elle « fui » du dialogue) ? */
function windowSpy(type: 'keydown' | 'mousedown') {
  const seen: string[] = []
  const fn = (e: Event) => { seen.push((e as KeyboardEvent).key ?? type) }
  window.addEventListener(type, fn)
  return { seen, dispose: () => window.removeEventListener(type, fn) }
}

// ─── Dialogue des raccourcis ────────────────────────────────────────────────

function shortcuts(onClose: () => void) {
  return render(
    <ShortcutsDialog open onClose={onClose} singleKeyEnabled onSingleKeyEnabledChange={() => {}} />,
  )
}

test('dialogue des raccourcis : Échap ferme, depuis le dialogue comme depuis un bouton, sans atteindre window', () => {
  let closed = 0
  const r = shortcuts(() => { closed++ })
  const dialog = r.getByRole('dialog', { name: 'Keyboard shortcuts' })
  assert.equal(document.activeElement, dialog, 'le dialogue prend le focus à l\'ouverture')
  const spy = windowSpy('keydown')
  try {
    fireEvent.keyDown(dialog, { key: 'Escape' })
    assert.equal(closed, 1)
    const close = r.getByRole('button', { name: /close/i })
    fireEvent.keyDown(close, { key: 'Escape' })
    assert.equal(closed, 2, 'Échap sur un contrôle interne remonte jusqu\'au gestionnaire')
    assert.deepEqual(spy.seen, [], 'Échap ne remonte pas jusqu\'aux raccourcis globaux')
  } finally {
    spy.dispose()
  }
})

test('dialogue des raccourcis : Tab reste piégé dans le dialogue', () => {
  const r = shortcuts(() => {})
  const dialog = r.getByRole('dialog')
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'))
  assert.ok(focusables.length >= 2)
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement, first, 'Tab sur le dernier revient au premier')
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, last, 'Maj+Tab sur le premier va au dernier')
})

test('dialogue des raccourcis : un clic sur le voile ferme, un clic dans le dialogue non, et aucun mousedown ne fuit', () => {
  let closed = 0
  const r = shortcuts(() => { closed++ })
  const dialog = r.getByRole('dialog')
  const scrim = dialog.parentElement!.closest<HTMLElement>('.fixed')!
  assert.ok(scrim, 'le voile plein écran entoure le dialogue')
  const spy = windowSpy('mousedown')
  try {
    fireEvent.mouseDown(dialog)
    assert.equal(closed, 0, 'un clic dans le dialogue ne le ferme pas')
    fireEvent.mouseDown(scrim)
    assert.equal(closed, 1, 'un clic sur le voile ferme le dialogue')
    assert.deepEqual(spy.seen, [], 'le mousedown ne remonte pas jusqu\'à la scène')
  } finally {
    spy.dispose()
  }
})

// ─── Carte de détail d'agent et popups de détail ────────────────────────────

const agent = {
  id: 'a', name: 'Agent', state: 'idle' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 0, timeAlive: 1,
}

test('carte de détail : Échap sur un bouton interne ferme la carte sans atteindre window', () => {
  let closed = 0
  const r = render(<AgentDetailCard agent={agent as never} onClose={() => { closed++ }} />)
  const dialog = r.getByRole('dialog')
  const spy = windowSpy('keydown')
  try {
    const inner = dialog.querySelector<HTMLButtonElement>('button')!
    assert.ok(inner)
    fireEvent.keyDown(inner, { key: 'Escape' })
    assert.equal(closed, 1)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    assert.equal(closed, 2)
    fireEvent.keyDown(dialog, { key: 'a' })
    assert.deepEqual(spy.seen, ['a'], 'seul Échap est retenu ; les autres touches continuent leur chemin')
  } finally {
    spy.dispose()
  }
})

test('popup de détail : Échap ferme, un clic dans la popup ne la ferme pas et ne fuit pas', async () => {
  let closed = 0
  const r = render(
    <DetailPopup position={{ x: 10, y: 10 }} width={200} estimatedHeight={100} onClose={() => { closed++ }} titleId="t">
      <h2 id="t">Détail</h2>
      <button type="button">Action</button>
    </DetailPopup>,
  )
  const dialog = r.getByRole('dialog', { name: 'Détail' })
  // useClickOutside n'écoute qu'après un court délai (le clic d'ouverture ne doit pas refermer)
  await act(async () => { await new Promise(res => setTimeout(res, 80)) })
  const keySpy = windowSpy('keydown')
  const mouseSpy = windowSpy('mousedown')
  try {
    fireEvent.mouseDown(r.getByRole('button', { name: 'Action' }))
    assert.equal(closed, 0, 'un clic dans la popup ne la ferme pas (useClickOutside)')
    assert.deepEqual(mouseSpy.seen, [])
    fireEvent.keyDown(r.getByRole('button', { name: 'Action' }), { key: 'Escape' })
    assert.equal(closed, 1)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    assert.equal(closed, 2)
    assert.deepEqual(keySpy.seen, [])
    fireEvent.mouseDown(document.body)
    assert.equal(closed, 3, 'un clic à l\'extérieur ferme toujours la popup')
  } finally {
    keySpy.dispose()
    mouseSpy.dispose()
  }
})

// ─── Menu contextuel : tabindex itinérant ───────────────────────────────────

test('menu contextuel : flèches, Origine et Fin déplacent le focus ; seul l\'élément actif a tabIndex 0', () => {
  const r = render(
    <GlassContextMenu
      position={{ x: 10, y: 10 }} onClose={() => {}}
      items={[
        { label: 'Un', onClick: () => {} },
        { label: 'Deux', onClick: () => {} },
        { label: 'Trois', onClick: () => {} },
      ]}
    />,
  )
  const items = () => r.getAllByRole('menuitem')
  const tabIndexes = () => items().map(i => i.tabIndex)
  assert.equal(document.activeElement, items()[0])
  assert.deepEqual(tabIndexes(), [0, -1, -1])
  fireEvent.keyDown(items()[0], { key: 'End' })
  assert.equal(document.activeElement, items()[2])
  assert.deepEqual(tabIndexes(), [-1, -1, 0])
  fireEvent.keyDown(items()[2], { key: 'Home' })
  assert.equal(document.activeElement, items()[0])
  fireEvent.keyDown(items()[0], { key: 'ArrowUp' })
  assert.equal(document.activeElement, items()[2], 'Haut sur le premier boucle sur le dernier')
  fireEvent.keyDown(items()[2], { key: 'ArrowDown' })
  assert.equal(document.activeElement, items()[0])
  assert.deepEqual(tabIndexes(), [0, -1, -1])
  const menu = r.getByRole('menu')
  assert.notEqual(menu.getAttribute('tabindex'), '0', 'le conteneur du menu n\'entre pas dans l\'ordre de tabulation')
})

// ─── Région des notifications : pause au survol et au focus ─────────────────

test('notifications : le survol et le focus clavier mettent les minuteurs en pause, puis les relâchent', () => {
  const log: string[] = []
  const r = render(
    <>
      <button type="button">Avant</button>
      <ToastRegion
        toasts={[{ id: 1, message: 'Agent retiré', actionLabel: 'Undo', durationMs: 5000 }]}
        onAction={() => {}} onDismiss={() => {}}
        onPause={(source, paused) => { log.push(`${source}:${paused}`) }}
      />
    </>,
  )
  const region = r.getByRole('region', { name: 'Notifications' })
  assert.equal(region.tabIndex, 0, 'la région reste atteignable au clavier')
  fireEvent.mouseEnter(region)
  fireEvent.mouseLeave(region)
  const before = r.getByRole('button', { name: 'Avant' })
  fireEvent.focus(region, { relatedTarget: before })
  const undo = r.getByRole('button', { name: /undo/i })
  fireEvent.blur(region, { relatedTarget: undo })
  fireEvent.focus(undo, { relatedTarget: region })
  fireEvent.blur(undo, { relatedTarget: before })
  assert.deepEqual(log, ['hover:true', 'hover:false', 'focus:true', 'focus:false'],
    'un déplacement interne ne relâche pas la pause ; la sortie de la région la relâche')
})
