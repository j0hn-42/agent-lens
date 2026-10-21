import type { Frame, Locator, Page } from 'playwright'

/**
 * A top bar button, opening More first when the button is behind it: since the bar holds on one line (owner request,
 * 2026-10-21) the scope, the view filters, the quota and the tools are behind More at every width, the panel buttons under
 * 1024 px and Commands from 1024 to 1279 px; behind More a control is rendered only while More is open. A button drawn in
 * the bar is returned as is.
 */
export async function topbarButton(page: Page | Frame, name: string | RegExp): Promise<Locator> {
  const button = page.locator('header').getByRole('button', { name, exact: typeof name === 'string' })
  if (await button.count() > 0) return button
  const more = page.locator('header #topbar-more')
  if (await more.count() > 0 && await more.getAttribute('aria-expanded') === 'false') await more.click()
  return button
}

/** Closes More if it is open (a filter keeps it open; its overlay would cover what the test clicks next). */
export async function closeMore(page: Page | Frame): Promise<void> {
  const more = page.locator('header #topbar-more')
  if (await more.count() > 0 && await more.getAttribute('aria-expanded') === 'true') await more.click()
}

/** Clicks a top bar button (opening More when it is behind it), then closes More again. */
export async function clickTopbarButton(page: Page | Frame, name: string | RegExp): Promise<void> {
  await (await topbarButton(page, name)).click()
  await closeMore(page)
}
