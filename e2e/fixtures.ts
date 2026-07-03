/**
 * Cockpit-caddy E2E fixtures.
 *
 * Overrides `pluginPage` to establish Cockpit admin mode before loading the
 * plugin directly.
 *
 * Flow:
 *   1. Login via `/`.
 *   2. Navigate to the Cockpit shell, which opens the Overview page in an iframe.
 *   3. Click "Turn on administrative access" inside the Overview iframe to grant
 *      admin for this polkit session.
 *   4. Navigate directly to the plugin with `?superuser=try`.  Because polkit
 *      already has a cached grant from step 3, the plugin's cockpit.file() calls
 *      are permitted without further prompts.
 */
import { test as base, expect } from '@rxtx4816/cockpit-plugin-base-react/e2e';
import type { Page } from '@playwright/test';
import { resetConfig } from './helpers';

export { expect };

export const test = base.extend<object>({
  // @ts-expect-error — Playwright supports overriding parent fixtures by name.
  pluginPage: async ({ page }: { page: Page }, use: (p: Page) => Promise<void>) => {
    const user = process.env.VM_USER ?? 'test';
    const password = process.env.VM_PASSWORD ?? 'test';
    const plugin = process.env.COCKPIT_PLUGIN ?? 'cockpit-caddy';

    await page.goto('/');
    await page.locator('#login-user-input').fill(user);
    await page.locator('#login-password-input').fill(password);
    await page.locator('#login-button').click();
    await page.locator('#login-user-input').waitFor({ state: 'hidden' });

    // Navigate to shell so the Overview iframe loads and we can click the admin button.
    await page.goto('/cockpit/@localhost/shell/index.html');
    await page.waitForLoadState('networkidle');

    // The admin button lives inside the Overview iframe, not the top-level shell page.
    const overviewFrame = page.frames().find(f => f.url().includes('/system/index.html'));
    if (overviewFrame) {
      const adminBtn = overviewFrame.getByRole('button', { name: /turn on administrative access/i });
      await adminBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await adminBtn.isVisible()) {
        await adminBtn.click();
        await adminBtn.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
      }
    }

    // Navigate directly to the plugin.  With polkit already authenticated above,
    // superuser=try succeeds and cockpit.file() writes are permitted.
    await page.goto(`/cockpit/@localhost/${plugin}/index.html?superuser=try`);
    await page.waitForLoadState('networkidle');

    // Reset managed config files to a clean slate before every test.
    await resetConfig(page);

    await use(page);
  },
});

/** Dismiss the Cockpit "Administrative access required" banner if present. */
export async function dismissAdminBanner(page: Page): Promise<void> {
  const link = page.getByRole('link', { name: /continue on my own risk/i });
  if (await link.isVisible().catch(() => false)) await link.click();
}
