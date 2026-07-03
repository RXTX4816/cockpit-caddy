import { createPlaywrightConfig } from '@rxtx4816/cockpit-plugin-base-react/playwright.config.base';

// All tests share a single Caddy instance and conf.d files on the VM,
// so they must run sequentially to avoid cross-test interference.
export default createPlaywrightConfig('cockpit-caddy', [
  { name: 'arch',   port: 9093 },
  { name: 'debian', port: 9094 },
  { name: 'fedora', port: 9095 },
], { workers: 1 });
