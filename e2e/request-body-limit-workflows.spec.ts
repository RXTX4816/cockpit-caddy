/**
 * Request body size limit workflows (#154).
 *
 * Proves Caddy actually enforces the configured max_size against real request bodies
 * (rejecting oversized ones with 413 before they ever reach the backend), not just that
 * the Caddyfile contains a request_body block.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { spawnCmd, startHttpBackend } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('rejects a request body over the configured limit and allows one under it', async ({ pluginPage: page }) => {
  const port = 19330;
  const targetPort = 19331;
  const backend = await startHttpBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill(String(port));
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    // Plain HTTP — this test is about the body-size gate, not TLS, so there's no reason
    // to drag the internal CA into it.
    await modal.locator('#tls').uncheck();
    // Request body limit now sits as a plain field in the main form (#146), not behind
    // an accordion toggle.
    await modal.locator('#add-proxy-request-body-max-size').fill('100');
    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('link', { name: `:${port}` })).toBeVisible({ timeout: 10000 });

    async function curlStatus(body: string): Promise<string> {
      const out = await spawnCmd(page, ['bash', '-c',
        `curl -s -o /dev/null -w '%{http_code}' -X POST --data '${body}' http://localhost:${port}/; true`,
      ]);
      return out.trim();
    }

    // The UI's proxy-list link appears as soon as the React state updates, which can be a
    // beat ahead of Caddy actually finishing the reload and binding the new listener —
    // poll briefly rather than assume the first request lands after the listener is live.
    await expect.poll(() => curlStatus('short body'), { timeout: 10000, intervals: [300, 500, 1000] }).not.toBe('000');

    // A body comfortably under the 100-byte limit reaches the backend. python's
    // http.server has no POST handler (501 Not Implemented) — that's fine, a 501 still
    // proves the request got all the way through Caddy's body-size gate to the backend,
    // which is the only thing this half of the test needs to show.
    expect(await curlStatus('short body')).toBe('501');

    // A body well over the limit must be rejected by Caddy itself (413) — the backend
    // should never see it.
    expect(await curlStatus('x'.repeat(5000))).toBe('413');
  } finally {
    await backend.stop();
  }
});
