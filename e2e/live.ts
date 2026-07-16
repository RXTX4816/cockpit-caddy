/**
 * Live-traffic assertion helpers — wrap `expect`, so kept separate from
 * helpers.ts (which stays a pure seed-data module with no test-runner deps).
 */
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { spawnCmd } from './helpers';

/** curl through Caddy and return just the HTTP status code. Never throws on
 *  connection failure — returns '000' so callers can poll for it. */
export async function curlStatus(page: Page, url: string, opts: string[] = []): Promise<string> {
  const out = await spawnCmd(page, ['bash', '-c',
    `curl -s -o /dev/null -w '%{http_code}' ${opts.join(' ')} '${url}'; true`]);
  return out.trim();
}

/**
 * Polls curlStatus until it stops returning '000' (connection refused/reset), i.e.
 * Caddy has finished binding the new/updated listener. The UI's proxy-list link can
 * appear a beat before Caddy actually finishes reloading — call this right after any
 * routing change, before asserting on the real response.
 */
export async function waitForListener(page: Page, url: string, timeoutMs = 10000): Promise<void> {
  await expect.poll(() => curlStatus(page, url), { timeout: timeoutMs, intervals: [300, 500, 1000] })
    .not.toBe('000');
}

/** Asserts caddy.service is still active — the cheapest possible "config didn't break
 *  the daemon" check, for specs that don't otherwise curl live traffic. */
export async function expectCaddyActive(page: Page): Promise<void> {
  const out = await spawnCmd(page, ['systemctl', 'is-active', 'caddy']);
  expect(out.trim()).toBe('active');
}
