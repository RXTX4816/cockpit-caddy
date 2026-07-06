/**
 * Regression: saving *any* Settings tab change (not just internal CA lifetime) used to
 * silently strip the `# label: X` comment off every TLS-enabled standalone proxy.
 *
 * Root cause: syncGlobalOptions unconditionally re-propagates the shared internal-issuer
 * cert lifetime onto every hostless TLS proxy's block on every save
 * (applyInternalLifetimeToProxyConf), regenerating those blocks via surgicallyWriteProxy.
 * That function reads `.label` off the ProxyEntry it's given — but parseProxies (used to
 * build the entries inside applyInternalLifetimeToProxyConf) never populates `.label`, since
 * that's normally merged in at the UI/hook layer from a separate `# label:` comment scan.
 * The result: real user labels vanished from the Caddyfile the moment they saved *any*
 * Settings field, even one entirely unrelated to TLS/internal-CA.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, readFile, PROXY_CONF_PATH } from './helpers';

test('saving Settings does not strip labels from existing TLS proxies', async ({ pluginPage: page }) => {
  await addProxy(page, { port: 8443, target: 'localhost:9000', tls: 'internal', label: 'My Important Service' });

  await dismissAdminBanner(page);
  await page.getByRole('tab', { name: /settings/i }).click();
  await page.getByRole('heading', { name: 'Storage' }).waitFor({ state: 'visible', timeout: 10000 });

  // Change something unrelated to TLS/internal-CA entirely, to prove the label-stripping
  // isn't specific to editing the lifetime field itself.
  const debugCheckbox = page.locator('#go-debug');
  const wasChecked = await debugCheckbox.isChecked().catch(() => false);
  await debugCheckbox.setChecked(!wasChecked);
  await page.getByRole('button', { name: /save/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });

  const conf = await readFile(page, PROXY_CONF_PATH);
  expect(conf).toContain('# label: My Important Service');

  // Cleanup: restore the checkbox so state doesn't leak into later tests.
  await page.getByRole('tab', { name: /settings/i }).click();
  await debugCheckbox.setChecked(wasChecked);
  await page.getByRole('button', { name: /save/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click().catch(() => {});
});
