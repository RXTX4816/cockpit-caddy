/**
 * Caddyfile syntax highlighting (#283) in the Caddyfile tab's viewer and editor, light and dark.
 *
 * The visual check's baselines must be generated inside the pinned Playwright image (see
 * phone-layout-workflows.spec.ts for the docker command). On the host only the colour
 * assertions run.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, dismissAdminBanner } from './fixtures';
import { writeFile, PROXY_CONF_PATH, CONF_HEADER, spawnCmd } from './helpers';

const IN_PINNED_IMAGE = process.env.PLAYWRIGHT_BROWSERS_PATH === '/ms-playwright';

const SITE = `${CONF_HEADER}

# label: Highlight demo
:19820 {
\t@api path /api/*
\theader X-Host {http.request.host}
\trespond @api "api # not a comment" 200
\trespond \`hello\`
}
`;

async function openConfFile(page: Page, theme: 'light' | 'dark') {
  await writeFile(page, PROXY_CONF_PATH, SITE);
  await spawnCmd(page, ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
  await page.reload({ waitUntil: 'networkidle' });
  await dismissAdminBanner(page);
  if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('pf-v6-theme-dark'));
  await page.getByRole('tab', { name: 'Caddyfile' }).click();
  await page.getByRole('button', { name: 'conf.d/cockpit-caddy.conf' }).click({ timeout: 10000 });
}

const colorOf = (l: Locator) => l.evaluate(el => getComputedStyle(el).color);

/** Each construct is coloured, and not like the plain text around it. */
async function expectHighlighted(view: Locator) {
  const plain = await colorOf(view.locator('.cm-content'));
  const token = (text: string) => view.locator('.cm-line span', { hasText: text }).first();
  const colors = {
    directive: await colorOf(token('respond')),
    matcher: await colorOf(token('@api')),
    placeholder: await colorOf(token('{http.request.host}')),
    string: await colorOf(token('"api # not a comment"')),
    comment: await colorOf(token('# label: Highlight demo')),
  };
  for (const c of Object.values(colors)) expect(c).not.toBe(plain);
  expect(new Set(Object.values(colors)).size).toBeGreaterThanOrEqual(4);
}

for (const theme of ['light', 'dark'] as const) {
  test(`Caddyfile viewer and editor are highlighted (${theme})`, async ({ pluginPage: page }) => {
    await dismissAdminBanner(page);
    await openConfFile(page, theme);

    const viewer = page.getByTestId('caddyfile-viewer');
    await expect(viewer.locator('.cm-content')).toContainText(':19820');
    await expectHighlighted(viewer);
    if (IN_PINNED_IMAGE) {
      await expect(viewer).toHaveScreenshot(`viewer-${theme}.png`, {
        mask: [page.getByText(/^v\d+\.\d+\.\d+/), page.getByText(/^Caddy v/)],
      });
    }

    await page.getByRole('button', { name: /^edit$/i }).click();
    const editor = page.locator('.cm-editor').first();
    await expect(editor.locator('.cm-content')).toContainText(':19820');
    await expectHighlighted(editor);
  });
}
