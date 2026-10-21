// The reading guide (docs/reading-the-ui.md) is an index and one file per domain in docs/reading-the-ui/ (#612).
// Tests that check what the guide says read all of it through this helper, in the order of the index links.
// A translated surface is one bullet under "### In your language" in the file of its domain; language.md only links those sections.
import fs from 'node:fs'
import path from 'node:path'

export const READING_GUIDE_INDEX = 'docs/reading-the-ui.md'
export const READING_GUIDE_DIR = 'docs/reading-the-ui'

const REPO_ROOT = path.resolve(__dirname, '..')

/** The domain files of the guide, repository-relative, in the order the index links them (docs.test.ts checks each is linked once). */
export function readingGuideFiles(root: string = REPO_ROOT): string[] {
  const index = fs.readFileSync(path.join(root, READING_GUIDE_INDEX), 'utf8')
  return [...index.matchAll(/\]\((reading-the-ui\/[a-z0-9-]+\.md)\)/g)].map(m => `docs/${m[1]}`)
}

/** The whole guide as one text: the index, then each domain file in the order of the index, separated by a newline. */
export function readReadingGuide(root: string = REPO_ROOT): string {
  return [READING_GUIDE_INDEX, ...readingGuideFiles(root)].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n')
}
