import type { BurrowData } from './burrow-types'

/**
 * The burrow's pictures are PNG files (web/public/burrow/<name>.png), fetched when the view is first shown. They come,
 * like burrow-data.ts, from the pixel-art scene of Agents' Burrow (owner's own repository, reused with their consent).
 * The Next app serves them at /burrow/. The Vite bundles (VS Code webview, standalone app) copy them to burrow/
 * beside index.js and set the base from their script's own URL: the webview's document is not where its files are.
 */
let base = '/'

/** The decor, the effects, one sprite sheet per animal of the data, then the close-up picture of each animal that has one */
export function burrowImageNames(data: BurrowData): string[] {
  const glasses = Object.entries(data.sprites)
    .filter(([, m]) => m.glass)
    .map(([k]) => burrowGlassImage(k))
  return ['decor', 'fx', ...Object.keys(data.sprites), ...glasses]
}

/** The name of the close-up picture of a sprite (a name the standalone app serves: lower case, digits, hyphens) */
export function burrowGlassImage(sprite: string): string {
  return `${sprite}-glass`
}

/** Called by a bundle's entry with its script's URL (document.currentScript.src): the pictures are fetched beside it */
export function setBurrowAssetBase(scriptUrl: string): void {
  base = new URL('.', scriptUrl).href
}

export function burrowImageUrl(name: string): string {
  return `${base}burrow/${name}.png`
}
