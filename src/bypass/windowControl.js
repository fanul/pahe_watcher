import { createLogger } from '../core/logger.js';

const log = createLogger('windowControl');

/**
 * page.bringToFront() only activates a tab within an already-visible
 * window — confirmed live it does NOT restore a genuinely minimized OS
 * window (the state --start-minimized puts it in). Un-minimizing needs a
 * real window-manager call, which Playwright doesn't expose directly but
 * CDP does: Browser.getWindowForTarget + Browser.setWindowBounds with
 * windowState:"normal" un-minimizes the actual OS window this page's tab
 * lives in.
 */
export async function restoreWindow(page) {
  try {
    const client = await page.context().newCDPSession(page);
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await client.detach().catch(() => {});
  } catch (err) {
    log.warn(`Window restore via CDP failed: ${err.message}`);
  }
}

/** Counterpart to restoreWindow — puts the window back down once a human's done with it. */
export async function minimizeWindow(page) {
  try {
    if (page.isClosed()) return;
    const client = await page.context().newCDPSession(page);
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await client.detach().catch(() => {});
  } catch (err) {
    log.warn(`Window minimize via CDP failed: ${err.message}`);
  }
}
