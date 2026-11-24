import { createVitestConfig } from "@rxtx4816/cockpit-plugin-base-react/vitest.config.base";

// Runs the seed generator (sites.seed.ts) with the same setup as the unit tests, so it can use
// the plugin's own Caddyfile writers. Not part of `npm test`.
export default createVitestConfig({
  setupFiles: ["./src/test/setup.ts"],
  include: ["scripts/seed-vm/*.seed.ts"],
});
