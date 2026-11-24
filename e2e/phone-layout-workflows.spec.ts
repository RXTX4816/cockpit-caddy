/**
 * The main screen at phone width (#258): 400 px, below PatternFly's md breakpoint.
 *
 * The visual check's baseline must be generated inside the pinned Playwright image (font
 * rendering differs between hosts), against the running VM:
 *
 *   docker run --rm --network host -v "$PWD:/work" -w /work \
 *     mcr.microsoft.com/playwright:v1.65.1-noble \
 *     npx playwright test --project=arch e2e/phone-layout-workflows.spec.ts --update-snapshots
 *
 * Run without --update-snapshots to verify. On the host the screenshot step is skipped and
 * the rest of the spec still runs.
 */
import type { Page } from '@playwright/test';
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, readConf } from './helpers';

const PHONE = { width: 400, height: 900 };
/** The pinned image keeps its browsers here; the baseline only holds inside it. */
const IN_PINNED_IMAGE = process.env.PLAYWRIGHT_BROWSERS_PATH === '/ms-playwright';

async function openAtPhoneWidth(page: Page) {
  await page.setViewportSize(PHONE);
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function addSites(page: Page) {
  await addProxy(page, { port: 19480, target: 'localhost:3000' });
  await addProxy(page, { port: 19481, target: 'localhost:3001', host: 'app.example.com' });
  await page.reload({ waitUntil: 'networkidle' });
  await openAtPhoneWidth(page);
  await expect(page.getByRole('link', { name: ':19480' })).toBeVisible({ timeout: 15000 });
}

async function expectNoHorizontalScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(client);
}

test('phone width: compact rows, no column header, no horizontal scroll', async ({ pluginPage: page }) => {
  await openAtPhoneWidth(page);
  await addSites(page);

  await expect(page.getByText('Address', { exact: true })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Add server sits in the Add menu instead of its own button.
  await expect(page.getByRole('button', { name: /^add server$/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'More site types' }).click();
  await expect(page.getByRole('menuitem', { name: /^add server$/i })).toBeVisible();
  await page.keyboard.press('Escape');

  if (IN_PINNED_IMAGE) {
    await expect(page).toHaveScreenshot('main-400.png', {
      fullPage: true,
      // The footer carries the plugin and Caddy versions.
      mask: [page.getByText(/^v\d+\.\d+\.\d+/), page.getByText(/^Caddy v/)],
    });
  } else {
    test.info().annotations.push({ type: 'skipped', description: 'visual check runs only in the pinned Playwright image' });
  }
});

test('phone width: Restart works', async ({ pluginPage: page }) => {
  await openAtPhoneWidth(page);
  await page.getByRole('button', { name: /^restart$/i }).click();
  await expect(page.getByRole('dialog', { name: /restart caddy/i })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/caddy restarted/i)).toBeVisible({ timeout: 15000 });
  await expectNoHorizontalScroll(page);
});

test('phone width: Edit and save a site', async ({ pluginPage: page }) => {
  await openAtPhoneWidth(page);
  await addSites(page);

  const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: ':19480' }) });
  await row.getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('#edit-target-port').fill('3002');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  expect(await readConf(page)).toContain('reverse_proxy http://localhost:3002');
  await expectNoHorizontalScroll(page);
});
