import type { Frame, Locator, Page } from 'playwright'

/**
 * A top bar button, unfolding More first when the bar is folded (under 1024 px, #523; 768 px in #476): the panel buttons are then
 * rendered only while More is expanded. Wider, the button is returned as is.
 */
export async function topbarButton(page: Page | Frame, name: string | RegExp): Promise<Locator> {
  const button = page.locator('header').getByRole('button', { name, exact: typeof name === 'string' })
  if (await button.count() > 0) return button
  const more = page.locator('header #topbar-more')
  if (await more.count() > 0 && await more.getAttribute('aria-expanded') === 'false') await more.click()
  return button
}
