import type { BurrowData } from './burrow-types'

/**
 * The burrow's pictures are PNG files (web/public/burrow/<name>.png), fetched when the view is first shown. They come,
 * like burrow-data.ts, from the pixel-art scene of Agents' Burrow (owner's own repository, reused with their consent).
 * The Next app serves them at /burrow/. The Vite bundles (VS Code webview, standalone app) copy them to burrow/
 * beside index.js and set the base from their script's own URL: the webview's document is not where its files are.
 */
let base = '/'

/** The decor, the effects, then one sprite sheet per animal of the data */
export function burrowImageNames(data: BurrowData): string[] {
  return ['decor', 'fx', ...Object.keys(data.sprites)]
}

/** Called by a bundle's entry with its script's URL (document.currentScript.src): the pictures are fetched beside it */
export function setBurrowAssetBase(scriptUrl: string): void {
  base = new URL('.', scriptUrl).href
}

export function burrowImageUrl(name: string): string {
  return `${base}burrow/${name}.png`
}
