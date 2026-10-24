"use client"

import type { ComponentProps } from "react"
import { CommandPalette } from "./command-palette"
import { SettingsDialog } from "./settings-dialog"
import { ShortcutsDialog } from "./shortcuts-dialog"

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
