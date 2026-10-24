"use client"

import type { ComponentProps } from "react"
// Each dialog is a chunk loaded the first time it opens (#662)
import { CommandPalette, SettingsDialog, ShortcutsDialog } from "./lazy-panels"

interface VisualizerDialogsProps {
  settings: ComponentProps<typeof SettingsDialog>
  palette: ComponentProps<typeof CommandPalette>
  shortcuts: ComponentProps<typeof ShortcutsDialog>
}

/** The three modal dialogs: settings, command palette (#243), keyboard shortcuts */
export function VisualizerDialogs({ settings, palette, shortcuts }: VisualizerDialogsProps) {
  return (
    <>
      <SettingsDialog {...settings} />
      <CommandPalette {...palette} />
      <ShortcutsDialog {...shortcuts} />
    </>
  )
}
