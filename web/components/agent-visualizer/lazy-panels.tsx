'use client'

// #662: the panels the first screen does not show, each a chunk of its own, loaded the first time it has to show.
// Same names and props as the components they load, so their callers only change the module they import from.
// scripts/lazy-bundle.test.ts checks that no static import reaches those modules from an entry point.

import type { ComponentProps } from 'react'
import { lazyComponent } from './lazy-component'
import type { SettingsDialog as SettingsDialogComponent } from './settings-dialog'
import type { CommandPalette as CommandPaletteComponent } from './command-palette'
import type { ShortcutsDialog as ShortcutsDialogComponent } from './shortcuts-dialog'
import type { LegendPanel as LegendPanelComponent } from './legend-panel'
import type { GuidedTourCard as GuidedTourCardComponent } from './guided-tour-card'
import type { TourHighlight as TourHighlightComponent } from './tour-highlight'

const whenOpen = (p: { open: boolean }) => p.open

/** The three dialogs: loaded the first time they open, then kept mounted (closed, they render nothing themselves) */
export const SettingsDialog = lazyComponent<ComponentProps<typeof SettingsDialogComponent>>(
  () => import('./settings-dialog').then(m => m.SettingsDialog), { when: whenOpen })
export const CommandPalette = lazyComponent<ComponentProps<typeof CommandPaletteComponent>>(
  () => import('./command-palette').then(m => m.CommandPalette), { when: whenOpen })
export const ShortcutsDialog = lazyComponent<ComponentProps<typeof ShortcutsDialogComponent>>(
  () => import('./shortcuts-dialog').then(m => m.ShortcutsDialog), { when: whenOpen })

/** The entries of the legend: graph-legend.tsx renders it only while the legend is open */
export const LegendPanel = lazyComponent<ComponentProps<typeof LegendPanelComponent>>(
  () => import('./legend-panel').then(m => m.LegendPanel))

/** The guided tour: rendered only while a tour runs */
export const GuidedTourCard = lazyComponent<ComponentProps<typeof GuidedTourCardComponent>>(
  () => import('./guided-tour-card').then(m => m.GuidedTourCard))
export const TourHighlight = lazyComponent<ComponentProps<typeof TourHighlightComponent>>(
  () => import('./tour-highlight').then(m => m.TourHighlight))
