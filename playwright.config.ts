import { createPlaywrightConfig } from '@rxtx4816/cockpit-plugin-base-react/playwright.config.base';

export default createPlaywrightConfig('cockpit-caddy', [
  { name: 'arch',   port: 9093 },
  { name: 'debian', port: 9094 },
  { name: 'fedora', port: 9095 },
]);
